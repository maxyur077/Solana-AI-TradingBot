import { Connection, PublicKey } from "@solana/web3.js";
import {
  RAYDIUM_LIQUIDITY_POOL_V4,
  RPC_URL,
  WALLET_KEYPAIR,
  MAX_PORTFOLIO_SIZE,
  SOL_MINT,
  GLOBAL_STOP_LOSS_USD,
  HELIUS_API_KEY,
  ADDITIONAL_RPC_URLS,
  WEBHOOK_ENABLED,
  WEBHOOK_PATH,
  DETECTION_MODE,
  MONITORED_DEXES,
} from "./config.js";
import { shouldBuyToken } from "./services/geminiService.js";
import {
  buyToken,
  monitorPortfolio,
  getPortfolioSize,
  getTotalPnlUsd,
  getPortfolio,
  startRealtimeMonitoringForAllPositions,
} from "./services/tradeService.js";
import { initTrailingStopService } from "./services/realtimeTrailingStopService.js";
import { getTokenMetadata, checkRug } from "./services/vettingService.js";
import {
  initDb,
  logEvent,
  hasBeenPurchased,
  loadActiveTrades,
} from "./services/databaseService.js";
import { loadBlacklist, isBlacklisted } from "./services/blacklistService.js";
import { sendStartupNotification } from "./services/telegramService.js";
import {
  setupWebhookReceiver,
  setNewPoolCallback,
  hasProcessedSignature,
  markSignatureProcessed,
} from "./services/webhookService.js";
import {
  startMultiRpcMonitoring,
  getRpcHealthStatus,
} from "./services/multiRpcService.js";
import {
  startMeteoraMonitoring,
  getActiveMeteoraSubscriptions,
  shouldFilterMeteoraToken,
} from "./services/meteoraService.js";
import chalk from "chalk";
import express from "express";

const app = express();
const connection = new Connection(RPC_URL, {
  commitment: "processed", // Faster than "confirmed"
  wsEndpoint: RPC_URL.replace("https://", "wss://").replace("http://", "ws://"),
});

// Helper sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Process a new liquidity pool - called from any DEX monitor
 * @param {string} signature - Transaction signature
 * @param {string} mintAddress - Token mint address
 * @param {Object} transaction - Full transaction object (optional)
 * @param {string} source - Source DEX (raydium, meteora-dlmm, etc.)
 * @param {string} poolAddress - Pool address for direct swaps (optional)
 */
async function processNewPool(signature, mintAddress, transaction = null, source = "unknown", poolAddress = null) {
  try {
    // Check portfolio capacity
    if (getPortfolioSize() >= MAX_PORTFOLIO_SIZE) {
      await logEvent("INFO", `Portfolio full (${getPortfolioSize()}/${MAX_PORTFOLIO_SIZE}). Skipping new token.`);
      return;
    }

    // Skip if already purchased
    if (await hasBeenPurchased(mintAddress)) {
      return;
    }

    // Get token metadata
    const metadata = await getTokenMetadata(mintAddress);
    if (!metadata) {
      await logEvent("WARN", `Could not fetch metadata for ${mintAddress}. Skipping.`);
      return;
    }

    // Filter out Meteora internal tokens (Position NFTs, LP tokens, etc.)
    if (source.startsWith("meteora") && shouldFilterMeteoraToken(metadata.name, metadata.symbol)) {
      await logEvent("INFO", `Filtering Meteora internal token: ${metadata.name} (${metadata.symbol})`);
      return;
    }

    // Check blacklist
    if (isBlacklisted(metadata.name, metadata.symbol)) {
      await logEvent("WARN", `Skipping blacklisted token: ${metadata.name} (${metadata.symbol})`);
      return;
    }

    await logEvent(
      "INFO",
      `[${source.toUpperCase()}] New token: ${metadata.name} (${metadata.symbol}) | Mint: ${mintAddress}`
    );

    // Perform vetting
    const rugCheckReport = await checkRug(mintAddress);
    if (!rugCheckReport) {
      await logEvent("WARN", `Vetting failed for ${mintAddress}. Skipping.`);
      return;
    }

    // Buy the token - pass poolAddress and source DEX
    // Meteora tokens will be bought/sold directly on Meteora (not Jupiter)
    await buyToken(mintAddress, rugCheckReport.risk.level, metadata, poolAddress, source);
  } catch (error) {
    await logEvent("ERROR", `Error processing new pool from ${source}:`, {
      signature,
      mintAddress,
      error: error.message,
    });
  }
}

/**
 * Process transaction from onLogs (legacy method for Raydium)
 * @param {Object} transaction - Parsed transaction
 */
