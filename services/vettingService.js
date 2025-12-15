import axios from "axios";
import { logEvent } from "./databaseService.js";
import {
  RPC_URL,
  HELIUS_API_KEY,
  MAX_HOLDER_CONCENTRATION_PERCENT,
  MIN_LIQUIDITY_USD,
  MAX_LIQUIDITY_USD,
  MIN_MARKET_CAP_USD,
  MAX_INITIAL_DEV_SELL_PERCENT,
  MIN_LP_LOCKED_PERCENT,
  MIN_POOL_AGE_SECONDS,
  MAX_TOKEN_AGE_MINUTES,
  MAX_TOP_HOLDER_PERCENT,
  REQUIRE_VERIFIED_TOKEN,
  MAX_SINGLE_HOLDER_PERCENT,
  MIN_LP_PROVIDERS,
  MIN_LIQUIDITY_AGE_SECONDS,
  MAX_BUNDLED_TX_INSTRUCTIONS,
  CHECK_CREATOR_HISTORY,
  MAX_CREATOR_RUGGED_TOKENS,
} from "../config.js";
import { connection } from "./solanaService.js";
import { PublicKey } from "@solana/web3.js";
import fetch from "cross-fetch";
import { RISK_LEVELS } from "../utils/constants.js";

// Cache for known ruggers to avoid repeated checks
const knownRuggersCache = new Map(); // walletAddress -> { isRugger: boolean, tokens: [], checkedAt: timestamp }

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
      { error: error.message }
    );
    return null;
  }
}

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
 * Check if creator is a SERIAL RUGGER by analyzing their past tokens
 *
 * IMPORTANT: Only counts as a "rug" if they dumped within 10 MINUTES of token creation
 * Selling after hours/days is normal profit-taking, not a quick rug
 *
 * NEW REQUIREMENT: Creator MUST have at least 1 previous token that survived >10 minutes
 * If creator has NO coins or ALL coins were quick-rugged, FAIL vetting
 *
 * This function:
 * 1. Gets all tokens the creator has interacted with
 * 2. For each token, finds when it was created
 * 3. Checks if creator dumped >80% within 10 min of creation
 * 4. Checks if creator has at least 1 token that survived >10 min
 * 5. Flags as serial rugger if 2+ quick rugs found OR no coins survived
 */
