import sqlite3 from "sqlite3";
import { open } from "sqlite";
import chalk from "chalk";

let db;

const TRADE_TABLE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        mint_address TEXT NOT NULL,
        trade_type TEXT NOT NULL,
        sol_amount REAL NOT NULL,
        token_price_in_sol REAL NOT NULL,
        transaction_fee_sol REAL,
        signature TEXT,
        status TEXT NOT NULL DEFAULT 'BOUGHT' -- BOUGHT, SOLD, SELL_FAILED
    );
`;

const PURCHASED_TOKENS_SCHEMA = `
    CREATE TABLE IF NOT EXISTS purchased_tokens (
        mint_address TEXT PRIMARY KEY NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`;

const LOG_TABLE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS app_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        total_pnl_usd REAL
    );
`;

export async function initDb() {
  try {
    db = await open({ filename: "./trading_bot.db", driver: sqlite3.Database });
    await db.exec(TRADE_TABLE_SCHEMA);
    await db.exec(LOG_TABLE_SCHEMA);
    await db.exec(PURCHASED_TOKENS_SCHEMA);

    const tradesInfo = await db.all("PRAGMA table_info(trades);");
    if (!tradesInfo.some((col) => col.name === "transaction_fee_sol")) {
      await db.exec("ALTER TABLE trades ADD COLUMN transaction_fee_sol REAL;");
    }
    if (!tradesInfo.some((col) => col.name === "status")) {
      await db.exec(
        "ALTER TABLE trades ADD COLUMN status TEXT NOT NULL DEFAULT 'BOUGHT';"
      );
    }

    const logsInfo = await db.all("PRAGMA table_info(app_logs);");
    if (!logsInfo.some((col) => col.name === "total_pnl_usd")) {
      await db.exec("ALTER TABLE app_logs ADD COLUMN total_pnl_usd REAL;");
    }

    console.log(chalk.green.bold("Database initialized successfully."));
  } catch (error) {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  }
}

export async function logEvent(
  level,
  message,
  details = null,
  totalPnlUsd = null
) {
  const pnlString =
    totalPnlUsd !== null ? ` | Total PnL: $${totalPnlUsd.toFixed(4)}` : "";
  const detailsString = details ? `\n${JSON.stringify(details, null, 2)}` : "";

  switch (level) {
    case "INFO":
      console.log(chalk.cyan(`[INFO] ${message}${pnlString}`), detailsString);
      break;
    case "SUCCESS":
      console.log(
        chalk.green.bold(`[SUCCESS] ${message}${pnlString}`),
        detailsString
      );
      break;
    case "WARN":
      console.log(
        chalk.yellow.bold(`[WARN] ${message}${pnlString}`),
        detailsString
      );
      break;
    case "ERROR":
      console.log(
        chalk.red.bold(`[ERROR] ${message}${pnlString}`),
        detailsString
      );
      break;
    default:
      console.log(`[${level}] ${message}${pnlString}`, detailsString);
  }

  const detailsJson = details ? JSON.stringify(details) : null;
  try {
    if (!db) {
      setTimeout(() => logEvent(level, message, details, totalPnlUsd), 100);
      return;
    }
    await db.run(
      "INSERT INTO app_logs (level, message, details, total_pnl_usd) VALUES (?, ?, ?, ?)",
      [level, message, detailsJson, totalPnlUsd]
    );
  } catch (error) {
    console.error("Failed to write to app_logs table:", error);
  }
}

export async function logTrade(
  tradeType,
  mint,
  solAmount,
  price,
  fee,
  signature,
  totalPnlUsd
) {
  try {
    const status = tradeType === "BUY" ? "BOUGHT" : "SOLD";
    await db.run(
      "INSERT INTO trades (trade_type, mint_address, sol_amount, token_price_in_sol, transaction_fee_sol, signature, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [tradeType, mint, solAmount, price, fee, signature, status]
    );
    await logEvent(
      "SUCCESS",
      `Logged ${tradeType} trade for mint ${mint}`,
      { fee: `${fee} SOL` },
      totalPnlUsd
    );
  } catch (error) {
    console.error("Failed to write to trades table:", error);
  }
}

export async function updateTradeStatus(signature, status) {
  try {
    await db.run("UPDATE trades SET status = ? WHERE signature = ?", [
      status,
      signature,
    ]);
    await logEvent("INFO", `Updated trade status to ${status}`, { signature });
  } catch (error) {
    await logEvent("ERROR", "Failed to update trade status", {
      error,
      signature,
    });
  }
}

export async function loadActiveTrades() {
  try {
    const activeTrades = await db.all(
      "SELECT * FROM trades WHERE status = 'BOUGHT' OR status = 'SELL_FAILED'"
    );
    return activeTrades;
  } catch (error) {
    await logEvent("ERROR", "Failed to load active trades from database", {
      error,
    });
    return [];
  }
}

export async function addPurchasedToken(mintAddress) {
  try {
    await db.run(
      "INSERT OR IGNORE INTO purchased_tokens (mint_address) VALUES (?)",
      [mintAddress]
    );
  } catch (error) {
    await logEvent(
      "ERROR",
      `Failed to add ${mintAddress} to purchased_tokens table`,
      { error }
    );
  }
}

export async function hasBeenPurchased(mintAddress) {
  try {
    const row = await db.get(
      "SELECT 1 FROM purchased_tokens WHERE mint_address = ?",
      [mintAddress]
    );
    return !!row;
  } catch (error) {
    await logEvent(
      "ERROR",
      `Failed to check purchased status for ${mintAddress}`,
      { error }
    );
    return false;
  }
}
