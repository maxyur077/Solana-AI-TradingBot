import {
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, createCloseAccountInstruction } from "@solana/spl-token";
import {
  WALLET_KEYPAIR,
  SLIPPAGE_BPS,
  TRAILING_STOP_LOSS_PERCENT,
  TRADE_AMOUNTS,
  TAKE_PROFIT_GOOD_TIERS,
  TAKE_PROFIT_PERCENT_DANGER,
  TAKE_PROFIT_PERCENT_WARNING,
  STALE_DANGER_COIN_MINUTES,
  STALE_WARNING_COIN_MINUTES,
  STALE_GOOD_COIN_MINUTES,
  DEEP_LOSS_PERCENT_DANGER,
  MIN_SOL_BALANCE,
  CLOSE_ATA_DELAY_MS,
  MAX_PORTFOLIO_SIZE,
} from "../config.js";
import { sendAndConfirmTransaction, getTokenPriceInSol, connection, getSolPriceUsd } from "./solanaService.js";
import { logEvent, logTrade, addPurchasedToken, updateTradeStatus } from "./databaseService.js";
import { sendBuyNotification, sendSellNotification, sendRuggedNotification } from "./telegramService.js";
import { startTrailingStopMonitor, stopTrailingStopMonitor, isBeingMonitored } from "./realtimeTrailingStopService.js";
import { swapOnMeteora, sellOnMeteora, findMeteoraPool, getMeteoraTokenPrice } from "./meteoraSwapService.js";
import { unsubscribeFromMeteora, subscribeToMeteora } from "./dexManager.js";
import { startCreatorMonitor, stopCreatorMonitor } from "./creatorMonitorService.js";
import { startPoolReserveMonitor, stopPoolReserveMonitor } from "./poolReserveMonitorService.js";
import { SOL_MINT, DEX_TYPES } from "../utils/constants.js";
import { sleep, calculatePnlPercentage, calculateDropFromPeak } from "../utils/helpers.js";
import fetch from "cross-fetch";

const portfolio = new Map();
const activeMonitors = new Map();
let totalPnlUsd = 0;
let tradingEnabled = true; // Trading state flag

let onPortfolioFullCallback = null;
let onPortfolioAvailableCallback = null;

export function setPortfolioCallbacks(onFull, onAvailable) {
  onPortfolioFullCallback = onFull;
  onPortfolioAvailableCallback = onAvailable;
}

export function getPortfolioSize() {
  return portfolio.size;
}

export function getTotalPnlUsd() {
  return totalPnlUsd;
}

export function getPortfolio() {
  return portfolio;
}

export function isPortfolioFull() {
  return portfolio.size >= MAX_PORTFOLIO_SIZE;
}

export function isTradingEnabled() {
  return tradingEnabled;
}

export function pauseTrading(reason = "Global stop loss triggered") {
  tradingEnabled = false;
  logEvent("WARN", `🚫 TRADING PAUSED: ${reason}`, { tradingEnabled: false });
}

export function resumeTrading(reason = "Manually resumed") {
  tradingEnabled = true;
  logEvent("SUCCESS", `✅ TRADING RESUMED: ${reason}`, { tradingEnabled: true });
}

async function checkAndNotifyPortfolioStatus() {
  if (portfolio.size >= 2 && onPortfolioFullCallback) {
    await onPortfolioFullCallback();
  }
}

async function checkAndNotifyPortfolioAvailable() {
  if (portfolio.size < 2 && onPortfolioAvailableCallback) {
    await onPortfolioAvailableCallback();
  }
}

async function executeJupiterBuy(mintAddress, tradeAmountSol) {
  const maxRetries = 3;
  const retryDelays = [0, 3000, 5000];

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
      const txResult = await sendAndConfirmTransaction(transaction, latestBlockhash);

      if (txResult) {
        return { success: true, ...txResult };
      }
    } catch (error) {
      if (attempt === maxRetries - 1) {
        throw error;
      }
      await logEvent("WARN", `Buy attempt ${attempt + 1} failed: ${error.message}. Retrying...`);
    }
  }
  return { success: false };
}

async function executeMeteoraBuy(mintAddress, tradeAmountSol, poolAddress) {
  const result = await swapOnMeteora(mintAddress, tradeAmountSol, poolAddress);
  if (result) {
    return { success: true, ...result };
  }
  return { success: false };
}

