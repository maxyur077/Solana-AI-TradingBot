import {
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import {
  WALLET_KEYPAIR,
  SLIPPAGE_BPS,
  SOL_MINT,
  TRAILING_STOP_LOSS_PERCENT,
  TRADE_AMOUNTS,
  TAKE_PROFIT_GOOD_TIERS,
  TAKE_PROFIT_PERCENT_DANGER,
  TAKE_PROFIT_PERCENT_WARNING,
  STALE_DANGER_COIN_MINUTES,
  DEEP_LOSS_PERCENT_DANGER,
  MIN_SOL_BALANCE,
  CLOSE_ATA_DELAY_MS,
  GLOBAL_STOP_LOSS_USD,
} from "../config.js";
import {
  sendAndConfirmTransaction,
  getTokenPriceInSol,
  connection,
  getSolPriceUsd,
} from "./solanaService.js";
import {
  logEvent,
  logTrade,
  addPurchasedToken,
  updateTradeStatus,
} from "./databaseService.js";
import { addToBlacklist } from "./blacklistService.js";
import {
  sendBuyNotification,
  sendSellNotification,
} from "./telegramService.js";
import {
  startTrailingStopMonitor,
  stopTrailingStopMonitor,
  isBeingMonitored,
} from "./realtimeTrailingStopService.js";
import {
  swapOnMeteora,
  sellOnMeteora,
  findMeteoraPool,
  getMeteoraTokenPrice,
} from "./meteoraSwapService.js";
import fetch from "cross-fetch";

const portfolio = new Map();
// Track active monitors for cleanup
const activeMonitors = new Map();
let totalPnlUsd = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function getPortfolioSize() {
  return portfolio.size;
}

export function getTotalPnlUsd() {
  return totalPnlUsd;
}

export function getPortfolio() {
  return portfolio;
}

export async function buyToken(mintAddress, riskLevel, metadata, poolAddress = null, dexSource = null) {
  const tradeAmountSol = TRADE_AMOUNTS[riskLevel] || TRADE_AMOUNTS.DANGER;
  const maxRetries = 3;
  const retryDelays = [0, 3000, 5000]; // Increasing delays for Jupiter indexing

  // If this is a Meteora token, go directly to Meteora swap (skip Jupiter)
  const isMeteoraDex = dexSource && dexSource.startsWith("meteora");

  const walletBalance = await connection.getBalance(WALLET_KEYPAIR.publicKey);
  if (walletBalance / LAMPORTS_PER_SOL < tradeAmountSol + MIN_SOL_BALANCE) {
    await logEvent("ERROR", "Insufficient SOL balance.", {
      current: walletBalance / LAMPORTS_PER_SOL,
      required: tradeAmountSol + MIN_SOL_BALANCE,
    });
    return false;
  }

  await logEvent(
    "INFO",
    `Attempting to buy ${mintAddress} for ${tradeAmountSol} SOL`,
    { riskLevel, dexSource: dexSource || "jupiter" },
    totalPnlUsd
  );

  // If Meteora DEX, use Meteora directly (skip Jupiter entirely)
  if (isMeteoraDex) {
    await logEvent("INFO", `Using Meteora direct swap for ${dexSource} token...`);
    try {
      const meteoraResult = await swapOnMeteora(mintAddress, tradeAmountSol, poolAddress);

      if (meteoraResult) {
        const tokenAta = await getAssociatedTokenAddress(
          new PublicKey(mintAddress),
          WALLET_KEYPAIR.publicKey
        );

        let tokenBalance = "0";
        try {
          const balanceResponse = await connection.getTokenAccountBalance(tokenAta);
          tokenBalance = balanceResponse.value.amount;
        } catch (balanceError) {
          await logEvent("WARN", "Could not fetch token balance after Meteora swap");
        }

        // Calculate price from trade amount and tokens received
        let purchasePrice = 0;
        if (parseInt(tokenBalance) > 0) {
          purchasePrice = tradeAmountSol / (parseInt(tokenBalance) / 1e9);
        }
        const finalPrice = purchasePrice > 0 ? purchasePrice : tradeAmountSol;

        portfolio.set(mintAddress, {
          purchasePrice: finalPrice,
          amount: tokenBalance,
          tradeAmountSol,
          riskLevel,
          profitTakenLevels: [],
          purchaseTimestamp: Date.now(),
          highestPriceSeen: finalPrice,
          buySignature: meteoraResult.signature,
          dexSource: "meteora", // Track that this was bought on Meteora
        });
        await addPurchasedToken(mintAddress);
        await logTrade(
          "BUY",
          mintAddress,
          tradeAmountSol,
          finalPrice,
          meteoraResult.fee,
          meteoraResult.signature,
          totalPnlUsd
        );
        await sendBuyNotification(metadata, tradeAmountSol, meteoraResult.signature);

        const monitor = startTrailingStopMonitor(
          mintAddress,
          finalPrice,
          riskLevel,
          async (mint, currentPrice, reason) => {
            await logEvent(
              "WARN",
              `Real-time ${reason} triggered for ${mint}. Executing sell.`,
              { currentPrice, reason },
              totalPnlUsd
            );
            await sellToken(mint, 100);
          },
          "meteora" // Pass dexSource for correct pricing
        );
        activeMonitors.set(mintAddress, monitor);

        await addToBlacklist(metadata.name, metadata.symbol);
        await logEvent("SUCCESS", `Bought ${mintAddress} via Meteora!`);
        return true;
      } else {
        await logEvent("ERROR", `Meteora swap failed for ${mintAddress}`);
        return false;
      }
    } catch (meteoraError) {
      await logEvent("ERROR", `Meteora buy failed`, { error: meteoraError.message });
      return false;
    }
  }

  // Retry loop for Jupiter quote/swap (for non-Meteora tokens)
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        await logEvent("INFO", `Retry attempt ${attempt + 1}/${maxRetries} for ${mintAddress}...`);
        await sleep(retryDelays[attempt]);
      }

      const amountInLamports = Math.round(tradeAmountSol * LAMPORTS_PER_SOL);
      const quoteResponse = await (
        await fetch(
          `https://api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${mintAddress}&amount=${amountInLamports}&slippageBps=${SLIPPAGE_BPS}`
        )
      ).json();

      // Check if quote was successful
      if (!quoteResponse || quoteResponse.error || !quoteResponse.outAmount) {
        const errorMsg = quoteResponse?.error || "No route found";
        if (attempt < maxRetries - 1) {
          await logEvent("WARN", `Jupiter quote failed (attempt ${attempt + 1}): ${errorMsg}. Retrying...`);
          continue;
        }
        throw new Error(`Jupiter quote failed: ${errorMsg}`);
      }

      const { swapTransaction } = await (
        await fetch("https://api.jup.ag/swap/v1/swap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quoteResponse,
            userPublicKey: WALLET_KEYPAIR.publicKey.toString(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: "auto",
          }),
        })
      ).json();

      if (!swapTransaction) {
        if (attempt < maxRetries - 1) {
          await logEvent("WARN", `Jupiter swap failed (attempt ${attempt + 1}). Retrying...`);
          continue;
        }
        throw new Error("Failed to get swap transaction from Jupiter API.");
      }

      const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

      const latestBlockhash = await connection.getLatestBlockhash();
      const txResult = await sendAndConfirmTransaction(
        transaction,
        latestBlockhash
      );

      if (txResult) {
        const purchasePrice = await getTokenPriceInSol(mintAddress);
        if (purchasePrice > 0) {
          const tokenAta = await getAssociatedTokenAddress(
            new PublicKey(mintAddress),
            WALLET_KEYPAIR.publicKey
          );
          const balanceResponse = await connection.getTokenAccountBalance(
            tokenAta
          );

          portfolio.set(mintAddress, {
            purchasePrice,
            amount: balanceResponse.value.amount,
            tradeAmountSol,
            riskLevel,
            profitTakenLevels: [],
            purchaseTimestamp: Date.now(),
            highestPriceSeen: purchasePrice,
            buySignature: txResult.signature,
          });
          await addPurchasedToken(mintAddress);
          await logTrade(
            "BUY",
            mintAddress,
            tradeAmountSol,
            purchasePrice,
            txResult.fee,
            txResult.signature,
            totalPnlUsd
          );
          await sendBuyNotification(metadata, tradeAmountSol, txResult.signature);

          // Start real-time trailing stop-loss monitoring
          const monitor = startTrailingStopMonitor(
            mintAddress,
            purchasePrice,
            riskLevel,
            async (mint, currentPrice, reason) => {
              await logEvent(
                "WARN",
                `Real-time ${reason} triggered for ${mint}. Executing sell.`,
                { currentPrice, reason },
                totalPnlUsd
              );
              await sellToken(mint, 100);
            }
          );
          activeMonitors.set(mintAddress, monitor);

          await addToBlacklist(metadata.name, metadata.symbol);
          return true;
        }
      }
      return false;
    } catch (error) {
      // If this is the last retry, try Meteora direct swap as fallback
      if (attempt === maxRetries - 1) {
        await logEvent(
          "WARN",
          `Jupiter failed after ${maxRetries} attempts. Trying Meteora direct swap...`,
          { error: error.message },
          totalPnlUsd
        );

        // Try Meteora direct swap as fallback
        try {
          // Pass poolAddress if we have it from detection
          const meteoraPool = await findMeteoraPool(mintAddress, poolAddress);
          if (meteoraPool) {
            await logEvent("INFO", "Found Meteora pool, attempting direct swap...", {
              poolAddress: meteoraPool.poolAddress.toString()
            });
            const meteoraResult = await swapOnMeteora(mintAddress, tradeAmountSol, poolAddress);

            if (meteoraResult) {
              // Success via Meteora!
              const tokenAta = await getAssociatedTokenAddress(
                new PublicKey(mintAddress),
                WALLET_KEYPAIR.publicKey
              );

              // Get token balance
              let tokenBalance = "0";
              try {
                const balanceResponse = await connection.getTokenAccountBalance(tokenAta);
                tokenBalance = balanceResponse.value.amount;
              } catch (balanceError) {
                await logEvent("WARN", "Could not fetch token balance after Meteora swap", {
                  error: balanceError.message
                });
              }

              // Try to get price, use fallback if API fails
              let purchasePrice = await getTokenPriceInSol(mintAddress);
              if (purchasePrice <= 0 && parseInt(tokenBalance) > 0) {
                // Fallback: calculate price from trade amount and tokens received
                purchasePrice = tradeAmountSol / (parseInt(tokenBalance) / 1e9);
                await logEvent("INFO", "Using calculated price from swap", {
                  calculatedPrice: purchasePrice
                });
              }

              // Add to portfolio even if price is uncertain
              const finalPrice = purchasePrice > 0 ? purchasePrice : tradeAmountSol; // Last resort fallback

              portfolio.set(mintAddress, {
                purchasePrice: finalPrice,
                amount: tokenBalance,
                tradeAmountSol,
                riskLevel,
                profitTakenLevels: [],
                purchaseTimestamp: Date.now(),
                highestPriceSeen: finalPrice,
                buySignature: meteoraResult.signature,
              });
              await addPurchasedToken(mintAddress);
              await logTrade(
                "BUY",
                mintAddress,
                tradeAmountSol,
                finalPrice,
                meteoraResult.fee,
                meteoraResult.signature,
                totalPnlUsd
              );
              await sendBuyNotification(metadata, tradeAmountSol, meteoraResult.signature);

              const monitor = startTrailingStopMonitor(
                mintAddress,
                finalPrice,
                riskLevel,
                async (mint, currentPrice, reason) => {
                  await logEvent(
                    "WARN",
                    `Real-time ${reason} triggered for ${mint}. Executing sell.`,
                    { currentPrice, reason },
                    totalPnlUsd
                  );
                  await sellToken(mint, 100);
                },
                "meteora" // Pass dexSource for correct pricing
              );
              activeMonitors.set(mintAddress, monitor);

              await addToBlacklist(metadata.name, metadata.symbol);
              await logEvent("SUCCESS", `Bought ${mintAddress} via Meteora direct swap!`);
              return true;
            }
          }
        } catch (meteoraError) {
          await logEvent("ERROR", "Meteora fallback also failed", {
            error: meteoraError.message,
          });
        }

        await logEvent(
          "ERROR",
          `Error buying token ${mintAddress} - all methods failed`,
          { error: error.message },
          totalPnlUsd
        );
        return false;
      }
      // Otherwise continue to next retry
      await logEvent("WARN", `Buy attempt ${attempt + 1} failed: ${error.message}. Retrying...`);
    }
  }
  return false;
}