async function checkSerialRugger(creatorAddress, currentMint) {
  const CACHE_DURATION_MS = 5 * 60 * 1000; // Cache for 5 minutes
  const QUICK_RUG_WINDOW_SECONDS = 600; // 10 minutes - if sold within this time = quick rug
  const MIN_DUMP_PERCENT = 80; // Must sell >80% to count as rug

  // Check cache first
  const cached = knownRuggersCache.get(creatorAddress);
  if (cached && Date.now() - cached.checkedAt < CACHE_DURATION_MS) {
    if (cached.isRugger) {
      await logEvent("WARN", `Creator is KNOWN SERIAL RUGGER (cached)`, {
        creator: creatorAddress,
        previousRugs: cached.ruggedTokens?.length || 0,
      });
    }
    if (cached.noSurvivedCoins) {
      await logEvent("WARN", `Creator has NO coins that survived >10 min (cached)`, {
        creator: creatorAddress,
      });
    }
    return cached.isRugger || cached.noSurvivedCoins;
  }

  try {
    const creatorPubKey = new PublicKey(creatorAddress);

    // Get creator's recent transaction history (last 100 transactions)
    const signatures = await connection.getSignaturesForAddress(creatorPubKey, {
      limit: 100,
    });

    if (!signatures || signatures.length === 0) {
      knownRuggersCache.set(creatorAddress, { isRugger: false, checkedAt: Date.now() });
      return false;
    }

    // Find all unique tokens the creator has interacted with
    // Track: mint -> { highestBalance, totalSold, firstSellTime, tokenCreationTime }
    const tokenInteractions = new Map();

    for (const sig of signatures) {
      try {
        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx || !tx.meta) continue;

        const txTime = tx.blockTime || 0;

        // Check token balance changes
        const preBalances = tx.meta.preTokenBalances || [];
        const postBalances = tx.meta.postTokenBalances || [];

        for (const pre of preBalances) {
          if (pre.owner !== creatorAddress) continue;
          if (pre.mint === currentMint) continue; // Skip current token

          const post = postBalances.find(p => p.owner === creatorAddress && p.mint === pre.mint);
          const preAmount = parseInt(pre.uiTokenAmount?.amount || "0", 10);
          const postAmount = post ? parseInt(post.uiTokenAmount?.amount || "0", 10) : 0;

          if (preAmount > postAmount) {
            // Creator sold this token
            const soldAmount = preAmount - postAmount;

            if (!tokenInteractions.has(pre.mint)) {
              tokenInteractions.set(pre.mint, {
                mint: pre.mint,
                highestBalance: preAmount,
                totalSold: soldAmount,
                firstSellTime: txTime,
                txCount: 1,
              });
            } else {
              const existing = tokenInteractions.get(pre.mint);
              existing.totalSold += soldAmount;
              if (preAmount > existing.highestBalance) {
                existing.highestBalance = preAmount;
              }
              // Track earliest sell time
              if (txTime < existing.firstSellTime || !existing.firstSellTime) {
                existing.firstSellTime = txTime;
              }
              existing.txCount++;
            }
          }
        }
      } catch (txError) {
        continue;
      }
    }

    // Now check each token: was it a QUICK rug (dumped within 10 min of creation)?
    const quickRuggedTokens = [];
    const survivedTokens = []; // Track tokens that survived >10 minutes

    for (const [mint, data] of tokenInteractions) {
      if (data.highestBalance <= 0 || data.totalSold <= 0) continue;

      const soldPercent = (data.totalSold / data.highestBalance) * 100;

      try {
        // Get token creation time
        const mintPubKey = new PublicKey(mint);
        const tokenSigs = await connection.getSignaturesForAddress(mintPubKey, { limit: 10 });

        if (!tokenSigs || tokenSigs.length === 0) continue;

        // Oldest transaction = creation time
        const tokenCreationTime = tokenSigs[tokenSigs.length - 1].blockTime || 0;

        if (!tokenCreationTime || !data.firstSellTime) continue;

        // Check if first sell was within 10 minutes of creation
        const timeBetweenCreateAndSell = data.firstSellTime - tokenCreationTime;

        // Only check tokens where creator sold >80%
        if (soldPercent >= MIN_DUMP_PERCENT && timeBetweenCreateAndSell <= QUICK_RUG_WINDOW_SECONDS) {
          // This is a QUICK RUG - dumped within 10 min of creation!
          quickRuggedTokens.push({
            mint: mint.slice(0, 8) + "...",
            soldPercent: soldPercent.toFixed(1) + "%",
            dumpedAfterMinutes: (timeBetweenCreateAndSell / 60).toFixed(1),
          });
        } else if (timeBetweenCreateAndSell > QUICK_RUG_WINDOW_SECONDS) {
          // Token survived more than 10 minutes before creator sold
          survivedTokens.push({
            mint: mint.slice(0, 8) + "...",
            survivedMinutes: (timeBetweenCreateAndSell / 60).toFixed(1),
          });
        }
      } catch (mintErr) {
        continue;
      }
    }

    const isSerialRugger = quickRuggedTokens.length >= 2; // 2+ quick rugs = serial rugger
    const noSurvivedCoins = tokenInteractions.size > 0 && survivedTokens.length === 0; // Has coins but none survived

    // Cache the result
    knownRuggersCache.set(creatorAddress, {
      isRugger: isSerialRugger,
      noSurvivedCoins,
      ruggedTokens: quickRuggedTokens,
      survivedTokens,
      checkedAt: Date.now(),
    });

    // FAIL if creator has NO tokens that survived >10 minutes
    if (noSurvivedCoins) {
      await logEvent("WARN", `VETTING FAILED: Creator has ${tokenInteractions.size} previous token(s) but NONE survived >10 min`, {
        creator: creatorAddress.slice(0, 8) + "...",
        totalTokens: tokenInteractions.size,
        quickRugs: quickRuggedTokens.length,
      });
      return true;
    }

    // FAIL if creator has ANY previous quick-rug (even 1)
    if (quickRuggedTokens.length >= 1) {
      await logEvent("WARN", `RUGGER DETECTED! Creator quick-rugged ${quickRuggedTokens.length} token(s) within 10 min`, {
        creator: creatorAddress.slice(0, 8) + "...",
        ruggedTokens: quickRuggedTokens,
        survivedTokens,
      });
      return true;
    }

    // PASS: Creator has coins that survived AND no quick rugs
    if (survivedTokens.length > 0) {
      await logEvent("INFO", `Creator has ${survivedTokens.length} token(s) that survived >10 min`, {
        creator: creatorAddress.slice(0, 8) + "...",
        survivedTokens,
      });
    }

    return {
      passed: true,
      stats: {
        totalTokens: tokenInteractions.size,
        survivedTokens: survivedTokens.length,
        quickRugs: quickRuggedTokens.length,
        avgSurvivalMins: survivedTokens.length > 0
          ? (survivedTokens.reduce((sum, t) => sum + parseFloat(t.survivedMinutes), 0) / survivedTokens.length).toFixed(1)
          : 0,
      }
    };
  } catch (error) {
    await logEvent("ERROR", "Error checking serial rugger", {
      error: error.message,
      creator: creatorAddress,
    });
    return { passed: true, stats: null };
  }
}

/**
 * Check if TOP HOLDERS are dumping within 10 minutes of token creation
 * This catches coordinated dumps by insiders/snipers
 */