export async function buyToken(mintAddress, riskLevel, metadata, poolAddress = null, dexSource = null, creatorAddress = null, creatorHistory = null) {
  // Check if trading is enabled
  if (!tradingEnabled) {
    await logEvent("WARN", `Trading is paused. Skipping buy for ${mintAddress}`, {
      tradingEnabled: false,
    });
    return false;
  }

  const tradeAmountSol = TRADE_AMOUNTS[riskLevel] || TRADE_AMOUNTS.DANGER;
  // Only use direct Meteora swap for DAMM v2 - DLMM should go through Jupiter
  const isMeteoraDammV2 = dexSource === "meteora-damm_v2" || dexSource === "meteora-damm-v2";
  const isMeteoraDex = isMeteoraDammV2; // Only DAMM v2 uses direct Meteora swap

  const walletBalance = await connection.getBalance(WALLET_KEYPAIR.publicKey);
  if (walletBalance / LAMPORTS_PER_SOL < tradeAmountSol + MIN_SOL_BALANCE) {
    await logEvent("ERROR", "Insufficient SOL balance.", {
      current: walletBalance / LAMPORTS_PER_SOL,
      required: tradeAmountSol + MIN_SOL_BALANCE,
    });
    return false;
  }

  let priceCheckPassed = false;
  let initialPrice = 0;

  if (isMeteoraDex) {
    const meteoraPool = await findMeteoraPool(mintAddress, poolAddress);
    if (!meteoraPool) {
      await logEvent("WARN", `No Meteora pool found for ${mintAddress}. Skipping buy.`, null, totalPnlUsd);
      return false;
    }
    initialPrice = await getMeteoraTokenPrice(mintAddress);
    if (initialPrice > 0) {
      priceCheckPassed = true;
    }
  } else {
    initialPrice = await getTokenPriceInSol(mintAddress);
    if (initialPrice > 0) {
      priceCheckPassed = true;
    } else {
      initialPrice = await getMeteoraTokenPrice(mintAddress);
      if (initialPrice > 0) {
        priceCheckPassed = true;
      }
    }
  }

  if (!priceCheckPassed || initialPrice <= 0) {
    await logEvent("WARN", `Price not available for ${mintAddress}. Pool may not have liquidity. Skipping buy.`, null, totalPnlUsd);
    return false;
  }

  await logEvent("INFO", `Price validated: ${initialPrice.toExponential(4)} SOL. Proceeding with buy.`, { mintAddress }, totalPnlUsd);

  await logEvent("INFO", `Attempting to buy ${mintAddress} for ${tradeAmountSol} SOL`, {
    riskLevel,
    dexSource: dexSource || DEX_TYPES.JUPITER,
  }, totalPnlUsd);

  let buyResult = null;
  let finalDexSource = DEX_TYPES.JUPITER;

  if (isMeteoraDex) {
    // Only DAMM v2 uses direct Meteora CP-AMM swap
    await logEvent("INFO", `Using Meteora DAMM v2 direct swap for ${dexSource} token...`);
    buyResult = await executeMeteoraBuy(mintAddress, tradeAmountSol, poolAddress);
    finalDexSource = DEX_TYPES.METEORA_DAMM_V2;

    if (!buyResult.success) {
      await logEvent("ERROR", `Meteora DAMM v2 swap failed for ${mintAddress}`);
      return false;
    }
  } else {
    // Use Jupiter for everything else (including DLMM, Raydium, etc.)
    try {
      buyResult = await executeJupiterBuy(mintAddress, tradeAmountSol);
      // If original source was DLMM, record it
      if (dexSource === "meteora-dlmm") {
        finalDexSource = DEX_TYPES.METEORA_DLMM;
      }
    } catch (error) {
      await logEvent("WARN", `Jupiter failed. Trying Meteora DAMM v2 direct swap as fallback...`, { error: error.message }, totalPnlUsd);

      const meteoraPool = await findMeteoraPool(mintAddress, poolAddress);
      if (meteoraPool) {
        await logEvent("INFO", "Found Meteora DAMM v2 pool, attempting direct swap...", {
          poolAddress: meteoraPool.poolAddress.toString(),
        });
        buyResult = await executeMeteoraBuy(mintAddress, tradeAmountSol, poolAddress);
        finalDexSource = DEX_TYPES.METEORA_DAMM_V2;
      }

      if (!buyResult || !buyResult.success) {
        await logEvent("ERROR", `Error buying token ${mintAddress} - all methods failed`, { error: error.message }, totalPnlUsd);
        return false;
      }
    }
  }

  if (!buyResult || !buyResult.success) {
    return false;
  }

  const tokenAta = await getAssociatedTokenAddress(new PublicKey(mintAddress), WALLET_KEYPAIR.publicKey);

  let tokenBalance = "0";
  try {
    const balanceResponse = await connection.getTokenAccountBalance(tokenAta);
    tokenBalance = balanceResponse.value.amount;
  } catch (balanceError) {
    await logEvent("WARN", "Could not fetch token balance after swap");
  }

  let purchasePrice = 0;
  if (finalDexSource === DEX_TYPES.METEORA_DAMM_V2) {
    purchasePrice = await getMeteoraTokenPrice(mintAddress);
  } else {
    purchasePrice = await getTokenPriceInSol(mintAddress);
  }

  if (purchasePrice <= 0 && parseInt(tokenBalance) > 0) {
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
    buySignature: buyResult.signature,
    dexSource: finalDexSource,
    poolAddress: poolAddress || null,
  });

  await addPurchasedToken(mintAddress);
  await logTrade("BUY", mintAddress, tradeAmountSol, finalPrice, buyResult.fee, buyResult.signature, totalPnlUsd, finalDexSource);
  await sendBuyNotification(metadata, tradeAmountSol, buyResult.signature, totalPnlUsd, creatorHistory);

  const monitor = startTrailingStopMonitor(
    mintAddress,
    finalPrice,
    riskLevel,
    async (mint, currentPrice, reason) => {
      await logEvent("WARN", `Real-time ${reason} triggered for ${mint}. Executing sell.`, { currentPrice, reason }, totalPnlUsd);
      await sellToken(mint, 100);
    },
    finalDexSource
  );
  activeMonitors.set(mintAddress, monitor);

  // Start real-time creator wallet monitoring to detect early dumping
  if (creatorAddress) {
    await startCreatorMonitor(mintAddress, creatorAddress, async (mint, soldPercent) => {
      await logEvent("ERROR", `Creator dump detected! Sold ${soldPercent.toFixed(2)}%. Emergency selling.`, { mint }, totalPnlUsd);
      await sellToken(mint, 100);
    });
  }

  // Start real-time pool reserve monitoring to detect liquidity removal (rug pulls)
  // This catches rugs from ANY wallet, not just the creator
  if (poolAddress) {
    await startPoolReserveMonitor(mintAddress, poolAddress, finalDexSource, async (mint, dropPercent, reason) => {
      await logEvent("ERROR", `🚨 POOL RUG DETECTED! ${dropPercent.toFixed(2)}% liquidity removed (${reason}). Emergency selling.`, { mint }, totalPnlUsd);
      await sellToken(mint, 100);
    });
  }

  await logEvent("SUCCESS", `Bought ${mintAddress} via ${finalDexSource}!`);

  await checkAndNotifyPortfolioStatus();

  return true;
}

