import { Connection, PublicKey } from "@solana/web3.js";
import {
  RAYDIUM_LIQUIDITY_POOL_V4,
  RPC_URL,
  WALLET_KEYPAIR,
  MIN_LIQUIDITY_SOL,
  MAX_PORTFOLIO_SIZE,
  SOL_MINT,
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
import chalk from "chalk";
import express from "express"; // Import express

const app = express();

const seenSignatures = new Set();
const connection = new Connection(RPC_URL, "confirmed");

async function processNewLiquidityPool(transaction) {
  try {
    if (getPortfolioSize() >= MAX_PORTFOLIO_SIZE) {
      return; // Quietly skip if portfolio is full
    }

    if (!transaction || !transaction.meta) return;

    const quoteTokenBalanceChange = transaction.meta.postTokenBalances.find(
      (tb) =>
        tb.mint === SOL_MINT &&
        tb.owner === "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
    );
    const initialLiquiditySol = quoteTokenBalanceChange
      ? quoteTokenBalanceChange.uiTokenAmount.uiAmount
      : 0;
    if (initialLiquiditySol < MIN_LIQUIDITY_SOL) {
      return;
    }

    const newMintInfo = transaction.meta.postTokenBalances.find(
      (tb) =>
        tb.mint !== SOL_MINT &&
        tb.owner === "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
    );
    if (!newMintInfo) return;
    const newMint = newMintInfo.mint;

    if (await hasBeenPurchased(newMint)) return;

    const metadata = await getTokenMetadata(newMint);
    if (!metadata) return;

    if (isBlacklisted(metadata.name, metadata.symbol)) {
      await logEvent(
        "WARN",
        `Skipping blacklisted token: ${metadata.name} (${metadata.symbol})`
      );
      return;
    }

    await logEvent(
      "INFO",
      `New token passed liquidity check: ${metadata.name} (${metadata.symbol})`,
      { initialLiquiditySol }
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
    await logEvent("ERROR", "Error processing new pool signature:", {
      error: error.message,
      stack: error.stack,
    });
  }
}

async function monitorNewPools() {
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

function startHealthCheckServer() {
  app.get("/health", (req, res) => {
    // You can add more sophisticated health checks here,
    // e.g., check database connection, RPC connection, etc.
    res.status(200).send("OK");
  });

  app.listen(HEALTH_CHECK_PORT, () => {
    console.log(
      chalk.bold.cyan(
        `Health check server listening on port ${HEALTH_CHECK_PORT}`
      )
    );
    logEvent(
      "INFO",
      `Health check server started on port ${HEALTH_CHECK_PORT}`
    );
  });
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
  startHealthCheckServer();

  monitorNewPools();
  setInterval(() => {
    logEvent("INFO", "Performing scheduled portfolio check...");
    monitorPortfolio();
  }, 60000); // Check every 1 minute
}

main();