async function checkTopHoldersDumping(report, mintAddress) {
  const DUMP_THRESHOLD_PERCENT = 50; // If top holder sold > 50%

  if (!report.topHolders || report.topHolders.length === 0) {
    return { passed: true };
  }

  try {
    const mintPubKey = new PublicKey(mintAddress);

    // Get token creation time
    const tokenSignatures = await connection.getSignaturesForAddress(mintPubKey, { limit: 50 });
    if (!tokenSignatures || tokenSignatures.length === 0) {
      return { passed: true };
    }

    const oldestTx = tokenSignatures[tokenSignatures.length - 1];
    const tokenCreationTime = oldestTx.blockTime || 0;
    const tokenAgeMinutes = (Date.now() / 1000 - tokenCreationTime) / 60;

    // Only check if token is < 10 minutes old
    if (tokenAgeMinutes > 10) {
      return { passed: true, reason: "Token older than 10 minutes" };
    }

    const dumpingHolders = [];

    // Check top 5 holders (excluding LP)
    const topHolders = report.topHolders
      .filter(h => !h.isLpToken && !h.isPool)
      .slice(0, 5);

    for (const holder of topHolders) {
      if (!holder.address || holder.pct < 5) continue; // Skip small holders

      try {
        const holderPubKey = new PublicKey(holder.address);
        const holderSigs = await connection.getSignaturesForAddress(holderPubKey, { limit: 30 });

        let highestBalance = 0;
        let totalSold = 0;

        for (const sig of holderSigs) {
          if (sig.blockTime && sig.blockTime < tokenCreationTime) continue;

          try {
            const tx = await connection.getParsedTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0,
            });

            if (!tx || !tx.meta) continue;

            const pre = tx.meta.preTokenBalances?.find(
              b => b.owner === holder.address && b.mint === mintAddress
            );
            const post = tx.meta.postTokenBalances?.find(
              b => b.owner === holder.address && b.mint === mintAddress
            );

            if (pre && post) {
              const preAmt = parseInt(pre.uiTokenAmount?.amount || "0", 10);
              const postAmt = parseInt(post.uiTokenAmount?.amount || "0", 10);

              if (preAmt > highestBalance) highestBalance = preAmt;
              if (preAmt > postAmt) totalSold += (preAmt - postAmt);
            }
          } catch (txErr) {
            continue;
          }
        }

        if (highestBalance > 0) {
          const soldPercent = (totalSold / highestBalance) * 100;
          if (soldPercent >= DUMP_THRESHOLD_PERCENT) {
            dumpingHolders.push({
              address: holder.address.slice(0, 8) + "...",
              holdingPercent: holder.pct.toFixed(1) + "%",
              soldPercent: soldPercent.toFixed(1) + "%",
            });
          }
        }
      } catch (holderErr) {
        continue;
      }
    }

    if (dumpingHolders.length > 0) {
      await logEvent("WARN", `TOP HOLDERS DUMPING within 10 min!`, {
        mint: mintAddress,
        tokenAgeMinutes: tokenAgeMinutes.toFixed(1),
        dumpingHolders,
      });
      return {
        passed: false,
        reason: `${dumpingHolders.length} top holders dumping`,
        dumpingHolders,
      };
    }

    return { passed: true };
  } catch (error) {
    await logEvent("ERROR", "Error checking top holders dumping", {
      error: error.message,
      mint: mintAddress,
    });
    return { passed: true }; // Don't fail on error
  }
}

/**
 * Detect if creator dumped tokens within 10 minutes of coin creation
 *
 * Logic:
 * - If coin is < 10 minutes old AND creator has sold ANY tokens → FAIL
 * - If coin is >= 10 minutes old, use the normal threshold check
 *
 * This catches "quick rug" scammers who create, pump, and dump fast
 */
