import axios from "axios";
import { logEvent } from "./databaseService.js";
import {
  RPC_URL,
  HELIUS_API_KEY, // Make sure you have HELIUS_API_KEY in your config
  MAX_HOLDER_CONCENTRATION_PERCENT,
  MIN_LIQUIDITY_USD,
  MAX_LIQUIDITY_USD,
  MIN_MARKET_CAP_USD,
  MAX_DEV_WALLET_COUNT,
  MAX_INITIAL_DEV_SELL_PERCENT,
} from "../config.js";
import { connection } from "./solanaService.js";
import { PublicKey } from "@solana/web3.js";
import fetch from "cross-fetch";

/**
 * Fetches basic token metadata (name and symbol) from the RPC.
 * @param {string} mintAddress - The token's mint address.
 * @returns {Promise<object|null>}
 */
export async function getTokenMetadata(mintAddress) {
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "helius-test",
        method: "getAsset",
        params: { id: mintAddress },
      }),
    });
    const { result } = await response.json();
    if (result && result.content && result.content.metadata) {
      return {
        name: result.content.metadata.name,
        symbol: result.content.metadata.symbol,
      };
    }
    await logEvent("WARN", `Could not find metadata for mint: ${mintAddress}`);
    return null;
  } catch (error) {
    await logEvent(
      "ERROR",
      `Error fetching token metadata for ${mintAddress}`,
      { error }
    );
    return null;
  }
}

/**
 * Fetches the creator's address using the Helius DAS API as a reliable source.
 * @param {string} mintAddress - The token's mint address.
 * @returns {Promise<string|null>} The creator's address or null if not found.
 */
async function getCreatorFromHelius(mintAddress) {
  if (!HELIUS_API_KEY) {
    await logEvent(
      "WARN",
      "Helius API key is not configured. Cannot fetch creator.",
      { mint: mintAddress }
    );
    return null;
  }
  const heliusRpcUrl = `https://rpc.helius.xyz/?api-key=${HELIUS_API_KEY}`;
  try {
    const response = await fetch(heliusRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "helius-get-asset",
        method: "getAsset",
        params: { id: mintAddress },
      }),
    });
    const { result } = await response.json();
    if (result && result.authorities && result.authorities.length > 0) {
      const creatorAuthority = result.authorities.find(
        (auth) => auth.scope === "creator"
      );
      if (creatorAuthority && creatorAuthority.address) {
        await logEvent(
          "INFO",
          `Found creator via Helius: ${creatorAuthority.address}`,
          { mint: mintAddress }
        );
        return creatorAuthority.address;
      }
    }
    await logEvent(
      "WARN",
      `Could not find creator authority in Helius response for mint: ${mintAddress}`
    );
    return null;
  } catch (error) {
    await logEvent("ERROR", "Error fetching creator from Helius", {
      error: error.message,
      mint: mintAddress,
    });
    return null;
  }
}

/**
 * A helper function to detect if the creator sold a significant amount of tokens early on.
 * @param {string} creatorAddress - The creator's wallet address.
 * @param {string} mintAddress - The token's mint address.
 * @returns {Promise<boolean>} - True if a significant early sell is detected, false otherwise.
 */
async function detectEarlyDevSell(creatorAddress, mintAddress) {
  try {
    const creatorPubKey = new PublicKey(creatorAddress);
    const mintPubKey = new PublicKey(mintAddress);
    const creatorTokenAccounts = await connection.getParsedTokenAccountsByOwner(
      creatorPubKey,
      { mint: mintPubKey }
    );
    if (creatorTokenAccounts.value.length === 0) {
      await logEvent(
        "INFO",
        `Creator ${creatorAddress} has no token account for mint ${mintAddress}. No early sell detected.`
      );
      return false;
    }
    const initialBalance = parseInt(
      creatorTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount,
      10
    );
    if (initialBalance === 0) {
      await logEvent(
        "INFO",
        `Creator's initial balance is 0. No early sell detected.`
      );
      return false;
    }
    const signatures = await connection.getSignaturesForAddress(creatorPubKey, {
      limit: 25,
    });
    if (!signatures || signatures.length === 0) return false;
    const fiveMinutesAgo = Date.now() / 1000 - 300;
    for (const tx of signatures) {
      if (tx.blockTime < fiveMinutesAgo) continue;
      const parsedTx = await connection.getParsedTransaction(tx.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!parsedTx || !parsedTx.meta) continue;
      const preBalance = parsedTx.meta.preTokenBalances.find(
        (b) => b.owner === creatorAddress && b.mint === mintAddress
      );
      const postBalance = parsedTx.meta.postTokenBalances.find(
        (b) => b.owner === creatorAddress && b.mint === mintAddress
      );
      if (preBalance && postBalance) {
        const soldAmount =
          parseInt(preBalance.uiTokenAmount.amount, 10) -
          parseInt(postBalance.uiTokenAmount.amount, 10);
        if (soldAmount > 0) {
          const soldPercentage = (soldAmount / initialBalance) * 100;
          if (soldPercentage >= MAX_INITIAL_DEV_SELL_PERCENT) {
            await logEvent(
              "WARN",
              `Vetting failed: Creator sold ${soldPercentage.toFixed(
                2
              )}% of initial tokens early.`,
              { mint: mintAddress }
            );
            return true;
          }
        }
      }
    }
    return false;
  } catch (error) {
    await logEvent("ERROR", "Error detecting early dev sell", {
      error: error.message,
      mint: mintAddress,
      creator: creatorAddress,
    });
    return false;
  }
}

