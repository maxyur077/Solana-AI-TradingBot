import dotenv from "dotenv";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import chalk from "chalk";

dotenv.config();

function loadEnvVariable(key, isSecret = false) {
  const value = process.env[key];
  if (!value) {
    console.error(
      chalk.red.bold(`Error: Missing required environment variable ${key}.`)
    );
    process.exit(1);
  }
  return value;
}

// API and Wallet Keys
export const GEMINI_API_KEY = loadEnvVariable("GEMINI_API_KEY", true);
export const RPC_URL = loadEnvVariable("RPC_URL");
const privateKeyStr = loadEnvVariable("PRIVATE_KEY", true);
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

// Portfolio Management
export const MAX_PORTFOLIO_SIZE = parseInt(
  loadEnvVariable("MAX_PORTFOLIO_SIZE"),
  10
);

// Vetting Strategy
export const MAX_HOLDER_CONCENTRATION_PERCENT = parseFloat(
  loadEnvVariable("MAX_HOLDER_CONCENTRATION_PERCENT")
);

// Trade Sizing Strategy
export const TRADE_AMOUNTS = {
  GOOD: parseFloat(loadEnvVariable("TRADE_AMOUNT_SOL_GOOD")),
  WARNING: parseFloat(loadEnvVariable("TRADE_AMOUNT_SOL_WARNING")),
  DANGER: parseFloat(loadEnvVariable("TRADE_AMOUNT_SOL_DANGER")),
};
export const JUPITER_PRE_QUOTE_DELAY_MS =
  parseInt(loadEnvVariable("JUPITER_PRE_QUOTE_DELAY_MS"), 10) || 0;
// Slippage
export const SLIPPAGE_BPS = parseInt(loadEnvVariable("SLIPPAGE_BPS"), 10);

// Risk Management Strategy
export const TRAILING_STOP_LOSS_PERCENT = parseFloat(
  loadEnvVariable("TRAILING_STOP_LOSS_PERCENT")
);
export const STALE_DANGER_COIN_MINUTES = parseInt(
  loadEnvVariable("STALE_DANGER_COIN_MINUTES"),
  10
);
export const MIN_LIQUIDITY_USD = parseFloat(
  loadEnvVariable("MIN_LIQUIDITY_USD")
);
export const MIN_MARKET_CAP_USD = parseFloat(
  loadEnvVariable("MIN_MARKET_CAP_USD")
);
export const DEEP_LOSS_PERCENT_DANGER = parseFloat(
  loadEnvVariable("DEEP_LOSS_PERCENT_DANGER")
);

export const GLOBAL_STOP_LOSS_USD = parseFloat(
  loadEnvVariable("GLOBAL_STOP_LOSS_USD")
);

// Take Profit Strategies
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
export const MIN_SOL_BALANCE = parseFloat(loadEnvVariable("MIN_SOL_BALANCE"));
export const MAX_LIQUIDITY_USD = parseFloat(
  loadEnvVariable("MAX_LIQUIDITY_USD")
);
// Static Solana Addresses
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const RAYDIUM_LIQUIDITY_POOL_V4 =
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