export async function sellToken(mintAddress, sellPercentage) {
  const maxRetries = 3;
  const retryDelay = 5000;
  const position = portfolio.get(mintAddress);
  if (!position) return false;

  // Check if this token was bought on Meteora - if so, sell on Meteora directly
  const isMeteoraDex = position.dexSource === "meteora";

  // Get on-chain balance first
  const tokenAta = await getAssociatedTokenAddress(
    new PublicKey(mintAddress),
    WALLET_KEYPAIR.publicKey
  );
  let onChainBalance;
  try {
    const balanceResponse = await connection.getTokenAccountBalance(tokenAta);
    onChainBalance = parseInt(balanceResponse.value.amount, 10);
  } catch {
    onChainBalance = 0;
  }

  if (isNaN(onChainBalance) || onChainBalance === 0) {
    await logEvent(
      "WARN",
      `On-chain balance for ${mintAddress} is zero. Removing from portfolio.`,
      null,
      totalPnlUsd
    );
    portfolio.delete(mintAddress);
    await updateTradeStatus(position.buySignature, "SOLD");
    return false;
  }

  const amountToSell = Math.round((onChainBalance * sellPercentage) / 100);
  if (amountToSell <= 0) return false;

  // If Meteora token, sell directly on Meteora (skip Jupiter entirely)
  if (isMeteoraDex) {
    await logEvent(
      "INFO",
      `Selling ${sellPercentage}% of ${mintAddress} via Meteora (original DEX)`,
      null,
      totalPnlUsd
    );

    try {
      const meteoraResult = await sellOnMeteora(mintAddress, amountToSell.toString());

      if (meteoraResult) {
        const sellPrice = position.purchasePrice || 0;
        const receivedSol = meteoraResult.solReceived || 0;
        const initialInvestment = position.tradeAmountSol * (sellPercentage / 100);
        const profitInSol = receivedSol - initialInvestment;
        const solPrice = await getSolPriceUsd();
        let profitUsd = 0;
        if (solPrice > 0) {
          profitUsd = profitInSol * solPrice;
          totalPnlUsd += profitUsd;
        }

        await logTrade(
          "SELL",
          mintAddress,
          receivedSol,
          sellPrice,
          meteoraResult.fee,
          meteoraResult.signature,
          totalPnlUsd
        );
        await sendSellNotification(
          mintAddress,
          receivedSol,
          profitUsd,
          totalPnlUsd,
          meteoraResult.signature
        );

        if (sellPercentage === 100) {
          stopTrailingStopMonitor(mintAddress);
          activeMonitors.delete(mintAddress);
          portfolio.delete(mintAddress);
          await updateTradeStatus(position.buySignature, "SOLD");
          await closeTokenAccount(mintAddress);
        } else {
          position.amount = (onChainBalance - amountToSell).toString();
        }

        await logEvent("SUCCESS", `Sold ${mintAddress} via Meteora!`, {
          solReceived: receivedSol,
          profitUsd: profitUsd.toFixed(4)
        });
        return true;
      } else {
        await logEvent("ERROR", `Meteora sell failed for ${mintAddress}`);
        await updateTradeStatus(position.buySignature, "SELL_FAILED");
        return false;
      }
    } catch (meteoraError) {
      await logEvent(
        "ERROR",
        `Meteora sell failed`,
        { error: meteoraError.message },
        totalPnlUsd
      );
      await updateTradeStatus(position.buySignature, "SELL_FAILED");
      return false;
    }
  }

  // Jupiter sell for non-Meteora tokens
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await logEvent(
      "INFO",
      `Attempt ${attempt}/${maxRetries} to sell ${sellPercentage}% of ${mintAddress} via Jupiter`,
      null,
      totalPnlUsd
    );
    try {
      const quoteResponse = await (
        await fetch(
          `https://api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amountToSell}&slippageBps=${SLIPPAGE_BPS}`
        )
      ).json();
      if (!quoteResponse || quoteResponse.error)
        throw new Error(
          `Failed to get quote: ${quoteResponse?.error || "No quote response"}`
        );

      const { swapTransaction } = await (
        await fetch("https://api.jup.ag/swap/v1/swap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quoteResponse,
            userPublicKey: WALLET_KEYPAIR.publicKey.toString(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: "auto",
          }),
        })
      ).json();
      if (!swapTransaction)
        throw new Error("Failed to get swap transaction from Jupiter.");

      const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      const latestBlockhash = await connection.getLatestBlockhash();
      const txResult = await sendAndConfirmTransaction(
        transaction,
        latestBlockhash
      );

      if (txResult) {
        const sellPrice =
          (await getTokenPriceInSol(mintAddress)) ||
          position.purchasePrice ||
          0;
        const receivedSol =
          parseInt(quoteResponse.outAmount, 10) / LAMPORTS_PER_SOL;
        const initialInvestment =
          position.tradeAmountSol * (sellPercentage / 100);
        const profitInSol = receivedSol - initialInvestment;
        const solPrice = await getSolPriceUsd();
        let profitUsd = 0;
        if (solPrice > 0) {
          profitUsd = profitInSol * solPrice;
          totalPnlUsd += profitUsd;
        }

        await logTrade(
          "SELL",
          mintAddress,
          receivedSol,
          sellPrice,
          txResult.fee,
          txResult.signature,
          totalPnlUsd
        );
        await sendSellNotification(
          mintAddress,
          receivedSol,
          profitUsd,
          totalPnlUsd,
          txResult.signature
        );

        if (sellPercentage === 100) {
          stopTrailingStopMonitor(mintAddress);
          activeMonitors.delete(mintAddress);
          portfolio.delete(mintAddress);
          await updateTradeStatus(position.buySignature, "SOLD");
          await closeTokenAccount(mintAddress);
        } else {
          position.amount = (onChainBalance - amountToSell).toString();
        }
        return true;
      }
    } catch (error) {
      await logEvent(
        "ERROR",
        `Error on Jupiter sell attempt ${attempt}`,
        { error: error.message },
        totalPnlUsd
      );
    }
    if (attempt < maxRetries) await sleep(retryDelay);
  }

  // Jupiter failed - try Meteora as fallback
  await logEvent(
    "WARN",
    `Jupiter sell failed. Trying Meteora as fallback...`,
    null,
    totalPnlUsd
  );

  try {
    const meteoraResult = await sellOnMeteora(mintAddress, amountToSell.toString());

    if (meteoraResult) {
      const sellPrice = position.purchasePrice || 0;
      const receivedSol = meteoraResult.solReceived || 0;
      const initialInvestment = position.tradeAmountSol * (sellPercentage / 100);
      const profitInSol = receivedSol - initialInvestment;
      const solPrice = await getSolPriceUsd();
      let profitUsd = 0;
      if (solPrice > 0) {
        profitUsd = profitInSol * solPrice;
        totalPnlUsd += profitUsd;
      }

      await logTrade(
        "SELL",
        mintAddress,
        receivedSol,
        sellPrice,
        meteoraResult.fee,
        meteoraResult.signature,
        totalPnlUsd
      );
      await sendSellNotification(
        mintAddress,
        receivedSol,
        profitUsd,
        totalPnlUsd,
        meteoraResult.signature
      );

      if (sellPercentage === 100) {
        stopTrailingStopMonitor(mintAddress);
        activeMonitors.delete(mintAddress);
        portfolio.delete(mintAddress);
        await updateTradeStatus(position.buySignature, "SOLD");
        await closeTokenAccount(mintAddress);
      } else {
        position.amount = (onChainBalance - amountToSell).toString();
      }

      await logEvent("SUCCESS", `Sold ${mintAddress} via Meteora fallback!`, {
        solReceived: receivedSol
      });
      return true;
    }
  } catch (meteoraError) {
    await logEvent(
      "ERROR",
      `Meteora fallback also failed`,
      { error: meteoraError.message },
      totalPnlUsd
    );
  }

  await logEvent(
    "ERROR",
    `Failed to sell ${mintAddress} after all attempts (Jupiter + Meteora).`,
    null,
    totalPnlUsd
  );
  await updateTradeStatus(position.buySignature, "SELL_FAILED");
  return false;
}