async function detectEarlyDevSell(creatorAddress, mintAddress) {
  const EARLY_WINDOW_SECONDS = 600; // 10 minutes - critical early period
  const MIN_SELL_PERCENT_TO_FAIL = parseFloat(MAX_INITIAL_DEV_SELL_PERCENT) || 10;

  try {
    const creatorPubKey = new PublicKey(creatorAddress);
    const mintPubKey = new PublicKey(mintAddress);

    // Get creator's token accounts for this mint
    const creatorTokenAccounts = await connection.getParsedTokenAccountsByOwner(
      creatorPubKey,
      { mint: mintPubKey }
    );

    // Get current balance
    let currentBalance = 0;
    if (creatorTokenAccounts.value.length > 0) {
      currentBalance = parseInt(
        creatorTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount,
        10
      );
    }

    // Fetch recent transactions to find token creation time and sells
    const signatures = await connection.getSignaturesForAddress(mintPubKey, {
      limit: 50,
    });

    if (!signatures || signatures.length === 0) {
      await logEvent("INFO", `No transactions found for token.`, { mint: mintAddress });
      return false;
    }

    // Find the oldest transaction (token creation time)
    const oldestTx = signatures[signatures.length - 1];
    const tokenCreationTime = oldestTx.blockTime || 0;
    const nowSeconds = Date.now() / 1000;
    const tokenAgeSeconds = nowSeconds - tokenCreationTime;
    const tokenAgeMinutes = tokenAgeSeconds / 60;

    const isWithinEarlyWindow = tokenAgeSeconds <= EARLY_WINDOW_SECONDS;

    await logEvent("INFO", `Token age: ${tokenAgeMinutes.toFixed(1)} minutes`, {
      mint: mintAddress,
      createdAt: tokenCreationTime ? new Date(tokenCreationTime * 1000).toISOString() : "unknown",
      isWithinEarlyWindow,
    });

    // Now check creator's transactions for sells
    const creatorSignatures = await connection.getSignaturesForAddress(creatorPubKey, {
      limit: 50,
    });

    let totalSold = 0;
    let initialBalanceEstimate = currentBalance;
    let sellTransactionsFound = 0;
    let firstSellTime = null;

    for (const tx of creatorSignatures) {
      // Only check transactions after token was created
      if (tx.blockTime && tx.blockTime < tokenCreationTime) continue;

      try {
        const parsedTx = await connection.getParsedTransaction(tx.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!parsedTx || !parsedTx.meta) continue;

        // Find token balance changes for creator
        const preBalance = parsedTx.meta.preTokenBalances?.find(
          (b) => b.owner === creatorAddress && b.mint === mintAddress
        );
        const postBalance = parsedTx.meta.postTokenBalances?.find(
          (b) => b.owner === creatorAddress && b.mint === mintAddress
        );

        if (preBalance && postBalance) {
          const preBal = parseInt(preBalance.uiTokenAmount.amount, 10);
          const postBal = parseInt(postBalance.uiTokenAmount.amount, 10);

          // Track the highest balance we've seen (estimate of initial)
          if (preBal > initialBalanceEstimate) {
            initialBalanceEstimate = preBal;
          }

          // Check if this was a sell (balance decreased)
          if (preBal > postBal) {
            const soldAmount = preBal - postBal;
            totalSold += soldAmount;
            sellTransactionsFound++;

            if (!firstSellTime) {
              firstSellTime = tx.blockTime;
            }
          }
        }
      } catch (txError) {
        continue;
      }
    }

    // Calculate sold percentage
    const soldPercentage = initialBalanceEstimate > 0
      ? (totalSold / initialBalanceEstimate) * 100
      : 0;

    // KEY LOGIC: If within 10 minutes of creation and creator sold ANY amount → FAIL
    if (isWithinEarlyWindow && totalSold > 0) {
      const timeSinceCreation = firstSellTime ? (firstSellTime - tokenCreationTime) / 60 : 0;

      await logEvent(
        "WARN",
        `Vetting FAILED: Creator sold ${soldPercentage.toFixed(2)}% within ${tokenAgeMinutes.toFixed(1)} min of creation!`,
        {
          mint: mintAddress,
          tokenAgeMinutes: tokenAgeMinutes.toFixed(1),
          soldPercentage: soldPercentage.toFixed(2) + "%",
          sellTransactions: sellTransactionsFound,
          firstSellAfterMinutes: timeSinceCreation.toFixed(1),
        }
      );
      return true; // FAIL - early dump detected
    }

    // For older tokens, use threshold-based check
    if (soldPercentage >= MIN_SELL_PERCENT_TO_FAIL) {
      await logEvent(
        "WARN",
        `Vetting FAILED: Creator sold ${soldPercentage.toFixed(2)}% (threshold: ${MIN_SELL_PERCENT_TO_FAIL}%)`,
        {
          mint: mintAddress,
          sellTransactions: sellTransactionsFound,
        }
      );
      return true; // FAIL - too much sold
    }

    // Check if creator's current balance is 0 (already fully dumped)
    if (currentBalance === 0 && initialBalanceEstimate > 0) {
      await logEvent(
        "WARN",
        `Vetting FAILED: Creator has 0 balance - already fully dumped!`,
        { mint: mintAddress }
      );
      return true; // FAIL - creator already rugged
    }

    await logEvent("INFO", `Creator sell check passed`, {
      mint: mintAddress,
      tokenAgeMinutes: tokenAgeMinutes.toFixed(1),
      creatorBalance: currentBalance.toLocaleString(),
      soldPercentage: soldPercentage.toFixed(2) + "%",
    });

    return false; // PASS - no early dump detected
  } catch (error) {
    await logEvent("ERROR", "Error detecting early dev sell", {
      error: error.message,
      mint: mintAddress,
      creator: creatorAddress,
    });
    return false; // Don't fail vetting on error
  }
}

/**
 * Check for INSIDER wallets flagged by RugCheck
 * Insiders often receive tokens through bundled transactions and dump quickly
 */
async function checkForInsiders(report, mintAddress) {
  // Check graphInsidersDetected (RugCheck's graph analysis)
  if (report.graphInsidersDetected && report.graphInsidersDetected > 0) {
    return {
      passed: false,
      reason: `${report.graphInsidersDetected} insider wallet(s) detected by graph analysis`,
      insiderCount: report.graphInsidersDetected,
    };
  }

  // Check if any top holder is flagged as insider
  if (report.topHolders && report.topHolders.length > 0) {
    const insiderHolders = report.topHolders.filter((h) => h.insider === true);
    if (insiderHolders.length > 0) {
      return {
        passed: false,
        reason: `${insiderHolders.length} top holder(s) flagged as insiders`,
        insiders: insiderHolders.map((h) => ({
          address: h.address?.slice(0, 8) + "...",
          pct: h.pct?.toFixed(2) + "%",
        })),
      };
    }
  }

  return { passed: true };
}

/**
 * Check total risk score from RugCheck
 * High scores (>10000) indicate very dangerous tokens
 */
async function checkRiskScore(report, mintAddress) {
  const MAX_ALLOWED_RISK_SCORE = 10000; // Tokens above this are too risky

  // Calculate total risk score
  let totalRiskScore = 0;
  let dangerCount = 0;

  if (report.risks && report.risks.length > 0) {
    for (const risk of report.risks) {
      totalRiskScore += risk.score || 0;
      if (risk.level === "danger" || risk.level === "DANGER") {
        dangerCount++;
      }
    }
  }

  // Fail if too many danger-level risks
  if (dangerCount >= 3) {
    return {
      passed: false,
      reason: `Too many danger risks: ${dangerCount} (max: 2)`,
      dangerCount,
      totalScore: totalRiskScore,
    };
  }

  // Fail if total risk score is too high
  if (totalRiskScore > MAX_ALLOWED_RISK_SCORE) {
    return {
      passed: false,
      reason: `Risk score too high: ${totalRiskScore} (max: ${MAX_ALLOWED_RISK_SCORE})`,
      totalScore: totalRiskScore,
    };
  }

  await logEvent("INFO", `Risk score: ${totalRiskScore} (${dangerCount} danger risks)`, {
    mint: mintAddress,
  });

  return { passed: true, totalScore: totalRiskScore, dangerCount };
}

