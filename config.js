import dotenv from "dotenv";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import chalk from "chalk";

dotenv.config();

function loadEnvVariable(key, defaultValue = null, isRequired = true) {
  const value = process.env[key];
  if (!value && isRequired && defaultValue === null) {
    console.error(
      chalk.red.bold(`Error: Missing required environment variable ${key}.`)
    );
    process.exit(1);
  }
  return value || defaultValue;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  return value.toLowerCase() === "true";
}

export const RPC_URL = loadEnvVariable("RPC_URL");
export const HELIUS_API_KEY = loadEnvVariable("HELIUS_API_KEY");
export const BITQUERY_API_KEY = loadEnvVariable("BITQUERY_API_KEY");

const privateKeyStr = loadEnvVariable("PRIVATE_KEY");
let walletKeypair;
try {
  walletKeypair = Keypair.fromSecretKey(bs58.decode(privateKeyStr));
} catch (error) {
  console.error(
    chalk.red.bold(
      "Error: Invalid PRIVATE_KEY in .env file. Please ensure it is a base58 encoded string."
    )
  );
  process.exit(1);
}
export const WALLET_KEYPAIR = walletKeypair;

export const METEORA_ENABLED = parseBoolean(
  loadEnvVariable("METEORA_ENABLED", "true", false),
  true
);
export const RAYDIUM_ENABLED = parseBoolean(
  loadEnvVariable("RAYDIUM_ENABLED", "true", false),
  true
);
export const PUMPFUN_ENABLED = parseBoolean(
  loadEnvVariable("PUMPFUN_ENABLED", "true", false),
  true
);

export const MAX_PORTFOLIO_SIZE = parseInt(
  loadEnvVariable("MAX_PORTFOLIO_SIZE"),
  10
);
export const MIN_SOL_BALANCE = parseFloat(loadEnvVariable("MIN_SOL_BALANCE"));

export const MAX_HOLDER_CONCENTRATION_PERCENT = parseFloat(
  loadEnvVariable("MAX_HOLDER_CONCENTRATION_PERCENT")
);
export const MIN_LIQUIDITY_USD = parseFloat(
  loadEnvVariable("MIN_LIQUIDITY_USD")
);
export const MAX_LIQUIDITY_USD = parseFloat(
  loadEnvVariable("MAX_LIQUIDITY_USD")
);
export const MIN_MARKET_CAP_USD = parseFloat(
  loadEnvVariable("MIN_MARKET_CAP_USD")
);
export const MAX_DEV_WALLET_COUNT = parseInt(
  loadEnvVariable("MAX_DEV_WALLET_COUNT"),
  10
);
export const MAX_INITIAL_DEV_SELL_PERCENT = parseFloat(
  loadEnvVariable("MAX_INITIAL_DEV_SELL_PERCENT")
);

export const MIN_LP_LOCKED_PERCENT = parseFloat(
  loadEnvVariable("MIN_LP_LOCKED_PERCENT", "90", false)
);
export const MIN_POOL_AGE_SECONDS = parseInt(
  loadEnvVariable("MIN_POOL_AGE_SECONDS", "30", false),
  10
);
export const MAX_TOKEN_AGE_MINUTES = parseInt(
  loadEnvVariable("MAX_TOKEN_AGE_MINUTES", "4", false),
  10
);
export const MAX_TOP_HOLDER_PERCENT = parseFloat(
  loadEnvVariable("MAX_TOP_HOLDER_PERCENT", "90", false)
);
export const REQUIRE_VERIFIED_TOKEN = parseBoolean(
  loadEnvVariable("REQUIRE_VERIFIED_TOKEN", "false", false),
  false
);

// New vetting checks config
export const MAX_SINGLE_HOLDER_PERCENT = parseFloat(
  loadEnvVariable("MAX_SINGLE_HOLDER_PERCENT", "50", false)
);
export const MIN_LP_PROVIDERS = parseInt(
  loadEnvVariable("MIN_LP_PROVIDERS", "0", false),
  10
);
export const MIN_LIQUIDITY_AGE_SECONDS = parseInt(
  loadEnvVariable("MIN_LIQUIDITY_AGE_SECONDS", "5", false),
  10
);
export const MAX_BUNDLED_TX_INSTRUCTIONS = parseInt(
  loadEnvVariable("MAX_BUNDLED_TX_INSTRUCTIONS", "10", false),
  10
);
export const CHECK_CREATOR_HISTORY = parseBoolean(
  loadEnvVariable("CHECK_CREATOR_HISTORY", "true", false),
  true
);
export const MAX_CREATOR_RUGGED_TOKENS = parseInt(
  loadEnvVariable("MAX_CREATOR_RUGGED_TOKENS", "0", false),
  10
);
export const CHECK_FUNDING_SOURCE = parseBoolean(
  loadEnvVariable("CHECK_FUNDING_SOURCE", "true", false),
  true
);
export const MIN_CREATOR_SURVIVED_TOKENS = parseInt(
  loadEnvVariable("MIN_CREATOR_SURVIVED_TOKENS", "2", false),
  10
);