async function processNewLiquidityPool(transaction) {
  try {
    if (getPortfolioSize() >= MAX_PORTFOLIO_SIZE) {
      return;
    }

    if (!transaction || !transaction.meta || !transaction.meta.postTokenBalances) {
      return;
    }

    const postTokenBalances = transaction.meta.postTokenBalances;
    const newMintInfo = postTokenBalances.find(
      (tb) =>
        tb.mint !== SOL_MINT &&
        tb.owner === "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
    );

    if (!newMintInfo) return;

    const newMint = newMintInfo.mint;

    // Use the unified processNewPool function
    await processNewPool(null, newMint, transaction, "raydium");
  } catch (error) {
    await logEvent("ERROR", "Error processing Raydium pool:", { error: error.message });
  }
}

/**
 * Legacy onLogs monitoring for Raydium (backup method)
 */
async function monitorRaydiumLegacy() {
  await logEvent("INFO", "Starting Raydium onLogs monitoring...");

  connection.onLogs(
    new PublicKey(RAYDIUM_LIQUIDITY_POOL_V4),
    async ({ logs, signature, err }) => {
      // Skip errors
      if (err) return;

      // Only process pool initialization
      if (!logs.some((log) => log.includes("initialize2"))) return;

      // Skip if already processed
      if (hasProcessedSignature(signature)) return;

      markSignatureProcessed(signature);

      try {
        const tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        await processNewLiquidityPool(tx);
      } catch (error) {
        await logEvent("ERROR", "Failed to get Raydium transaction", {
          signature,
          error: error.message,
        });
      }
    },
    "processed"
  );
}

/**
 * Start Meteora monitoring based on configured DEXes
 */
async function startMeteoraMonitors() {
  const meteoraTypes = [];

  if (MONITORED_DEXES.includes("meteora-dlmm")) {
    meteoraTypes.push("DLMM");
  }
  if (MONITORED_DEXES.includes("meteora-damm-v2")) {
    meteoraTypes.push("DAMM_V2");
  }
  if (MONITORED_DEXES.includes("meteora-damm-v1")) {
    meteoraTypes.push("DAMM_V1");
  }
  if (MONITORED_DEXES.includes("meteora-dbc")) {
    meteoraTypes.push("DBC");
  }

  if (meteoraTypes.length > 0) {
    await startMeteoraMonitoring(
      connection,
      async (signature, mintAddress, tx, programType, poolAddress) => {
        await processNewPool(signature, mintAddress, tx, `meteora-${programType.toLowerCase()}`, poolAddress);
      },
      meteoraTypes
    );
  }
}

/**
 * Start pool monitoring based on configured detection mode and DEXes
 */
async function startPoolMonitoring() {
  const mode = DETECTION_MODE.toLowerCase();

  await logEvent("INFO", `Starting pool monitoring in ${mode.toUpperCase()} mode`);
  await logEvent("INFO", `Monitoring DEXes: ${MONITORED_DEXES.join(", ")}`);

  // Start Raydium monitoring if enabled
  const monitorRaydium = MONITORED_DEXES.includes("raydium");

  switch (mode) {
    case "hybrid":
      // Both webhook and multi-RPC for maximum coverage
      if (WEBHOOK_ENABLED) {
        setupWebhookReceiver(app, WEBHOOK_PATH);
        setNewPoolCallback(async (signature, mintAddress, tx) => {
          await processNewPool(signature, mintAddress, tx, "webhook");
        });
        await logEvent("INFO", "Webhook receiver enabled (hybrid mode)");
      }

      // Start multi-RPC monitoring for Raydium
      if (monitorRaydium) {
        const hybridRpcs = [RPC_URL, ...ADDITIONAL_RPC_URLS].filter(Boolean);
        await startMultiRpcMonitoring(hybridRpcs, async (signature, mintAddress, tx) => {
          await processNewPool(signature, mintAddress, tx, "raydium");
        });
      }

      // Start Meteora monitoring
      await startMeteoraMonitors();
      break;

    case "webhook":
      // Webhook only
      if (!WEBHOOK_ENABLED) {
        await logEvent("ERROR", "Webhook mode selected but WEBHOOK_ENABLED is false");
        process.exit(1);
      }
      setupWebhookReceiver(app, WEBHOOK_PATH);
      setNewPoolCallback(async (signature, mintAddress, tx) => {
        await processNewPool(signature, mintAddress, tx, "webhook");
      });
      await logEvent("INFO", "Webhook-only mode enabled");
      break;

    case "multi-rpc":
      // Multi-RPC parallel monitoring (default, best free option)
      if (monitorRaydium) {
        const rpcUrls = [RPC_URL, ...ADDITIONAL_RPC_URLS].filter(Boolean);

        if (rpcUrls.length === 1) {
          await logEvent("INFO", "Single RPC mode (add ADDITIONAL_RPC_URLS for redundancy)");
        } else {
          await logEvent("INFO", `Multi-RPC mode with ${rpcUrls.length} endpoints`);
        }

        await startMultiRpcMonitoring(rpcUrls, async (signature, mintAddress, tx) => {
          await processNewPool(signature, mintAddress, tx, "raydium");
        });
      }

      // Start Meteora monitoring
      await startMeteoraMonitors();
      break;

    case "onlogs":
    default:
      // Legacy single RPC onLogs
      if (monitorRaydium) {
        await monitorRaydiumLegacy();
      }

      // Start Meteora monitoring
      await startMeteoraMonitors();
      break;
  }
}