/**
 * Check if creator still holds too much (can rug instantly)
 */
async function checkCreatorBalance(report, mintAddress) {
  const MAX_CREATOR_HOLDING_PERCENT = 30; // Creator should not hold >30%

  if (!report.creator || !report.topHolders) {
    return { passed: true };
  }

  const creatorAddress = report.creator.address || report.creator;
  if (!creatorAddress) {
    return { passed: true };
  }

  // Find creator in top holders
  const creatorHolding = report.topHolders.find(
    (h) => h.address === creatorAddress || h.owner === creatorAddress
  );

  if (creatorHolding) {
    const creatorPct = creatorHolding.pct || 0;
    if (creatorPct > MAX_CREATOR_HOLDING_PERCENT) {
      return {
        passed: false,
        reason: `Creator holds ${creatorPct.toFixed(2)}% (max: ${MAX_CREATOR_HOLDING_PERCENT}%)`,
        creatorPct,
      };
    }
  }

  return { passed: true };
}

async function checkTopHolderConcentration(report, mintAddress) {
  if (!report.topHolders || report.topHolders.length === 0) {
    return { passed: true };
  }

  const nonLpHolders = report.topHolders.filter(
    (h) => !h.isLpToken && !h.isPool
  );

  for (const holder of nonLpHolders.slice(0, 10)) {
    const holderPercent = holder.pct || 0;
    if (holderPercent > MAX_TOP_HOLDER_PERCENT) {
      return {
        passed: false,
        reason: `Top holder owns ${holderPercent.toFixed(
          2
        )}% (max: ${MAX_TOP_HOLDER_PERCENT}%)`,
        holder: holder.address,
        percent: holderPercent,
      };
    }
  }

  const top10TotalPercent = nonLpHolders
    .slice(0, 10)
    .reduce((sum, h) => sum + (h.pct || 0), 0);
  if (top10TotalPercent > 90) {
    return {
      passed: false,
      reason: `Top 10 holders own ${top10TotalPercent.toFixed(
        2
      )}% combined (max: 90%)`,
      percent: top10TotalPercent,
    };
  }

  return { passed: true, top10Percent: top10TotalPercent };
}

async function checkLpLocked(report, mintAddress) {
  const lpLockedPct = report.lpLockedPct || 0;

  if (lpLockedPct < MIN_LP_LOCKED_PERCENT) {
    return {
      passed: false,
      reason: `LP locked: ${lpLockedPct.toFixed(
        2
      )}% (min: ${MIN_LP_LOCKED_PERCENT}%)`,
      lpLockedPct,
    };
  }

  return { passed: true, lpLockedPct };
}

async function checkPoolAge(report, mintAddress) {
  if (!report.markets || report.markets.length === 0) {
    return { passed: false, reason: "No markets found" };
  }

  const now = Math.floor(Date.now() / 1000);
  let oldestPoolAge = 0;

  for (const market of report.markets) {
    if (market.createdAt) {
      const poolAge = now - market.createdAt;
      if (poolAge > oldestPoolAge) {
        oldestPoolAge = poolAge;
      }
    }
  }

  if (oldestPoolAge < MIN_POOL_AGE_SECONDS) {
    return {
      passed: false,
      reason: `Pool too new: ${oldestPoolAge}s (min: ${MIN_POOL_AGE_SECONDS}s)`,
      poolAge: oldestPoolAge,
    };
  }

  return { passed: true, poolAge: oldestPoolAge };
}

async function checkForKnownRisks(report, mintAddress) {
  const criticalRisks = [];

  if (report.risks && report.risks.length > 0) {
    for (const risk of report.risks) {
      const riskName = (risk.name || "").toLowerCase();
      const riskLevel = (risk.level || "").toUpperCase();

      if (riskName.includes("copycat") || riskName.includes("copy cat")) {
        criticalRisks.push({
          name: risk.name,
          level: riskLevel,
          description: risk.description,
        });
      }

      if (riskName.includes("low liquidity") && riskLevel === "DANGER") {
        criticalRisks.push({
          name: risk.name,
          level: riskLevel,
          description: risk.description,
        });
      }

      if (
        riskName.includes("single holder") ||
        riskName.includes("high concentration")
      ) {
        criticalRisks.push({
          name: risk.name,
          level: riskLevel,
          description: risk.description,
        });
      }

      if (riskName.includes("rug") || riskName.includes("scam")) {
        criticalRisks.push({
          name: risk.name,
          level: riskLevel,
          description: risk.description,
        });
      }

      if (riskName.includes("unlocked") && riskLevel === "DANGER") {
        criticalRisks.push({
          name: risk.name,
          level: riskLevel,
          description: risk.description,
        });
      }
    }
  }

  if (criticalRisks.length > 0) {
    return { passed: false, criticalRisks };
  }

  return { passed: true };
}

/**
 * CHECK: Single holder owns too much (> 50% by default)
 * This catches tokens where one wallet can instantly dump and crash the price
 */