async function closeTokenAccount(mintAddress) {
  await sleep(CLOSE_ATA_DELAY_MS);
  await logEvent(
    "INFO",
    `Attempting to close ATA for ${mintAddress}`,
    null,
    totalPnlUsd
  );

  for (let i = 0; i < 3; i++) {
    try {
      const tokenAta = await getAssociatedTokenAddress(
        new PublicKey(mintAddress),
        WALLET_KEYPAIR.publicKey
      );
      const closeInstruction = createCloseAccountInstruction(
        tokenAta,
        WALLET_KEYPAIR.publicKey,
        WALLET_KEYPAIR.publicKey
      );
      const latestBlockhash = await connection.getLatestBlockhash();
      const message = new TransactionMessage({
        payerKey: WALLET_KEYPAIR.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [closeInstruction],
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      const txResult = await sendAndConfirmTransaction(tx, latestBlockhash);
      if (txResult) {
        await logEvent(
          "SUCCESS",
          `Successfully closed ATA for ${mintAddress}.`
        );
        return;
      }
    } catch (error) {
      await logEvent(
        "WARN",
        `Attempt ${i + 1} to close ATA for ${mintAddress} failed.`,
        { error: error.message },
        totalPnlUsd
      );
      await sleep(2000);
    }
  }
  await logEvent(
    "ERROR",
    `Failed to close ATA for ${mintAddress} after multiple retries.`
  );
}

async function handleGoodRisk(position, pnlPercentage, mintAddress) {
  const { TP1, TP2, TP3 } = TAKE_PROFIT_GOOD_TIERS;
  if (
    pnlPercentage >= TP3.PROFIT_PERCENT &&
    !position.profitTakenLevels.includes(3)
  ) {
    await logEvent(
      "SUCCESS",
      `TP (GOOD, ${TP3.PROFIT_PERCENT}%) triggered. Selling ${TP3.SELL_PERCENT}%.`,
      null,
      totalPnlUsd
    );
    await sellToken(mintAddress, TP3.SELL_PERCENT);
  } else if (
    pnlPercentage >= TP2.PROFIT_PERCENT &&
    !position.profitTakenLevels.includes(2)
  ) {
    await logEvent(
      "SUCCESS",
      `TP (GOOD, ${TP2.PROFIT_PERCENT}%) triggered. Selling ${TP2.SELL_PERCENT}%.`,
      null,
      totalPnlUsd
    );
    position.profitTakenLevels.push(2);
    await sellToken(mintAddress, TP2.SELL_PERCENT);
  } else if (
    pnlPercentage >= TP1.PROFIT_PERCENT &&
    !position.profitTakenLevels.includes(1)
  ) {
    await logEvent(
      "SUCCESS",
      `TP (GOOD, ${TP1.PROFIT_PERCENT}%) triggered. Selling ${TP1.SELL_PERCENT}%.`,
      null,
      totalPnlUsd
    );
    position.profitTakenLevels.push(1);
    await sellToken(mintAddress, TP1.SELL_PERCENT);
  }
}

async function handleWarningRisk(pnlPercentage, mintAddress) {
  if (pnlPercentage >= TAKE_PROFIT_PERCENT_WARNING) {
    await logEvent(
      "SUCCESS",
      `TP (WARNING, ${TAKE_PROFIT_PERCENT_WARNING}%) triggered. Selling 100%.`,
      null,
      totalPnlUsd
    );
    await sellToken(mintAddress, 100);
  }
}

async function handleDangerRisk(pnlPercentage, mintAddress) {
  if (pnlPercentage >= TAKE_PROFIT_PERCENT_DANGER) {
    await logEvent(
      "SUCCESS",
      `TP (DANGER, ${TAKE_PROFIT_PERCENT_DANGER}%) triggered. Selling 100%.`,
      null,
      totalPnlUsd
    );
    await sellToken(mintAddress, 100);
  }
}

export async function monitorPortfolio() {
  if (portfolio.size === 0) return;
  for (const [mintAddress, position] of portfolio.entries()) {
    // Try to get price - try Jupiter first, then Meteora as fallback
    let currentPrice = 0;
    const isMeteoraDex = position.dexSource === "meteora";

    if (isMeteoraDex) {
      // Meteora token - use Meteora pricing
      currentPrice = await getMeteoraTokenPrice(mintAddress);
    } else {
      // Try Jupiter first
      currentPrice = await getTokenPriceInSol(mintAddress);

      // If Jupiter fails, try Meteora (token might be on Meteora but dexSource not set)
      if (currentPrice === 0) {
        currentPrice = await getMeteoraTokenPrice(mintAddress);
        if (currentPrice > 0) {
          // Update dexSource since we found it on Meteora
          position.dexSource = "meteora";
        }
      }
    }

    // If price is still 0, check how long we've held the token
    if (currentPrice === 0 && portfolio.has(mintAddress)) {
      const timeHeldMinutes = (Date.now() - position.purchaseTimestamp) / 60000;

      // Give new tokens 5 minutes grace period
      if (timeHeldMinutes < 5) {
        await logEvent(
          "INFO",
          `Price unavailable for ${mintAddress.slice(0, 8)}... (held ${timeHeldMinutes.toFixed(1)} min). Waiting for pool indexing.`,
          null,
          totalPnlUsd
        );
        continue;
      }

      // After 5 minutes with no price, try to sell anyway
      await logEvent(
        "WARN",
        `Price for ${mintAddress} is zero after ${timeHeldMinutes.toFixed(1)} min. Attempting to sell 100%.`,
        null,
        totalPnlUsd
      );
      await sellToken(mintAddress, 100);
      continue;
    }

    if (currentPrice > position.highestPriceSeen)
      position.highestPriceSeen = currentPrice;

    const pnlPercentage =
      ((currentPrice - position.purchasePrice) / position.purchasePrice) * 100;
    const dropFromPeak =
      ((position.highestPriceSeen - currentPrice) / position.highestPriceSeen) *
      100;
    await logEvent(
      "INFO",
      `Portfolio Check`,
      {
        mint: mintAddress,
        pnl: `${pnlPercentage.toFixed(2)}%`,
        risk: position.riskLevel,
        dropFromPeak: `${dropFromPeak.toFixed(2)}%`,
      },
      totalPnlUsd
    );

    // NOTE: Trailing stop-loss is now handled in real-time by realtimeTrailingStopService
    // This is a backup check in case real-time monitoring missed it
    if (!isBeingMonitored(mintAddress) && pnlPercentage > 0 && dropFromPeak >= TRAILING_STOP_LOSS_PERCENT) {
      await logEvent(
        "WARN",
        `Backup Trailing Stop Loss triggered (real-time monitor inactive). Selling 100%.`,
        { pnl: pnlPercentage, dropFromPeak },
        totalPnlUsd
      );
      await sellToken(mintAddress, 100);
      continue;
    }

    // Hard stop-loss backup check (also handled in real-time)
    if (pnlPercentage <= -10) {
      await logEvent(
        "WARN",
        `Stop loss triggered. Selling 100%.`,
        { pnl: pnlPercentage },
        totalPnlUsd
      );
      await sellToken(mintAddress, 100);
      continue;
    }

    const timeHeldMins = (Date.now() - position.purchaseTimestamp) / 60000;
    if (
      position.riskLevel === "DANGER" &&
      pnlPercentage > 0 &&
      timeHeldMins > STALE_DANGER_COIN_MINUTES
    ) {
      await logEvent(
        "WARN",
        `Stale DANGER coin held > ${STALE_DANGER_COIN_MINUTES} mins in profit. Selling 100%.`,
        { pnl: pnlPercentage },
        totalPnlUsd
      );
      await sellToken(mintAddress, 100);
      continue;
    }

    if (
      position.riskLevel === "DANGER" &&
      pnlPercentage <= DEEP_LOSS_PERCENT_DANGER
    ) {
      await logEvent(
        "WARN",
        `DANGER coin deep loss condition triggered. Selling 100%.`,
        { pnl: pnlPercentage },
        totalPnlUsd
      );
      await sellToken(mintAddress, 100);
      continue;
    }

    if (!portfolio.has(mintAddress)) continue;
    switch (position.riskLevel) {
      case "GOOD":
        await handleGoodRisk(position, pnlPercentage, mintAddress);
        break;
      case "WARNING":
        await handleWarningRisk(pnlPercentage, mintAddress);
        break;
      case "DANGER":
        await handleDangerRisk(pnlPercentage, mintAddress);
        break;
    }
  }
}

/**
 * Start real-time monitoring for a position (used for restored trades)
 */
export function startRealtimeMonitorForPosition(mintAddress) {
  const position = portfolio.get(mintAddress);
  if (!position) return;

  // Skip if already being monitored
  if (isBeingMonitored(mintAddress)) return;

  const monitor = startTrailingStopMonitor(
    mintAddress,
    position.purchasePrice,
    position.riskLevel || "DANGER",
    async (mint, currentPrice, reason) => {
      await logEvent(
        "WARN",
        `Real-time ${reason} triggered for ${mint}. Executing sell.`,
        { currentPrice, reason },
        totalPnlUsd
      );
      await sellToken(mint, 100);
    },
    position.dexSource || null // Pass dexSource if available
  );
  activeMonitors.set(mintAddress, monitor);
}

/**
 * Start real-time monitoring for all positions in portfolio
 */
export function startRealtimeMonitoringForAllPositions() {
  for (const mintAddress of portfolio.keys()) {
    startRealtimeMonitorForPosition(mintAddress);
  }
}

/**
 * Get active monitors map (for debugging)
 */
export function getActiveMonitors() {
  return activeMonitors;
}