async function executeJupiterSell(mintAddress, amountToSell) {
  const maxRetries = 3;
  const retryDelay = 5000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await logEvent("INFO", `Attempt ${attempt}/${maxRetries} to sell via Jupiter`, null, totalPnlUsd);
    try {
      const quoteResponse = await (
        await fetch(
          `https://api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amountToSell}&slippageBps=${SLIPPAGE_BPS}`
        )
      ).json();

      if (!quoteResponse || quoteResponse.error) {
        throw new Error(`Failed to get quote: ${quoteResponse?.error || "No quote response"}`);
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
        throw new Error("Failed to get swap transaction from Jupiter.");
      }

      const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      const latestBlockhash = await connection.getLatestBlockhash();
      const txResult = await sendAndConfirmTransaction(transaction, latestBlockhash);

      if (txResult) {
        const receivedSol = parseInt(quoteResponse.outAmount, 10) / LAMPORTS_PER_SOL;
        return { success: true, receivedSol, ...txResult };
      }
    } catch (error) {
      await logEvent("ERROR", `Error on Jupiter sell attempt ${attempt}`, { error: error.message }, totalPnlUsd);
    }
    if (attempt < maxRetries) await sleep(retryDelay);
  }
  return { success: false };
}

async function executeMeteoraSell(mintAddress, amountToSell) {
  const result = await sellOnMeteora(mintAddress, amountToSell.toString());
  if (result) {
    return { success: true, receivedSol: result.solReceived, ...result };
  }
  return { success: false };
}

