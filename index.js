import { Connection, PublicKey } from "@solana/web3.js";
import {
  RAYDIUM_LIQUIDITY_POOL_V4,
  RPC_URL,
  WALLET_KEYPAIR,
  MAX_PORTFOLIO_SIZE,
} from "./config.js";
import { shouldBuyToken } from "./services/geminiService.js";
import {
  buyToken,
  monitorPortfolio,
  getPortfolioSize,
} from "./services/tradeService.js";
import { getTokenMetadata, checkRug } from "./services/vettingService.js";
import {
  initDb,
  logEvent,
  hasBeenPurchased,
} from "./services/databaseService.js";
import { loadBlacklist, isBlacklisted } from "./services/blacklistService.js";
import { pumpFunEmitter, monitorPumpFun } from "./services/pumpfunService.js";
import chalk from "chalk";

const seenSignatures = new Set();
const connection = new Connection(RPC_URL, "confirmed");

/**
 * A unified function to process any new token, regardless of its source.
 * This replaces processToken and processNewLiquidityPool.
 * @param {object} tokenData - Data about the new token.
 */
async function processNewToken(tokenData) {
  try {
    const { mint, source } = tokenData;

    if (getPortfolioSize() >= MAX_PORTFOLIO_SIZE) {
      await logEvent(
        "INFO",
        `Portfolio is full (${getPortfolioSize()}/${MAX_PORTFOLIO_SIZE}). Skipping new token.`
      );
      return;
    }

    if (await hasBeenPurchased(mint)) {
      return;
    }

    const metadata = await getTokenMetadata(mint);
    if (!metadata) {
      await logEvent("WARN", `Could not fetch metadata for ${mint}. Skipping.`);
      return;
    }
    const { name, symbol } = metadata;

    if (isBlacklisted(name, symbol)) {
      await logEvent("WARN", `Skipping blacklisted token: ${name} (${symbol})`);
      return;
    }

    await logEvent(
      "INFO",
      `New token from ${source}: ${name} (${symbol}) | Mint: ${mint}`
    );

    const rugCheckReport = await checkRug(mint);
    if (!rugCheckReport) {
      await logEvent("WARN", `Vetting failed for ${name}. Skipping.`);
      return;
    }

    const decision = await shouldBuyToken(metadata, rugCheckReport);
    if (decision) {
      await buyToken(mint, rugCheckReport.risk.level);
    } else {
      await logEvent(
        "INFO",
        `Decision: PASS on ${symbol} based on AI recommendation.`
      );
    }
  } catch (error) {
    await logEvent("ERROR", "Error processing new token:", {
      tokenData,
      error: error.message,
    });
  }
}

async function monitorRaydiumPools() {
  await logEvent(
    "INFO",
    "Starting real-time log monitoring for new Raydium liquidity pools..."
  );
  connection.onLogs(
    new PublicKey(RAYDIUM_LIQUIDITY_POOL_V4),
    async ({ logs, signature }) => {
      if (
        seenSignatures.has(signature) ||
        !logs.some((log) => log.includes("initialize2"))
      )
        return;
      seenSignatures.add(signature);

      try {
        const tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (!tx || !tx.meta || !tx.meta.postTokenBalances) return;

        const newMintInfo = tx.meta.postTokenBalances.find(
          (tb) =>
            tb.mint !== "So11111111111111111111111111111111111111112" &&
            tb.owner === "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
        );

        if (newMintInfo) {
          // Pass the data to our new unified function
          processNewToken({ mint: newMintInfo.mint, source: "Raydium" });
        }
      } catch (error) {
        await logEvent(
          "ERROR",
          "Failed to get parsed transaction for Raydium",
          { signature, error }
        );
      }
    },
    "confirmed"
  );
}

async function main() {
  await initDb();
  await loadBlacklist();
  console.log(
    chalk.bold.magenta("====================================================")
  );
  console.log(
    chalk.bold.magenta(
      "     🤖 Advanced Solana AI Trading Bot Initialized 🤖     "
    )
  );
  console.log(
    chalk.bold.magenta("====================================================")
  );
  await logEvent(
    "INFO",
    `Wallet Public Key: ${WALLET_KEYPAIR.publicKey.toBase58()}`
  );

  monitorRaydiumPools();
  monitorPumpFun();

  pumpFunEmitter.on("newToken", (tokenData) => {
    processNewToken(tokenData);
  });

  // Start portfolio monitoring
  setInterval(() => {
    logEvent("INFO", "Performing scheduled portfolio check...");
    monitorPortfolio();
  }, 60000);
}

main();
