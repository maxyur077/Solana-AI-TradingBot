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
import fetch from "cross-fetch";

const portfolio = new Map();
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

export async function buyToken(mintAddress, riskLevel, metadata) {
  const tradeAmountSol = TRADE_AMOUNTS[riskLevel] || TRADE_AMOUNTS.DANGER;

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
    { riskLevel },
    totalPnlUsd
  );
  try {
    const amountInLamports = Math.round(tradeAmountSol * LAMPORTS_PER_SOL);
    const quoteResponse = await (
      await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mintAddress}&amount=${amountInLamports}&slippageBps=${SLIPPAGE_BPS}`
      )
    ).json();

    const { swapTransaction } = await (
      await fetch("https://quote-api.jup.ag/v6/swap", {
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
      throw new Error("Failed to get swap transaction from Jupiter API.");

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

        await addToBlacklist(metadata.name, metadata.symbol);
        return true;
      }
    }
    return false;
  } catch (error) {
    await logEvent(
      "ERROR",
      `Error buying token ${mintAddress}`,
      { error: error.message },
      totalPnlUsd
    );
    return false;
  }
}

export async function sellToken(mintAddress, sellPercentage) {
  const maxRetries = 3;
  const retryDelay = 5000;
  const position = portfolio.get(mintAddress);
  if (!position) return false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await logEvent(
      "INFO",
      `Attempt ${attempt}/${maxRetries} to sell ${sellPercentage}% of ${mintAddress}`,
      null,
      totalPnlUsd
    );
    try {
      const tokenAta = await getAssociatedTokenAddress(
        new PublicKey(mintAddress),
        WALLET_KEYPAIR.publicKey
      );
      const balanceResponse = await connection.getTokenAccountBalance(tokenAta);
      const onChainBalance = parseInt(balanceResponse.value.amount, 10);

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

      const quoteResponse = await (
        await fetch(
          `https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amountToSell}&slippageBps=${SLIPPAGE_BPS}`
        )
      ).json();
      if (!quoteResponse || quoteResponse.error)
        throw new Error(
          `Failed to get quote: ${quoteResponse?.error || "No quote response"}`
        );

      const { swapTransaction } = await (
        await fetch("https://quote-api.jup.ag/v6/swap", {
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
        if (solPrice > 0) totalPnlUsd += profitInSol * solPrice;

        await logTrade(
          "SELL",
          mintAddress,
          receivedSol,
          sellPrice,
          txResult.fee,
          txResult.signature,
          totalPnlUsd
        );

        if (sellPercentage === 100) {
          portfolio.delete(mintAddress);
          await updateTradeStatus(position.buySignature, "SOLD");
          await closeTokenAccount(mintAddress);
        } else if (position) {
          position.amount = (onChainBalance - amountToSell).toString();
        }
        return true;
      }
    } catch (error) {
      await logEvent(
        "ERROR",
        `Error on sell attempt ${attempt}`,
        { error: error.message },
        totalPnlUsd
      );
    }
    if (attempt < maxRetries) await sleep(retryDelay);
  }

  await logEvent(
    "ERROR",
    `Failed to sell ${mintAddress} after ${maxRetries} attempts.`,
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
    const currentPrice = await getTokenPriceInSol(mintAddress);
    if (currentPrice === 0 && portfolio.has(mintAddress)) {
      await logEvent(
        "WARN",
        `Price for ${mintAddress} is zero. Selling 100%.`,
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

    if (pnlPercentage > 0 && dropFromPeak >= TRAILING_STOP_LOSS_PERCENT) {
      await logEvent(
        "WARN",
        `Trailing Stop Loss triggered. Selling 100%.`,
        { pnl: pnlPercentage, dropFromPeak },
        totalPnlUsd
      );
      await sellToken(mintAddress, 100);
      continue;
    }

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