export async function sellToken(mintAddress, sellPercentage) {
  const position = portfolio.get(mintAddress);
  if (!position) return false;

  // Only use direct Meteora swap for DAMM v2 tokens
  const isMeteoraDammV2 = position.dexSource === DEX_TYPES.METEORA_DAMM_V2 || position.dexSource === DEX_TYPES.METEORA;

  const tokenAta = await getAssociatedTokenAddress(new PublicKey(mintAddress), WALLET_KEYPAIR.publicKey);
  let onChainBalance;
  try {
    const balanceResponse = await connection.getTokenAccountBalance(tokenAta);
    onChainBalance = parseInt(balanceResponse.value.amount, 10);
  } catch {
    onChainBalance = 0;
  }

  if (isNaN(onChainBalance) || onChainBalance === 0) {
    await logEvent("WARN", `On-chain balance for ${mintAddress} is zero. Removing from portfolio.`, null, totalPnlUsd);
    portfolio.delete(mintAddress);
    await updateTradeStatus(position.buySignature, "SOLD");
    await checkAndNotifyPortfolioAvailable();
    return false;
  }

  const amountToSell = Math.round((onChainBalance * sellPercentage) / 100);
  if (amountToSell <= 0) return false;

  await logEvent("INFO", `Selling ${sellPercentage}% of ${mintAddress} via ${position.dexSource}`, null, totalPnlUsd);

  let sellResult = null;

  if (isMeteoraDammV2) {
    sellResult = await executeMeteoraSell(mintAddress, amountToSell);
  } else {
    sellResult = await executeJupiterSell(mintAddress, amountToSell);

    if (!sellResult.success) {
      await logEvent("WARN", `Jupiter sell failed. Trying Meteora as fallback...`, null, totalPnlUsd);
      sellResult = await executeMeteoraSell(mintAddress, amountToSell);
    }
  }

  if (!sellResult || !sellResult.success) {
    await logEvent("ERROR", `Failed to sell ${mintAddress} after all attempts.`, null, totalPnlUsd);

    // Check if coin has been held for more than 8 minutes - assume rugged
    const timeHeldMinutes = (Date.now() - position.purchaseTimestamp) / 60000;
    if (timeHeldMinutes >= 8) {
      await logEvent("ERROR", `🚨 ASSUMED RUGGED: ${mintAddress} held for ${timeHeldMinutes.toFixed(1)} min and cannot be sold. Removing from portfolio.`, null, totalPnlUsd);

      // Calculate and record loss
      const solPrice = await getSolPriceUsd();
      const lossUsd = position.tradeAmountSol * solPrice;
      totalPnlUsd -= lossUsd;

      // Send Telegram notification
      await sendRuggedNotification(mintAddress, lossUsd, totalPnlUsd, `Held for ${timeHeldMinutes.toFixed(1)} min and cannot be sold`);

      stopTrailingStopMonitor(mintAddress);
      await stopCreatorMonitor(mintAddress, "Assumed rugged - cannot sell");
      await stopPoolReserveMonitor(mintAddress, "Assumed rugged - cannot sell");
      activeMonitors.delete(mintAddress);
      portfolio.delete(mintAddress);
      await updateTradeStatus(position.buySignature, "RUGGED");
      await checkAndNotifyPortfolioAvailable();
      return false;
    }

    await updateTradeStatus(position.buySignature, "SELL_FAILED");
    return false;
  }

  const receivedSol = sellResult.receivedSol || 0;
  const initialInvestment = position.tradeAmountSol * (sellPercentage / 100);
  const profitInSol = receivedSol - initialInvestment;
  const solPrice = await getSolPriceUsd();

  let profitUsd = 0;
  if (solPrice > 0) {
    profitUsd = profitInSol * solPrice;
    totalPnlUsd += profitUsd;
  }

  await logTrade("SELL", mintAddress, receivedSol, position.purchasePrice, sellResult.fee, sellResult.signature, totalPnlUsd, position.dexSource);
  await sendSellNotification(mintAddress, receivedSol, profitUsd, totalPnlUsd, sellResult.signature);

  if (sellPercentage === 100) {
    stopTrailingStopMonitor(mintAddress);
    await stopCreatorMonitor(mintAddress, "Position sold");
    await stopPoolReserveMonitor(mintAddress, "Position sold");
    activeMonitors.delete(mintAddress);
    portfolio.delete(mintAddress);
    await updateTradeStatus(position.buySignature, "SOLD");
    await closeTokenAccount(mintAddress);
    await checkAndNotifyPortfolioAvailable();
  } else {
    position.amount = (onChainBalance - amountToSell).toString();
  }

  await logEvent("SUCCESS", `Sold ${mintAddress} via ${position.dexSource}!`, { solReceived: receivedSol, profitUsd: profitUsd.toFixed(4) });
  return true;
}

