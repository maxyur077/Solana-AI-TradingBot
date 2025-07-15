import axios from "axios";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from "../config.js";
import { logEvent } from "./databaseService.js";

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

export async function sendBuyNotification(metadata, solAmount, signature) {
  const message = `
🚀 **New Buy!** 🚀
*Token:* ${metadata.name} (${metadata.symbol})
*Amount:* ${solAmount} SOL
*Signature:* [${signature.slice(0, 8)}...](https://solscan.io/tx/${signature})
    `;
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
  const message = `
${pnlEmoji} **Trade Closed!** ${pnlEmoji}
*Token:* [${mint.slice(0, 8)}...](https://solscan.io/token/${mint})
*Sold For:* ${solAmount.toFixed(4)} SOL
*Profit/Loss:* $${profitUsd.toFixed(4)}
*Total PnL:* $${totalPnl.toFixed(4)}
*Signature:* [${signature.slice(0, 8)}...](https://solscan.io/tx/${signature})
    `;
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