/**
 * Start the Express server for health checks and webhook
 */
function startServer() {
  // Health check endpoint
  app.get("/health", async (req, res) => {
    const rpcHealth = await getRpcHealthStatus();
    const meteoraSubs = getActiveMeteoraSubscriptions();
    res.status(200).json({
      status: "OK",
      portfolioSize: getPortfolioSize(),
      totalPnlUsd: getTotalPnlUsd().toFixed(4),
      detectionMode: DETECTION_MODE,
      monitoredDexes: MONITORED_DEXES,
      meteoraSubscriptions: meteoraSubs,
      rpcConnections: rpcHealth,
    });
  });

  // RPC status endpoint
  app.get("/rpc-status", async (req, res) => {
    const status = await getRpcHealthStatus();
    res.status(200).json(status);
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    logEvent("INFO", `Server started on port ${port}`);
    logEvent("INFO", `Health check: http://localhost:${port}/health`);
    if (WEBHOOK_ENABLED) {
      logEvent("INFO", `Webhook endpoint: http://localhost:${port}${WEBHOOK_PATH}`);
    }
  });
}

/**
 * Main entry point
 */
async function main() {
  // Initialize database
  await initDb();
  await loadBlacklist();

  // Initialize real-time trailing stop-loss service
  await initTrailingStopService();

  // Load active trades from database
  const activeTrades = await loadActiveTrades();
  const portfolio = getPortfolio();

  for (const trade of activeTrades) {
    portfolio.set(trade.mint_address, {
      purchasePrice: trade.token_price_in_sol,
      amount: 0,
      tradeAmountSol: trade.sol_amount,
      riskLevel: "UNKNOWN",
      profitTakenLevels: [],
      purchaseTimestamp: new Date(trade.timestamp).getTime(),
      highestPriceSeen: trade.token_price_in_sol,
      buySignature: trade.signature,
    });
  }

  await logEvent(
    "INFO",
    `Loaded ${portfolio.size} active/failed trades from database.`
  );

  // Start real-time monitoring for restored positions
  if (portfolio.size > 0) {
    startRealtimeMonitoringForAllPositions();
    await logEvent(
      "INFO",
      `Started real-time trailing stop monitoring for ${portfolio.size} restored positions.`
    );
  }

  // Display startup banner
  console.log(chalk.bold.magenta("===================================================="));
  console.log(chalk.bold.magenta("   🤖 Advanced Solana AI Trading Bot Initialized 🤖  "));
  console.log(chalk.bold.magenta("===================================================="));
  console.log(chalk.cyan(`   Detection Mode: ${DETECTION_MODE.toUpperCase()}`));
  console.log(chalk.cyan(`   Monitored DEXes: ${MONITORED_DEXES.join(", ")}`));
  console.log(chalk.cyan(`   Primary RPC: ${RPC_URL.substring(0, 50)}...`));
  if (ADDITIONAL_RPC_URLS.length > 0) {
    console.log(chalk.cyan(`   Additional RPCs: ${ADDITIONAL_RPC_URLS.length}`));
  }
  if (WEBHOOK_ENABLED) {
    console.log(chalk.cyan(`   Webhook: ENABLED at ${WEBHOOK_PATH}`));
  }
  console.log(chalk.bold.magenta("===================================================="));

  await logEvent("INFO", `Wallet: ${WALLET_KEYPAIR.publicKey.toBase58()}`);
  await sendStartupNotification(WALLET_KEYPAIR.publicKey.toBase58());

  // Start server (for health checks and webhook)
  startServer();

  // Start pool monitoring based on configured mode
  await startPoolMonitoring();

  // Portfolio monitoring interval
  setInterval(async () => {
    await logEvent("INFO", "Performing scheduled portfolio check...");
    await monitorPortfolio();

    const currentPnl = getTotalPnlUsd();
    if (currentPnl <= GLOBAL_STOP_LOSS_USD) {
      await logEvent(
        "ERROR",
        "GLOBAL STOP-LOSS TRIGGERED! Shutting down bot.",
        { totalPnlUsd: currentPnl }
      );
      process.exit(1);
    }
  }, 30000);
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  await logEvent("INFO", "Shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await logEvent("INFO", "Shutting down gracefully...");
  process.exit(0);
});

main();