async function closeTokenAccount(mintAddress) {
  await sleep(CLOSE_ATA_DELAY_MS);
  await logEvent("INFO", `Attempting to close ATA for ${mintAddress}`, null, totalPnlUsd);

  for (let i = 0; i < 3; i++) {
    try {
      const tokenAta = await getAssociatedTokenAddress(new PublicKey(mintAddress), WALLET_KEYPAIR.publicKey);
      const closeInstruction = createCloseAccountInstruction(tokenAta, WALLET_KEYPAIR.publicKey, WALLET_KEYPAIR.publicKey);
      const latestBlockhash = await connection.getLatestBlockhash();
      const message = new TransactionMessage({
        payerKey: WALLET_KEYPAIR.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [closeInstruction],
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      const txResult = await sendAndConfirmTransaction(tx, latestBlockhash);
      if (txResult) {
        await logEvent("SUCCESS", `Successfully closed ATA for ${mintAddress}.`);
        return;
      }
    } catch (error) {
      await logEvent("WARN", `Attempt ${i + 1} to close ATA for ${mintAddress} failed.`, { error: error.message }, totalPnlUsd);
      await sleep(2000);
    }
  }
  await logEvent("ERROR", `Failed to close ATA for ${mintAddress} after multiple retries.`);
}

async function handleGoodRisk(position, pnlPercentage, mintAddress) {
  const { TP1, TP2, TP3 } = TAKE_PROFIT_GOOD_TIERS;
  if (pnlPercentage >= TP3.PROFIT_PERCENT && !position.profitTakenLevels.includes(3)) {
    await logEvent("SUCCESS", `TP (GOOD, ${TP3.PROFIT_PERCENT}%) triggered. Selling ${TP3.SELL_PERCENT}%.`, null, totalPnlUsd);
    await sellToken(mintAddress, TP3.SELL_PERCENT);
  } else if (pnlPercentage >= TP2.PROFIT_PERCENT && !position.profitTakenLevels.includes(2)) {
    await logEvent("SUCCESS", `TP (GOOD, ${TP2.PROFIT_PERCENT}%) triggered. Selling ${TP2.SELL_PERCENT}%.`, null, totalPnlUsd);
    position.profitTakenLevels.push(2);
    await sellToken(mintAddress, TP2.SELL_PERCENT);
  } else if (pnlPercentage >= TP1.PROFIT_PERCENT && !position.profitTakenLevels.includes(1)) {
    await logEvent("SUCCESS", `TP (GOOD, ${TP1.PROFIT_PERCENT}%) triggered. Selling ${TP1.SELL_PERCENT}%.`, null, totalPnlUsd);
    position.profitTakenLevels.push(1);
    await sellToken(mintAddress, TP1.SELL_PERCENT);
  }
}

async function handleWarningRisk(pnlPercentage, mintAddress) {
  if (pnlPercentage >= TAKE_PROFIT_PERCENT_WARNING) {
    await logEvent("SUCCESS", `TP (WARNING, ${TAKE_PROFIT_PERCENT_WARNING}%) triggered. Selling 100%.`, null, totalPnlUsd);
    await sellToken(mintAddress, 100);
  }
}

async function handleDangerRisk(pnlPercentage, mintAddress) {
  if (pnlPercentage >= TAKE_PROFIT_PERCENT_DANGER) {
    await logEvent("SUCCESS", `TP (DANGER, ${TAKE_PROFIT_PERCENT_DANGER}%) triggered. Selling 100%.`, null, totalPnlUsd);
    await sellToken(mintAddress, 100);
  }
}

export async function monitorPortfolio() {
  if (portfolio.size === 0) return;

  for (const [mintAddress, position] of portfolio.entries()) {
    let currentPrice = 0;
    // Only use direct Meteora price for DAMM v2
    const isMeteoraDammV2 = position.dexSource === DEX_TYPES.METEORA_DAMM_V2 || position.dexSource === DEX_TYPES.METEORA;

    if (isMeteoraDammV2) {
      currentPrice = await getMeteoraTokenPrice(mintAddress);
    } else {
      currentPrice = await getTokenPriceInSol(mintAddress);
      if (currentPrice === 0) {
        currentPrice = await getMeteoraTokenPrice(mintAddress);
        if (currentPrice > 0) {
          position.dexSource = DEX_TYPES.METEORA_DAMM_V2;
        }
      }
    }

    if (currentPrice === 0 && portfolio.has(mintAddress)) {
      const timeHeldMinutes = (Date.now() - position.purchaseTimestamp) / 60000;

      if (timeHeldMinutes < 5) {
        await logEvent("INFO", `Price unavailable for ${mintAddress.slice(0, 8)}... (held ${timeHeldMinutes.toFixed(1)} min). Waiting for pool indexing.`, null, totalPnlUsd);
        continue;
      }

      // Price unavailable for 5+ minutes - assume rugged, mark as loss
      await logEvent("ERROR", `🚨 PRICE UNAVAILABLE for ${timeHeldMinutes.toFixed(1)} min. Assuming rugged. Marking as loss.`, null, totalPnlUsd);

      // Calculate loss (full trade amount lost)
      const solPrice = await getSolPriceUsd();
      const lossUsd = position.tradeAmountSol * solPrice;
      totalPnlUsd -= lossUsd;

      await logEvent("ERROR", `💸 Loss recorded: -$${lossUsd.toFixed(4)} | Total PnL: $${totalPnlUsd.toFixed(4)}`, {
        mint: mintAddress,
        tradeAmountSol: position.tradeAmountSol,
        lossUsd: lossUsd.toFixed(4),
      }, totalPnlUsd);

      // Send Telegram notification
      await sendRuggedNotification(mintAddress, lossUsd, totalPnlUsd, `Price unavailable for ${timeHeldMinutes.toFixed(1)} minutes`);

      // Log the loss trade
      await logTrade("RUGGED", mintAddress, 0, position.purchasePrice, 0, position.buySignature, totalPnlUsd, position.dexSource);

      // Clean up monitors and remove from portfolio
      stopTrailingStopMonitor(mintAddress);
      await stopCreatorMonitor(mintAddress, "Price unavailable - assumed rugged");
      await stopPoolReserveMonitor(mintAddress, "Price unavailable - assumed rugged");
      activeMonitors.delete(mintAddress);
      portfolio.delete(mintAddress);
      await updateTradeStatus(position.buySignature, "RUGGED");
      await checkAndNotifyPortfolioAvailable();
      continue;
    }

    if (currentPrice > position.highestPriceSeen) {
      position.highestPriceSeen = currentPrice;
    }

    const pnlPercentage = calculatePnlPercentage(currentPrice, position.purchasePrice);
    const dropFromPeak = calculateDropFromPeak(position.highestPriceSeen, currentPrice);

    await logEvent("INFO", `Portfolio Check`, {
      mint: mintAddress,
      pnl: `${pnlPercentage.toFixed(2)}%`,
      risk: position.riskLevel,
      dropFromPeak: `${dropFromPeak.toFixed(2)}%`,
    }, totalPnlUsd);

    if (!isBeingMonitored(mintAddress) && pnlPercentage > 0 && dropFromPeak >= TRAILING_STOP_LOSS_PERCENT) {
      await logEvent("WARN", `Backup Trailing Stop Loss triggered (real-time monitor inactive). Selling 100%.`, { pnl: pnlPercentage, dropFromPeak }, totalPnlUsd);
      await sellToken(mintAddress, 100);
      continue;
    }

    if (pnlPercentage <= -10) {
      await logEvent("WARN", `Stop loss triggered. Selling 100%.`, { pnl: pnlPercentage }, totalPnlUsd);
      await sellToken(mintAddress, 100);
      continue;
    }

    const timeHeldMins = (Date.now() - position.purchaseTimestamp) / 60000;

    // Time-based auto-sell for all risk levels
    // WARNING: Sell after 5 minutes
    if (position.riskLevel === "WARNING" && timeHeldMins >= STALE_WARNING_COIN_MINUTES) {
      await logEvent("WARN", `WARNING coin held >= ${STALE_WARNING_COIN_MINUTES} mins. Time-based auto-sell triggered.`, {
        pnl: pnlPercentage.toFixed(2) + "%",
        timeHeld: timeHeldMins.toFixed(1) + " mins",
      }, totalPnlUsd);
      await sellToken(mintAddress, 100);
      continue;
    }

    // GOOD: Sell after 6 minutes
    if (position.riskLevel === "GOOD" && timeHeldMins >= STALE_GOOD_COIN_MINUTES) {
      await logEvent("WARN", `GOOD coin held >= ${STALE_GOOD_COIN_MINUTES} mins. Time-based auto-sell triggered.`, {
        pnl: pnlPercentage.toFixed(2) + "%",
        timeHeld: timeHeldMins.toFixed(1) + " mins",
      }, totalPnlUsd);
      await sellToken(mintAddress, 100);
      continue;
    }

    // DANGER: Sell if in profit and held too long
    if (position.riskLevel === "DANGER" && pnlPercentage > 0 && timeHeldMins > STALE_DANGER_COIN_MINUTES) {
      await logEvent("WARN", `Stale DANGER coin held > ${STALE_DANGER_COIN_MINUTES} mins in profit. Selling 100%.`, { pnl: pnlPercentage }, totalPnlUsd);
      await sellToken(mintAddress, 100);
      continue;
    }

    if (position.riskLevel === "DANGER" && pnlPercentage <= DEEP_LOSS_PERCENT_DANGER) {
      await logEvent("WARN", `DANGER coin deep loss condition triggered. Selling 100%.`, { pnl: pnlPercentage }, totalPnlUsd);
      await sellToken(mintAddress, 100);
      continue;
    }

    // ASSUMED RUGGED: If held for 8+ minutes and still in portfolio, force remove
    if (timeHeldMins >= 8) {
      await logEvent("WARN", `Coin held for ${timeHeldMins.toFixed(1)} min. Attempting final sell before assuming rugged...`, null, totalPnlUsd);
      const sold = await sellToken(mintAddress, 100);
      if (!sold && portfolio.has(mintAddress)) {
        await logEvent("ERROR", `🚨 ASSUMED RUGGED: ${mintAddress} cannot be sold after 8 min. Force removing from portfolio.`, null, totalPnlUsd);

        // Calculate and record loss
        const solPrice = await getSolPriceUsd();
        const lossUsd = position.tradeAmountSol * solPrice;
        totalPnlUsd -= lossUsd;

        // Send Telegram notification
        await sendRuggedNotification(mintAddress, lossUsd, totalPnlUsd, `Cannot be sold after ${timeHeldMins.toFixed(1)} minutes`);

        stopTrailingStopMonitor(mintAddress);
        await stopCreatorMonitor(mintAddress, "Assumed rugged after 8 min");
        await stopPoolReserveMonitor(mintAddress, "Assumed rugged after 8 min");
        activeMonitors.delete(mintAddress);
        portfolio.delete(mintAddress);
        await updateTradeStatus(position.buySignature, "RUGGED");
        await checkAndNotifyPortfolioAvailable();
      }
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

export function startRealtimeMonitorForPosition(mintAddress) {
  const position = portfolio.get(mintAddress);
  if (!position) return;

  if (isBeingMonitored(mintAddress)) return;

  const monitor = startTrailingStopMonitor(
    mintAddress,
    position.purchasePrice,
    position.riskLevel || "DANGER",
    async (mint, currentPrice, reason) => {
      await logEvent("WARN", `Real-time ${reason} triggered for ${mint}. Executing sell.`, { currentPrice, reason }, totalPnlUsd);
      await sellToken(mint, 100);
    },
    position.dexSource || null
  );
  activeMonitors.set(mintAddress, monitor);
}

export function startRealtimeMonitoringForAllPositions() {
  for (const mintAddress of portfolio.keys()) {
    startRealtimeMonitorForPosition(mintAddress);
  }
}

export function getActiveMonitors() {
  return activeMonitors;
}