async function checkSingleHolderDominance(report, mintAddress) {
  if (!report.topHolders || report.topHolders.length === 0) {
    return { passed: true };
  }

  const nonLpHolders = report.topHolders.filter(
    (h) => !h.isLpToken && !h.isPool
  );

  for (const holder of nonLpHolders.slice(0, 5)) {
    const holderPercent = holder.pct || 0;
    if (holderPercent > MAX_SINGLE_HOLDER_PERCENT) {
      return {
        passed: false,
        reason: `Single holder owns ${holderPercent.toFixed(1)}% (max: ${MAX_SINGLE_HOLDER_PERCENT}%)`,
        holder: holder.address?.slice(0, 8) + "...",
        percent: holderPercent,
      };
    }
  }

  return { passed: true };
}

/**
 * CHECK: Minimum LP providers count
 * Tokens with 0 LP providers are extremely risky - anyone can drain all liquidity
 */
async function checkLpProvidersCount(report, mintAddress) {
  const lpProviders = report.totalLPProviders || 0;

  if (lpProviders < MIN_LP_PROVIDERS) {
    return {
      passed: false,
      reason: `Only ${lpProviders} LP provider(s) (min: ${MIN_LP_PROVIDERS})`,
      lpProviders,
    };
  }

  await logEvent("INFO", `LP providers: ${lpProviders}`, { mint: mintAddress });
  return { passed: true, lpProviders };
}

/**
 * CHECK: Liquidity age - don't buy if liquidity was JUST added
 * This helps avoid tokens where creator is about to rug immediately
 */
async function checkLiquidityAge(report, mintAddress) {
  if (!report.markets || report.markets.length === 0) {
    return { passed: false, reason: "No markets found" };
  }

  const now = Math.floor(Date.now() / 1000);
  let newestPoolAge = Infinity;
  let newestPoolCreatedAt = null;

  for (const market of report.markets) {
    if (market.createdAt) {
      const poolAge = now - market.createdAt;
      if (poolAge < newestPoolAge) {
        newestPoolAge = poolAge;
        newestPoolCreatedAt = market.createdAt;
      }
    }
  }

  if (newestPoolAge < MIN_LIQUIDITY_AGE_SECONDS) {
    return {
      passed: false,
      reason: `Liquidity too fresh: ${newestPoolAge}s (min: ${MIN_LIQUIDITY_AGE_SECONDS}s)`,
      liquidityAge: newestPoolAge,
    };
  }

  await logEvent("INFO", `Liquidity age: ${newestPoolAge}s`, { mint: mintAddress });
  return { passed: true, liquidityAge: newestPoolAge };
}

/**
 * CHECK: Bundled transaction detection
 * Many rug pulls use bundled/atomic transactions with many instructions
 * to set up the rug (create token, add liquidity, distribute to insiders, etc.)
 */
async function checkBundledCreation(mintAddress) {
  try {
    const mintPubKey = new PublicKey(mintAddress);
    const signatures = await connection.getSignaturesForAddress(mintPubKey, {
      limit: 5,
    });

    if (!signatures || signatures.length === 0) {
      return { passed: true };
    }

    // Get the creation transaction (oldest one)
    const createTxSig = signatures[signatures.length - 1].signature;
    const createTx = await connection.getParsedTransaction(createTxSig, {
      maxSupportedTransactionVersion: 0,
    });

    if (!createTx) {
      return { passed: true };
    }

    // Count instructions in creation TX
    const instructionCount =
      createTx.transaction?.message?.instructions?.length || 0;

    // Also check inner instructions (more thorough)
    let innerInstructionCount = 0;
    if (createTx.meta?.innerInstructions) {
      for (const inner of createTx.meta.innerInstructions) {
        innerInstructionCount += inner.instructions?.length || 0;
      }
    }

    const totalInstructions = instructionCount + innerInstructionCount;

    if (totalInstructions > MAX_BUNDLED_TX_INSTRUCTIONS) {
      await logEvent(
        "WARN",
        `Suspicious bundled creation TX detected`,
        {
          mint: mintAddress,
          instructionCount,
          innerInstructionCount,
          totalInstructions,
          maxAllowed: MAX_BUNDLED_TX_INSTRUCTIONS,
        }
      );
      return {
        passed: false,
        reason: `Suspicious bundled creation TX (${totalInstructions} instructions, max: ${MAX_BUNDLED_TX_INSTRUCTIONS})`,
        instructionCount: totalInstructions,
      };
    }

    await logEvent("INFO", `Creation TX instructions: ${totalInstructions}`, {
      mint: mintAddress,
    });
    return { passed: true, instructionCount: totalInstructions };
  } catch (error) {
    await logEvent("WARN", "Error checking bundled creation", {
      error: error.message,
      mint: mintAddress,
    });
    return { passed: true }; // Don't fail on error
  }
}

/**
 * CHECK: Creator token history via Helius
 * Checks if the creator has deployed tokens before that got rugged or have 0 liquidity
 */
