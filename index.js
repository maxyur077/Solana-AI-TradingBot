import { Connection, PublicKey } from "@solana/web3.js";
import {
  RAYDIUM_LIQUIDITY_POOL_V4,
  RPC_URL,
  WALLET_KEYPAIR,
} from "./config.js";
import { shouldBuyToken } from "./services/geminiService.js";
import { buyToken, monitorPortfolio } from "./services/tradeService.js";
import { getTokenMetadata, checkRug } from "./services/vettingService.js";
import {
  initDb,
  logEvent,
  hasBeenPurchased,
} from "./services/databaseService.js";
import { loadBlacklist, isBlacklisted } from "./services/blacklistService.js";
import chalk from "chalk";

const seenSignatures = new Set();
const connection = new Connection(RPC_URL, "confirmed");

async function processNewLiquidityPool(transaction) {
  try {
    if (
      !transaction ||
      !transaction.meta ||
      !transaction.meta.postTokenBalances
    )
      return;
    const postTokenBalances = transaction.meta.postTokenBalances;
    const newMintInfo = postTokenBalances.find(
      (tb) =>
        tb.mint !== "So11111111111111111111111111111111111111112" &&
        tb.owner === "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
    );
    if (!newMintInfo) return;
    const newMint = newMintInfo.mint;

    if (await hasBeenPurchased(newMint)) return;

    const metadata = await getTokenMetadata(newMint);
    if (!metadata) {
      await logEvent(
        "WARN",
        `Could not fetch metadata for ${newMint}. Skipping.`
      );
      return;
    }

    if (isBlacklisted(metadata.name, metadata.symbol)) {
      await logEvent(
        "WARN",
        `Skipping blacklisted token: ${metadata.name} (${metadata.symbol})`
      );
      return;
    }

    await logEvent(
      "INFO",
      `New token found: ${metadata.name} (${metadata.symbol}) | Mint: ${newMint}`
    );
    const rugCheckReport = await checkRug(newMint);
    if (!rugCheckReport) {
      await logEvent("WARN", `Vetting failed for ${newMint}. Skipping.`);
      return;
    }

    const decision = await shouldBuyToken(metadata, rugCheckReport);
    if (decision) {
      await buyToken(newMint, rugCheckReport.risk.level);
    } else {
      await logEvent(
        "INFO",
        `Decision: PASS on ${metadata.symbol} based on AI recommendation.`
      );
    }
  } catch (error) {
    await logEvent("ERROR", "Error processing new pool signature:", { error });
  }
}

function startConsoleTimer() {
  let countdown = 60;
  setInterval(() => {
    const seconds = countdown % 60;
    process.stdout.write(
      chalk.yellow(
        `Monitoring for new pools... Next portfolio check in ${seconds
          .toString()
          .padStart(2, "0")}s \r`
      )
    );
    countdown--;
    if (countdown < 0) countdown = 60;
  }, 1000);
}

async function monitorNewPools() {
  await logEvent(
    "INFO",
    "Starting real-time log monitoring for new Raydium liquidity pools..."
  );
  connection.onLogs(
    new PublicKey(RAYDIUM_LIQUIDITY_POOL_V4),
    async ({ logs, signature }) => {
      process.stdout.write("\r" + " ".repeat(process.stdout.columns) + "\r");
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
        await processNewLiquidityPool(tx);
      } catch (error) {
        await logEvent("ERROR", "Failed to get parsed transaction", {
          signature,
          error,
        });
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
      "      🤖 Advanced Solana AI Trading Bot Initialized 🤖      "
    )
  );
  console.log(
    chalk.bold.magenta("====================================================")
  );
  await logEvent(
    "INFO",
    `Wallet Public Key: ${WALLET_KEYPAIR.publicKey.toBase58()}`
  );

  startConsoleTimer();
  monitorNewPools();
  setInterval(() => {
    process.stdout.write("\r" + " ".repeat(process.stdout.columns) + "\r");
    logEvent("INFO", "Performing scheduled portfolio check...");
    monitorPortfolio();
  }, 60000); // Check every 1 minute
}

main();
