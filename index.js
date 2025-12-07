import { PublicKey } from "@solana/web3.js";
import {
  RPC_URL,
  WALLET_KEYPAIR,
  MAX_PORTFOLIO_SIZE,
  GLOBAL_STOP_LOSS_USD,
  WEBHOOK_ENABLED,
  WEBHOOK_PATH,
  DETECTION_MODE,
  MONITORED_DEXES,
  ADDITIONAL_RPC_URLS,
  METEORA_ENABLED,
  RAYDIUM_ENABLED,
  getActiveDexConfig,
} from "./config.js";
import {
  buyToken,
  monitorPortfolio,
  getPortfolioSize,
  getTotalPnlUsd,
  getPortfolio,
  startRealtimeMonitoringForAllPositions,
  setPortfolioCallbacks,
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
  initDexManager,
  subscribeToMeteora,
  unsubscribeFromMeteora,
  subscribeToRaydium,
  setMeteoraCallback,
  setRaydiumCallback,
  getSubscriptionStatus,
  getRpcHealthStatus,
} from "./services/dexManager.js";
import { shouldFilterMeteoraToken } from "./utils/helpers.js";
import chalk from "chalk";
import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

async function processNewPool(
  signature,
  mintAddress,
  transaction = null,
  source = "unknown",
  poolAddress = null
) {
  try {
    if (getPortfolioSize() >= MAX_PORTFOLIO_SIZE) {
      await logEvent(
        "INFO",
        `Portfolio full (${getPortfolioSize()}/${MAX_PORTFOLIO_SIZE}). Skipping new token.`
      );
      return;
    }

    if (await hasBeenPurchased(mintAddress)) {
      return;
    }

    const metadata = await getTokenMetadata(mintAddress);
    if (!metadata) {
      await logEvent(
        "WARN",
        `Could not fetch metadata for ${mintAddress}. Skipping.`
      );
      return;
    }

    if (
      source.startsWith("meteora") &&
      shouldFilterMeteoraToken(metadata.name, metadata.symbol)
    ) {
      await logEvent(
        "INFO",
        `Filtering Meteora internal token: ${metadata.name} (${metadata.symbol})`
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
      `[${source.toUpperCase()}] New token: ${metadata.name} (${
        metadata.symbol
      }) | Mint: ${mintAddress}`
    );

    const rugCheckReport = await checkRug(mintAddress);
    if (!rugCheckReport) {
      await logEvent("WARN", `Vetting failed for ${mintAddress}. Skipping.`);
      return;
    }

    // Pass creator address for real-time monitoring after purchase
    await buyToken(
      mintAddress,
      rugCheckReport.risk.level,
      metadata,
      poolAddress,
      source,
      rugCheckReport.creatorAddress
    );
  } catch (error) {
    await logEvent("ERROR", `Error processing new pool from ${source}:`, {
      signature,
      mintAddress,
      error: error.message,
    });
  }
}

async function handlePortfolioFull() {
  const dexConfig = getActiveDexConfig();

  if (dexConfig.meteora && METEORA_ENABLED) {
    await logEvent(
      "INFO",
      "Portfolio has 2+ coins. Unsubscribing from Meteora to focus on monitoring."
    );
    await unsubscribeFromMeteora();
  }
}

async function handlePortfolioAvailable() {
  const dexConfig = getActiveDexConfig();

  if (dexConfig.meteora && METEORA_ENABLED) {
    await logEvent("INFO", "Portfolio has space. Re-subscribing to Meteora.");
    const meteoraTypes = getMeteoraTypesFromConfig();
    await subscribeToMeteora(meteoraTypes);
  }
}

function getMeteoraTypesFromConfig() {
  const meteoraTypes = [];
  if (MONITORED_DEXES.includes("meteora-dlmm")) meteoraTypes.push("DLMM");
  if (MONITORED_DEXES.includes("meteora-damm-v2")) meteoraTypes.push("DAMM_V2");
  if (MONITORED_DEXES.includes("meteora-damm-v1")) meteoraTypes.push("DAMM_V1");
  if (MONITORED_DEXES.includes("meteora-dbc")) meteoraTypes.push("DBC");
  return meteoraTypes.length > 0 ? meteoraTypes : ["DLMM", "DAMM_V2"];
}

async function startPoolMonitoring() {
  const mode = DETECTION_MODE.toLowerCase();
  const dexConfig = getActiveDexConfig();

  await logEvent(
    "INFO",
    `Starting pool monitoring in ${mode.toUpperCase()} mode`
  );
  await logEvent("INFO", `DEX Config: ${dexConfig.mode}`);
  await logEvent(
    "INFO",
    `METEORA_ENABLED: ${METEORA_ENABLED}, RAYDIUM_ENABLED: ${RAYDIUM_ENABLED}`
  );

  initDexManager();

  setMeteoraCallback(
    async (signature, mintAddress, tx, programType, poolAddress) => {
      await processNewPool(
        signature,
        mintAddress,
        tx,
        `meteora-${programType.toLowerCase()}`,
        poolAddress
      );
    }
  );

  setRaydiumCallback(async (signature, mintAddress, tx) => {
    await processNewPool(signature, mintAddress, tx, "raydium");
  });

  const monitorRaydium =
    dexConfig.raydium && MONITORED_DEXES.includes("raydium");
  const monitorMeteora = dexConfig.meteora;

  switch (mode) {
    case "hybrid":
      if (WEBHOOK_ENABLED) {
        setupWebhookReceiver(app, WEBHOOK_PATH);
        setNewPoolCallback(async (signature, mintAddress, tx) => {
          await processNewPool(signature, mintAddress, tx, "webhook");
        });
        await logEvent("INFO", "Webhook receiver enabled (hybrid mode)");
      }

      if (monitorRaydium) {
        await subscribeToRaydium();
      }

      if (monitorMeteora) {
        const meteoraTypes = getMeteoraTypesFromConfig();
        await subscribeToMeteora(meteoraTypes);
      }
      break;

    case "webhook":
      if (!WEBHOOK_ENABLED) {
        await logEvent(
          "ERROR",
          "Webhook mode selected but WEBHOOK_ENABLED is false"
        );
        process.exit(1);
      }
      setupWebhookReceiver(app, WEBHOOK_PATH);
      setNewPoolCallback(async (signature, mintAddress, tx) => {
        await processNewPool(signature, mintAddress, tx, "webhook");
      });
      await logEvent("INFO", "Webhook-only mode enabled");
      break;

    case "multi-rpc":
    default:
      if (monitorRaydium) {
        await subscribeToRaydium();
      }

      if (monitorMeteora) {
        const meteoraTypes = getMeteoraTypesFromConfig();
        await subscribeToMeteora(meteoraTypes);
      }
      break;
  }
}

function startServer() {
  app.get("/health", async (req, res) => {
    const rpcHealth = await getRpcHealthStatus();
    const subscriptionStatus = getSubscriptionStatus();
    res.status(200).json({
      status: "OK",
      portfolioSize: getPortfolioSize(),
      totalPnlUsd: getTotalPnlUsd().toFixed(4),
      detectionMode: DETECTION_MODE,
      dexConfig: getActiveDexConfig(),
      subscriptions: subscriptionStatus,
      rpcConnections: rpcHealth,
    });
  });

  app.get("/rpc-status", async (req, res) => {
    const status = await getRpcHealthStatus();
    res.status(200).json(status);
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    logEvent("INFO", `Server started on port ${port}`);
    logEvent("INFO", `Health check: http://localhost:${port}/health`);
    if (WEBHOOK_ENABLED) {
      logEvent(
        "INFO",
        `Webhook endpoint: http://localhost:${port}${WEBHOOK_PATH}`
      );
    }
  });
}

async function main() {
  await initDb();
  await loadBlacklist();

  await initTrailingStopService();

  setPortfolioCallbacks(handlePortfolioFull, handlePortfolioAvailable);

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
      dexSource: trade.dex_source || null,
    });
  }

  await logEvent(
    "INFO",
    `Loaded ${portfolio.size} active/failed trades from database.`
  );

  if (portfolio.size > 0) {
    startRealtimeMonitoringForAllPositions();
    await logEvent(
      "INFO",
      `Started real-time trailing stop monitoring for ${portfolio.size} restored positions.`
    );
  }

  const dexConfig = getActiveDexConfig();

  console.log(
    chalk.bold.magenta("====================================================")
  );
  console.log(chalk.bold.magenta("   Solana AI Trading Bot Initialized   "));
  console.log(
    chalk.bold.magenta("====================================================")
  );
  console.log(chalk.cyan(`   Detection Mode: ${DETECTION_MODE.toUpperCase()}`));
  console.log(chalk.cyan(`   DEX Mode: ${dexConfig.mode}`));
  console.log(chalk.cyan(`   METEORA_ENABLED: ${METEORA_ENABLED}`));
  console.log(chalk.cyan(`   RAYDIUM_ENABLED: ${RAYDIUM_ENABLED}`));
  console.log(chalk.cyan(`   Primary RPC: ${RPC_URL.substring(0, 50)}...`));
  if (ADDITIONAL_RPC_URLS.length > 0) {
    console.log(
      chalk.cyan(`   Additional RPCs: ${ADDITIONAL_RPC_URLS.length}`)
    );
  }
  if (WEBHOOK_ENABLED) {
    console.log(chalk.cyan(`   Webhook: ENABLED at ${WEBHOOK_PATH}`));
  }
  console.log(
    chalk.bold.magenta("====================================================")
  );

  await logEvent("INFO", `Wallet: ${WALLET_KEYPAIR.publicKey.toBase58()}`);
  await sendStartupNotification(WALLET_KEYPAIR.publicKey.toBase58());

  startServer();

  await startPoolMonitoring();

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
  }, 15000);
}

process.on("SIGINT", async () => {
  await logEvent("INFO", "Shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await logEvent("INFO", "Shutting down gracefully...");
  process.exit(0);
});

main();