async function checkCreatorTokenHistory(creatorAddress, currentMint) {
  if (!CHECK_CREATOR_HISTORY || !creatorAddress) {
    return { passed: true };
  }

  try {
    // Use Helius DAS API to get assets created by this wallet
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "get-created-tokens",
        method: "getAssetsByCreator",
        params: {
          creatorAddress: creatorAddress,
          page: 1,
          limit: 20,
        },
      }),
    });

    const data = await response.json();

    if (!data.result?.items || data.result.items.length === 0) {
      await logEvent("INFO", `Creator has no previous tokens`, {
        creator: creatorAddress.slice(0, 8) + "...",
      });
      return { passed: true, previousTokens: 0 };
    }

    const previousTokens = data.result.items.filter(
      (item) => item.id !== currentMint
    );

    if (previousTokens.length === 0) {
      return { passed: true, previousTokens: 0 };
    }

    await logEvent("INFO", `Checking creator's ${previousTokens.length} previous token(s)...`, {
      creator: creatorAddress.slice(0, 8) + "...",
    });

    let ruggedCount = 0;
    let deadCount = 0;
    const ruggedTokens = [];

    // Check each previous token (limit to first 5 to avoid rate limits)
    for (const token of previousTokens.slice(0, 5)) {
      try {
        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 200));

        const rugReport = await axios.get(
          `https://api.rugcheck.xyz/v1/tokens/${token.id}/report`,
          { timeout: 5000 }
        );

        if (rugReport.data) {
          const isRugged = rugReport.data.rugged === true;
          const isDead = (rugReport.data.totalMarketLiquidity || 0) < 100;

          if (isRugged) {
            ruggedCount++;
            ruggedTokens.push({
              mint: token.id.slice(0, 8) + "...",
              status: "RUGGED",
            });
          } else if (isDead) {
            deadCount++;
            ruggedTokens.push({
              mint: token.id.slice(0, 8) + "...",
              status: "DEAD (no liquidity)",
            });
          }
        }
      } catch (tokenError) {
        // Skip tokens that fail to fetch
        continue;
      }
    }

    const totalBadTokens = ruggedCount + deadCount;

    if (totalBadTokens > MAX_CREATOR_RUGGED_TOKENS) {
      await logEvent(
        "WARN",
        `Creator has ${totalBadTokens} rugged/dead token(s)!`,
        {
          creator: creatorAddress.slice(0, 8) + "...",
          ruggedCount,
          deadCount,
          ruggedTokens,
        }
      );
      return {
        passed: false,
        reason: `Creator has ${totalBadTokens} rugged/dead token(s) (max: ${MAX_CREATOR_RUGGED_TOKENS})`,
        ruggedCount,
        deadCount,
        ruggedTokens,
      };
    }

    await logEvent("INFO", `Creator history check passed`, {
      creator: creatorAddress.slice(0, 8) + "...",
      previousTokens: previousTokens.length,
      ruggedCount,
      deadCount,
    });

    return {
      passed: true,
      previousTokens: previousTokens.length,
      ruggedCount,
      deadCount,
    };
  } catch (error) {
    await logEvent("WARN", "Error checking creator token history", {
      error: error.message,
      creator: creatorAddress,
    });
    return { passed: true }; // Don't fail on error
  }
}

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

    if (report.rugged) {
      await logEvent("WARN", `Vetting failed: Token already rugged.`, {
        mint: mintAddress,
      });
      return null;
    }

    // Check token age - skip coins older than MAX_TOKEN_AGE_MINUTES
    if (report.detectedAt) {
      const tokenCreatedAt = new Date(report.detectedAt);
      const tokenAgeMinutes = (Date.now() - tokenCreatedAt.getTime()) / 60000;

      if (tokenAgeMinutes > MAX_TOKEN_AGE_MINUTES) {
        await logEvent("WARN", `Vetting failed: Token too old (${tokenAgeMinutes.toFixed(1)} min > ${MAX_TOKEN_AGE_MINUTES} min max).`, {
          mint: mintAddress,
          tokenAgeMinutes: tokenAgeMinutes.toFixed(1),
          maxAgeMinutes: MAX_TOKEN_AGE_MINUTES,
          createdAt: report.detectedAt,
        });
        return null;
      }

      await logEvent("INFO", `Token age OK: ${tokenAgeMinutes.toFixed(1)} min (max: ${MAX_TOKEN_AGE_MINUTES} min)`, {
        mint: mintAddress,
      });
    }

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

    if (REQUIRE_VERIFIED_TOKEN && !report.verified) {
      await logEvent(
        "WARN",
        `Vetting failed: Token not verified on RugCheck.`,
        { mint: mintAddress }
      );
      return null;
    }

    const lpCheck = await checkLpLocked(report, mintAddress);
    if (!lpCheck.passed) {
      await logEvent("WARN", `Vetting failed: ${lpCheck.reason}`, {
        mint: mintAddress,
      });
      return null;
    }
    await logEvent("INFO", `LP locked: ${lpCheck.lpLockedPct.toFixed(2)}%`, {
      mint: mintAddress,
    });

    const holderCheck = await checkTopHolderConcentration(report, mintAddress);
    if (!holderCheck.passed) {
      await logEvent("WARN", `Vetting failed: ${holderCheck.reason}`, {
        mint: mintAddress,
      });
      return null;
    }

    // NEW CHECK: Single holder dominance (> 50%)
    const singleHolderCheck = await checkSingleHolderDominance(report, mintAddress);
    if (!singleHolderCheck.passed) {
      await logEvent("WARN", `Vetting failed: ${singleHolderCheck.reason}`, {
        mint: mintAddress,
      });
      return null;
    }

    // NEW CHECK: LP providers count (min 1)
    const lpProvidersCheck = await checkLpProvidersCount(report, mintAddress);
    if (!lpProvidersCheck.passed) {
      await logEvent("WARN", `Vetting failed: ${lpProvidersCheck.reason}`, {
        mint: mintAddress,
      });
      return null;
    }

    // NEW CHECK: Liquidity age (min 60 seconds)
    const liquidityAgeCheck = await checkLiquidityAge(report, mintAddress);
    if (!liquidityAgeCheck.passed) {
      await logEvent("WARN", `Vetting failed: ${liquidityAgeCheck.reason}`, {
        mint: mintAddress,
      });
      return null;
    }

    // CHECK: Insider wallets detected by RugCheck
    const insiderCheck = await checkForInsiders(report, mintAddress);
    if (!insiderCheck.passed) {
      await logEvent("WARN", `Vetting failed: ${insiderCheck.reason}`, {
        mint: mintAddress,
      });
      return null;
    }

    // CHECK: Total risk score (too many danger flags = skip)
    const riskScoreCheck = await checkRiskScore(report, mintAddress);
    if (!riskScoreCheck.passed) {
      await logEvent("WARN", `Vetting failed: ${riskScoreCheck.reason}`, {
        mint: mintAddress,
      });
      return null;
    }

    // CHECK: Creator holds too much (can rug instantly)
    const creatorBalanceCheck = await checkCreatorBalance(report, mintAddress);
    if (!creatorBalanceCheck.passed) {
      await logEvent("WARN", `Vetting failed: ${creatorBalanceCheck.reason}`, {
        mint: mintAddress,
      });
      return null;
    }

    const riskCheck = await checkForKnownRisks(report, mintAddress);
    if (!riskCheck.passed) {
      const riskNames = riskCheck.criticalRisks.map((r) => r.name).join(", ");
      await logEvent(
        "WARN",
        `Vetting failed: Critical risks detected - ${riskNames}`,
        { mint: mintAddress, risks: riskCheck.criticalRisks }
      );
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

    let creatorAddress = report.creator?.address || report.creator;
    let creatorStats = null; // Initialize outside the if block

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

      // CHECK 1: Is this a SERIAL RUGGER? (rugged 2+ tokens before)
      const ruggerCheck = await checkSerialRugger(creatorAddress, mintAddress);
      if (typeof ruggerCheck === 'boolean' && ruggerCheck) {
        // Old format (boolean true = fail)
        await logEvent("WARN", `Vetting FAILED: Creator is a SERIAL RUGGER!`, {
          mint: mintAddress,
          creator: creatorAddress,
        });
        return null;
      } else if (typeof ruggerCheck === 'object' && !ruggerCheck.passed) {
        // New format (object with passed: false)
        await logEvent("WARN", `Vetting FAILED: Creator is a SERIAL RUGGER!`, {
          mint: mintAddress,
          creator: creatorAddress,
        });
        return null;
      }

      // Store creator stats for telegram notification
      creatorStats = (typeof ruggerCheck === 'object' && ruggerCheck.stats) ? ruggerCheck.stats : null;

      // CHECK 2: Did creator dump THIS token within 10 min of creation?
      if (await detectEarlyDevSell(creatorAddress, mintAddress)) {
        return null;
      }

      // NEW CHECK 3: Creator token history (has creator rugged before?)
      const creatorHistoryCheck = await checkCreatorTokenHistory(creatorAddress, mintAddress);
      if (!creatorHistoryCheck.passed) {
        await logEvent("WARN", `Vetting FAILED: ${creatorHistoryCheck.reason}`, {
          mint: mintAddress,
          creator: creatorAddress,
          ruggedTokens: creatorHistoryCheck.ruggedTokens,
        });
        return null;
      }
    } else {
      await logEvent(
        "WARN",
        `Could not perform creator checks. Creator address not found.`,
        { mint: mintAddress }
      );
    }

    // CHECK 3: Are TOP HOLDERS dumping within 10 min?
    const topHoldersDumpCheck = await checkTopHoldersDumping(report, mintAddress);
    if (!topHoldersDumpCheck.passed) {
      await logEvent("WARN", `Vetting FAILED: ${topHoldersDumpCheck.reason}`, {
        mint: mintAddress,
        dumpingHolders: topHoldersDumpCheck.dumpingHolders,
      });
      return null;
    }

    let overallRiskLevel = RISK_LEVELS.DANGER;
    if (report.risks && report.risks.length > 0) {
      const riskLevels = report.risks.map((r) => r.level.toUpperCase());
      if (riskLevels.includes("DANGER")) overallRiskLevel = RISK_LEVELS.DANGER;
      else if (riskLevels.includes("WARN"))
        overallRiskLevel = RISK_LEVELS.WARNING;
      else overallRiskLevel = RISK_LEVELS.GOOD;
    }

    const summaryForPrompt = {
      score: report.score_normalised,
      risks: report.risks || [],
      risk: { level: overallRiskLevel },
      lpLockedPct: lpCheck.lpLockedPct,
      liquidity: report.totalMarketLiquidity,
      creatorAddress: creatorAddress || null, // Include creator for post-purchase monitoring
      creatorStats: creatorStats || null, // Include creator stats for Telegram notification
    };

    await logEvent("SUCCESS", `Vetting passed for token.`, {
      mint: mintAddress,
      risk: summaryForPrompt.risk.level,
      lpLocked: `${lpCheck.lpLockedPct.toFixed(2)}%`,
      liquidity: `$${report.totalMarketLiquidity.toFixed(2)}`,
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
      });
    }
    return null;
  }
}
