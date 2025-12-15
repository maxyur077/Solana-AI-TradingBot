import axios from "axios";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from "../config.js";
import { logEvent, calculateTotalProfitFromDatabase, getTradesInLastHour } from "./databaseService.js";
import { getSolPriceUsd } from "./solanaService.js";

const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

async function sendMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    logEvent("WARN", "Telegram credentials not set. Skipping notification.");
    return;
  }
  try {
    await axios.post(TELEGRAM_API_URL, {
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: "Markdown",
    });
  } catch (error) {
    logEvent("ERROR", "Failed to send Telegram message", {
      error: error.message,
    });
  }
}

export async function sendBuyNotification(metadata, solAmount, signature, totalPnl = null, creatorStats = null) {
  let message = `
🚀 **New Buy!** 🚀
*Token:* ${metadata.name} (${metadata.symbol})
*Amount:* ${solAmount} SOL
*Signature:* [${signature.slice(0, 8)}...](https://solscan.io/tx/${signature})`;

  // Add creator stats if available
  if (creatorStats && creatorStats.totalTokens > 0) {
    message += `\n\n📊 *Creator Report:*\n`;
    message += `• Total Coins: ${creatorStats.totalTokens}\n`;
    message += `• Survived >10 min: ${creatorStats.survivedTokens}\n`;
    message += `• Quick Rugs: ${creatorStats.quickRugs}\n`;
    if (creatorStats.avgSurvivalMins > 0) {
      message += `• Avg Survival: ${creatorStats.avgSurvivalMins} mins`;
    }
  }

  // Calculate and add total profit from database
  try {
    const dbProfit = await calculateTotalProfitFromDatabase();
    const solPrice = await getSolPriceUsd();
    const totalProfitUsd = dbProfit.profitInSol * solPrice;
    const pnlSign = totalProfitUsd >= 0 ? '+' : '';
    message += `\n\n💰 *Total Bot Earnings (DB):* ${pnlSign}$${totalProfitUsd.toFixed(4)}`;
    message += `\n📈 *Total Trades:* ${dbProfit.buyCount} buys, ${dbProfit.sellCount} sells`;
  } catch (error) {
    // Fallback to in-memory PnL if database calculation fails
    if (totalPnl !== null) {
      const pnlSign = totalPnl >= 0 ? '+' : '';
      message += `\n\n💰 *Total Bot Earnings:* ${pnlSign}$${totalPnl.toFixed(4)}`;
    }
  }

  await sendMessage(message);
}

export async function sendSellNotification(
  mint,
  solAmount,
  profitUsd,
  totalPnl,
  signature
) {
  const pnlEmoji = profitUsd >= 0 ? "✅" : "❌";
  let message = `
${pnlEmoji} **Trade Closed!** ${pnlEmoji}
*Token:* [${mint.slice(0, 8)}...](https://solscan.io/token/${mint})
*Sold For:* ${solAmount.toFixed(4)} SOL
*Profit/Loss:* $${profitUsd.toFixed(4)}
*Signature:* [${signature.slice(0, 8)}...](https://solscan.io/tx/${signature})`;

  // Calculate and add total profit from database
  try {
    const dbProfit = await calculateTotalProfitFromDatabase();
    const solPrice = await getSolPriceUsd();
    const totalProfitUsd = dbProfit.profitInSol * solPrice;
    const pnlSign = totalProfitUsd >= 0 ? '+' : '';
    message += `\n\n💰 *Total Bot Earnings (DB):* ${pnlSign}$${totalProfitUsd.toFixed(4)}`;
    message += `\n📈 *Total Trades:* ${dbProfit.buyCount} buys, ${dbProfit.sellCount} sells`;
  } catch (error) {
    // Fallback to in-memory PnL if database calculation fails
    message += `\n*Total PnL:* $${totalPnl.toFixed(4)}`;
  }

  await sendMessage(message);
}

export async function sendStartupNotification(wallet) {
  const message = `
🤖 **Solana AI Bot Initialized** 🤖
*Developer:* Mayur Maskar
*Wallet:* \`${wallet}\`
The bot is now live and monitoring for opportunities.
    `;
  await sendMessage(message);
}

export async function sendTradingPausedNotification(totalPnl) {
  const message = `
🚫 **TRADING PAUSED** 🚫
*Reason:* Total PnL dropped below -$1.00
*Current PnL:* $${totalPnl.toFixed(4)}

The bot will continue monitoring existing positions but will NOT take new trades.

To resume trading, use the /resume endpoint or restart the bot.
    `;
  await sendMessage(message);
}

export async function sendTradingResumedNotification(totalPnl) {
  const message = `
✅ **TRADING RESUMED** ✅
*Current PnL:* $${totalPnl.toFixed(4)}

The bot will now resume taking new trades.
    `;
  await sendMessage(message);
}

export async function sendHourlyProfitReport() {
  try {
    // Get total profit from database
    const dbProfit = await calculateTotalProfitFromDatabase();
    const solPrice = await getSolPriceUsd();
    const totalProfitUsd = dbProfit.profitInSol * solPrice;

    // Get hourly profit
    const hourlyData = await getTradesInLastHour();
    const hourlyProfitUsd = hourlyData.profitInSol * solPrice;

    const totalPnlSign = totalProfitUsd >= 0 ? '+' : '';
    const hourlyPnlSign = hourlyProfitUsd >= 0 ? '+' : '';
    const hourlyEmoji = hourlyProfitUsd >= 0 ? '📈' : '📉';

    const message = `
⏰ **Hourly Profit Report** ⏰

${hourlyEmoji} *Last Hour Performance:*
• Profit/Loss: ${hourlyPnlSign}$${hourlyProfitUsd.toFixed(4)}
• Buys: ${hourlyData.buyCount}
• Sells: ${hourlyData.sellCount}

💰 *Overall Performance:*
• Total Earnings: ${totalPnlSign}$${totalProfitUsd.toFixed(4)}
• Total Buys: ${dbProfit.buyCount}
• Total Sells: ${dbProfit.sellCount}
• Profit in SOL: ${totalPnlSign}${dbProfit.profitInSol.toFixed(4)} SOL

📊 *Current SOL Price:* $${solPrice.toFixed(2)}
    `;

    await sendMessage(message);
    await logEvent("INFO", "Sent hourly profit report to Telegram", {
      hourlyProfitUsd: hourlyProfitUsd.toFixed(4),
      totalProfitUsd: totalProfitUsd.toFixed(4)
    });
  } catch (error) {
    await logEvent("ERROR", "Failed to send hourly profit report", { error: error.message });
  }
}