/**
 * Performs a comprehensive rug check on a token using the rugcheck.xyz API and Helius as a fallback.
 * @param {string} mintAddress - The token's mint address.
 * @returns {Promise<object|null>} - A summary object if all checks pass, otherwise null.
 */
export async function checkRug(mintAddress) {
  await logEvent(
    "INFO",
    `Starting comprehensive vetting for token: ${mintAddress}`
  );
  try {
    const url = `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`;
    const response = await axios.get(url);
    const report = response.data;

    if (!report) {
      await logEvent("ERROR", "Did not receive a report from RugCheck API", {
        mint: mintAddress,
      });
      return null;
    }

    // --- Vetting Pipeline ---
    if (report.simulation?.loss > 0) {
      await logEvent(
        "WARN",
        `Vetting failed: Simulation resulted in a loss (honeypot).`,
        { mint: mintAddress }
      );
      return null;
    }
    if (report.token?.freezeAuthority) {
      await logEvent("WARN", `Vetting failed: Token is freezable.`, {
        mint: mintAddress,
      });
      return null;
    }
    if (report.token?.mintAuthority) {
      await logEvent("WARN", `Vetting failed: Token is mintable.`, {
        mint: mintAddress,
      });
      return null;
    }
    if (report.totalMarketLiquidity < MIN_LIQUIDITY_USD) {
      await logEvent("WARN", `Vetting failed: Insufficient liquidity.`, {
        mint: mintAddress,
        liquidity: report.totalMarketLiquidity.toFixed(2),
        minRequired: MIN_LIQUIDITY_USD,
      });
      return null;
    }
    if (report.totalMarketLiquidity > MAX_LIQUIDITY_USD) {
      await logEvent("WARN", `Vetting failed: Liquidity too high.`, {
        mint: mintAddress,
        liquidity: report.totalMarketLiquidity.toFixed(2),
        maxAllowed: MAX_LIQUIDITY_USD,
      });
      return null;
    }
    const marketCap =
      report.price * (report.token.supply / 10 ** report.token.decimals);
    if (marketCap < MIN_MARKET_CAP_USD) {
      await logEvent("WARN", `Vetting failed: Market cap too low.`, {
        mint: mintAddress,
        marketCap: marketCap.toFixed(2),
        minRequired: MIN_MARKET_CAP_USD,
      });
      return null;
    }

    // Creator and insider checks
    let creatorAddress = report.creator?.address || report.creator;
    if (!creatorAddress) {
      await logEvent(
        "WARN",
        `Creator not in rugcheck report, using Helius as fallback.`,
        { mint: mintAddress }
      );
      creatorAddress = await getCreatorFromHelius(mintAddress);
    }

    if (creatorAddress) {
      await logEvent("INFO", `Creator address found: ${creatorAddress}`, {
        mint: mintAddress,
      });
      if (await detectEarlyDevSell(creatorAddress, mintAddress)) {
        return null;
      }
    } else {
      await logEvent(
        "WARN",
        `Could not perform early dev sell check. Creator address not found.`,
        { mint: mintAddress }
      );
    }

    // --- Determine Risk Level ---
    let overallRiskLevel = "DANGER";
    if (report.risks && report.risks.length > 0) {
      const riskLevels = report.risks.map((r) => r.level.toUpperCase());
      if (riskLevels.includes("DANGER")) overallRiskLevel = "DANGER";
      else if (riskLevels.includes("WARN")) overallRiskLevel = "WARNING";
    }

    const summaryForPrompt = {
      score: report.score_normalised,
      risks: report.risks || [],
      risk: { level: overallRiskLevel },
    };

    await logEvent("SUCCESS", `Vetting passed for token.`, {
      mint: mintAddress,
      risk: summaryForPrompt.risk.level,
    });
    return summaryForPrompt;
  } catch (error) {
    if (error.response) {
      await logEvent(
        "ERROR",
        `Error calling RugCheck API: Server responded with status ${error.response.status}`,
        { mint: mintAddress, data: error.response.data }
      );
    } else {
      await logEvent("ERROR", `Error during vetting process`, {
        mint: mintAddress,
        error: error.message,
        stack: error.stack,
      });
    }
    return null;
  }
}
