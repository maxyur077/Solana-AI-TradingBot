import { Connection, PublicKey } from "@solana/web3.js";
import {
  RAYDIUM_LIQUIDITY_POOL_V4,
  RPC_URL,
  WALLET_KEYPAIR,
  MIN_LIQUIDITY_SOL,
  MAX_PORTFOLIO_SIZE,
  SOL_MINT,
  HEALTH_CHECK_PORT,
  VETTING_DELAY_MS,
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
import {
  monitorBitQuery,
  bitqueryEmitter,
} from "./services/bitqueryService.js";
import chalk from "chalk";
import express from "express";
import { Mutex } from "async-mutex";

const app = express();
const seenSignatures = new Set();
const seenMints = new Set();
const connection = new Connection(RPC_URL, "confirmed");
const processingMutex = new Mutex();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processNewToken(tokenData) {
  const release = await processingMutex.acquire();
  try {
    if (getPortfolioSize() >= MAX_PORTFOLIO_SIZE) {
      return;
    }

    const { mint, source, initialLiquiditySol } = tokenData;

    if (await hasBeenPurchased(mint)) {
      return;
    }

    await logEvent("INFO", `Vetting delay for ${mint}...`);
    await sleep(VETTING_DELAY_MS);

    const metadata = await getTokenMetadata(mint);
    if (!metadata) {
      await logEvent("WARN", `Could not fetch metadata for ${mint}. Skipping.`);
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
      `Vetting token from ${source}: ${metadata.name} (${metadata.symbol})`,
      { initialLiquiditySol }
    );

    const rugCheckReport = await checkRug(mint);
    if (!rugCheckReport) {
      await logEvent("WARN", `Vetting failed for ${mint}. Skipping.`);
      return;
    }

    const decision = await shouldBuyToken(metadata, rugCheckReport);
    if (decision) {
      await buyToken(mint, rugCheckReport.risk.level);
    } else {
      await logEvent(
        "INFO",
        `Decision: PASS on ${metadata.symbol} based on AI recommendation.`
      );
    }
  } catch (error) {
    await logEvent("ERROR", "Error processing new token:", {
      tokenData,
      error: error.message,
      stack: error.stack,
    });
  } finally {
    release();
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
        if (!tx || !tx.meta) return;

        const quoteTokenBalanceChange = tx.meta.postTokenBalances.find(
          (tb) =>
            tb.mint === SOL_MINT &&
            tb.owner === "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
        );
        const initialLiquiditySol = quoteTokenBalanceChange
          ? quoteTokenBalanceChange.uiTokenAmount.uiAmount
          : 0;
        if (initialLiquiditySol < MIN_LIQUIDITY_SOL) return;

        const newMintInfo = tx.meta.postTokenBalances.find(
          (tb) =>
            tb.mint !== SOL_MINT &&
            tb.owner === "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
        );
        if (newMintInfo && !seenMints.has(newMintInfo.mint)) {
          seenMints.add(newMintInfo.mint);
          processNewToken({
            mint: newMintInfo.mint,
            source: "Raydium",
            initialLiquiditySol,
          });
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

function startHealthCheckServer() {
  app.get("/health", (req, res) => {
    res.status(200).send("OK");
  });
  app.listen(HEALTH_CHECK_PORT, () => {
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
  monitorRaydiumPools();
  monitorBitQuery();

  let isAcceptingNewTokens = true;

  // Main loop to control token acceptance
  setInterval(() => {
    if (getPortfolioSize() > 0) {
      if (isAcceptingNewTokens) {
        logEvent(
          "WARN",
          "Portfolio is active. Pausing detection of new tokens."
        );
        isAcceptingNewTokens = false;
      }
    } else {
      if (!isAcceptingNewTokens) {
        logEvent(
          "SUCCESS",
          "Portfolio is empty. Resuming detection of new tokens."
        );
        isAcceptingNewTokens = true;
      }
    }
  }, 5000); // Check every 5 seconds

  bitqueryEmitter.on("newToken", (tokenData) => {
    if (!isAcceptingNewTokens || seenMints.has(tokenData.mint)) {
      return;
    }
    seenMints.add(tokenData.mint);
    processNewToken(tokenData);
  });

  setInterval(() => {
    logEvent("INFO", "Performing scheduled portfolio check...");
    monitorPortfolio();
  }, 60000);
}

main();