// RPC Rate limiting - delay between getParsedTransaction calls (milliseconds)
export const RPC_CALL_DELAY_MS = parseInt(
  loadEnvVariable("RPC_CALL_DELAY_MS", "100", false),
  10
);

export const TRADE_AMOUNTS = {
  GOOD: parseFloat(loadEnvVariable("TRADE_AMOUNT_SOL_GOOD")),
  WARNING: parseFloat(loadEnvVariable("TRADE_AMOUNT_SOL_WARNING")),
  DANGER: parseFloat(loadEnvVariable("TRADE_AMOUNT_SOL_DANGER")),
};

export const SLIPPAGE_BPS = parseInt(loadEnvVariable("SLIPPAGE_BPS"), 10);
export const JUPITER_PRE_QUOTE_DELAY_MS = parseInt(
  loadEnvVariable("JUPITER_PRE_QUOTE_DELAY_MS", "0", false),
  10
);

export const TRAILING_STOP_LOSS_PERCENT = parseFloat(
  loadEnvVariable("TRAILING_STOP_LOSS_PERCENT")
);
export const STALE_DANGER_COIN_MINUTES = parseInt(
  loadEnvVariable("STALE_DANGER_COIN_MINUTES"),
  10
);
// Time-based auto-sell for WARNING and GOOD coins
export const STALE_WARNING_COIN_MINUTES = parseInt(
  loadEnvVariable("STALE_WARNING_COIN_MINUTES", "4", false),
  10
);
export const STALE_GOOD_COIN_MINUTES = parseInt(
  loadEnvVariable("STALE_GOOD_COIN_MINUTES", "5", false),
  10
);
export const DEEP_LOSS_PERCENT_DANGER = parseFloat(
  loadEnvVariable("DEEP_LOSS_PERCENT_DANGER")
);
export const GLOBAL_STOP_LOSS_USD = parseFloat(
  loadEnvVariable("GLOBAL_STOP_LOSS_USD")
);

export const REALTIME_PRICE_POLL_INTERVAL_MS = parseInt(
  loadEnvVariable("REALTIME_PRICE_POLL_INTERVAL_MS", "2000", false),
  10
);

export const TAKE_PROFIT_PERCENT_DANGER = parseFloat(
  loadEnvVariable("TAKE_PROFIT_PERCENT_DANGER")
);
export const TAKE_PROFIT_PERCENT_WARNING = parseFloat(
  loadEnvVariable("TAKE_PROFIT_PERCENT_WARNING")
);
export const TAKE_PROFIT_GOOD_TIERS = {
  TP1: {
    PROFIT_PERCENT: parseFloat(loadEnvVariable("GOOD_TP_1_PERCENT")),
    SELL_PERCENT: parseFloat(loadEnvVariable("GOOD_TP_1_SELL_PERCENT")),
  },
  TP2: {
    PROFIT_PERCENT: parseFloat(loadEnvVariable("GOOD_TP_2_PERCENT")),
    SELL_PERCENT: parseFloat(loadEnvVariable("GOOD_TP_2_SELL_PERCENT")),
  },
  TP3: {
    PROFIT_PERCENT: parseFloat(loadEnvVariable("GOOD_TP_3_PERCENT")),
    SELL_PERCENT: parseFloat(loadEnvVariable("GOOD_TP_3_SELL_PERCENT")),
  },
};

export const CLOSE_ATA_DELAY_MS = parseInt(
  loadEnvVariable("CLOSE_ATA_DELAY_MS"),
  10
);

export {
  SOL_MINT,
  RAYDIUM_AMM_PROGRAM as RAYDIUM_LIQUIDITY_POOL_V4,
} from "./utils/constants.js";

export const TELEGRAM_BOT_TOKEN = loadEnvVariable("TELEGRAM_BOT_TOKEN");
export const TELEGRAM_CHAT_ID = loadEnvVariable("TELEGRAM_CHAT_ID");

export const ADDITIONAL_RPC_URLS = process.env.ADDITIONAL_RPC_URLS
  ? process.env.ADDITIONAL_RPC_URLS.split(",")
      .map((url) => url.trim())
      .filter(Boolean)
  : [];

export const WEBHOOK_ENABLED = parseBoolean(process.env.WEBHOOK_ENABLED, false);
export const WEBHOOK_URL = process.env.WEBHOOK_URL || null;
export const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhook";

export const DETECTION_MODE = process.env.DETECTION_MODE || "multi-rpc";

export const MONITORED_DEXES = process.env.MONITORED_DEXES
  ? process.env.MONITORED_DEXES.split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean)
  : ["raydium", "meteora-dlmm", "meteora-damm-v2"];

export function getActiveDexConfig() {
  if (METEORA_ENABLED && RAYDIUM_ENABLED) {
    return { meteora: true, raydium: true, mode: "both" };
  }
  if (METEORA_ENABLED && !RAYDIUM_ENABLED) {
    return { meteora: true, raydium: false, mode: "meteora-only" };
  }
  if (!METEORA_ENABLED && RAYDIUM_ENABLED) {
    return { meteora: false, raydium: true, mode: "raydium-only" };
  }
  return { meteora: true, raydium: false, mode: "meteora-only" };
}
