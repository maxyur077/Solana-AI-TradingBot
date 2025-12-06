import { Connection, PublicKey } from "@solana/web3.js";
import { logEvent } from "./databaseService.js";
import {
  hasProcessedSignature,
  markSignatureProcessed,
} from "./webhookService.js";

/**
 * Meteora Program IDs for different pool types
 * These are the official Meteora program addresses on Solana mainnet
 */
export const METEORA_PROGRAMS = {
  // DLMM - Dynamic Liquidity Market Maker (most common for new meme coins)
  DLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",

  // DAMM v2 - Dynamic AMM v2 (CP-AMM, newer)
  DAMM_V2: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",

  // DAMM v1 - Dynamic AMM v1 (legacy)
  DAMM_V1: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",

  // Dynamic Bonding Curve (for token launches)
  DBC: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
};

/**
 * Pool initialization instruction identifiers
 * These log strings indicate a new pool is being created
 */
const POOL_INIT_INDICATORS = {
  DLMM: ["initializeLbPair", "InitializeLbPair", "initialize_lb_pair"],
  DAMM_V2: ["initializePool", "InitializePool", "initialize_pool", "createPool", "CreatePool"],
  DAMM_V1: ["initialize", "Initialize"],
  DBC: ["initializeBondingCurve", "InitializeBondingCurve", "createPool"],
};

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Tokens/names to filter out (internal Meteora tokens, not tradeable)
const FILTERED_TOKEN_NAMES = [
  "meteora position nft",
  "meteora position",
  "position nft",
  "lp token",
  "liquidity token",
  "pool token",
];

const FILTERED_TOKEN_SYMBOLS = [
  "MPN",      // Meteora Position NFT
  "LP",       // LP tokens
  "MET-LP",   // Meteora LP
];

// Store active subscriptions
const activeSubscriptions = new Map();

/**
 * Check if a token should be filtered out (internal Meteora tokens)
 * @param {string} name - Token name
 * @param {string} symbol - Token symbol
 * @returns {boolean} - True if should be filtered out
 */
export function shouldFilterMeteoraToken(name, symbol) {
  const nameLower = (name || "").toLowerCase();
  const symbolUpper = (symbol || "").toUpperCase();

  // Check filtered names
  for (const filtered of FILTERED_TOKEN_NAMES) {
    if (nameLower.includes(filtered)) {
      return true;
    }
  }

  // Check filtered symbols
  if (FILTERED_TOKEN_SYMBOLS.includes(symbolUpper)) {
    return true;
  }

  return false;
}

/**
 * Extract mint address and pool address from Meteora transaction
 * @param {Object} transaction - Parsed transaction
 * @param {string} programType - Type of Meteora program (DLMM, DAMM_V2, etc.)
 * @returns {Object|null} - {mintAddress, poolAddress} or null
 */
function extractInfoFromMeteoraTransaction(transaction, programType) {
  try {
    if (!transaction || !transaction.meta) return null;

    let mintAddress = null;
    let poolAddress = null;

    // Common tokens to exclude
    const commonTokens = [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    ];

    // Method 1: Check postTokenBalances for new token mint
    if (transaction.meta.postTokenBalances) {
      for (const balance of transaction.meta.postTokenBalances) {
        if (balance.mint && balance.mint !== SOL_MINT && !commonTokens.includes(balance.mint)) {
          mintAddress = balance.mint;
          break;
        }
      }
    }

    // Method 2: Parse inner instructions for token mints
    if (!mintAddress && transaction.meta.innerInstructions) {
      for (const inner of transaction.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          if (ix.parsed && ix.parsed.info && ix.parsed.info.mint) {
            if (ix.parsed.info.mint !== SOL_MINT && !commonTokens.includes(ix.parsed.info.mint)) {
              mintAddress = ix.parsed.info.mint;
              break;
            }
          }
        }
        if (mintAddress) break;
      }
    }

    // Extract pool address from account keys
    // For DAMM v2, the pool is typically one of the first writable accounts
    if (transaction.transaction && transaction.transaction.message) {
      const accountKeys = transaction.transaction.message.accountKeys;
      const programId = METEORA_PROGRAMS[programType];

      if (accountKeys) {
        // Find accounts that are writable and not the program or common addresses
        for (let i = 0; i < accountKeys.length; i++) {
          const key = accountKeys[i];
          const address = key.pubkey ? key.pubkey.toString() : key.toString();
          const isWritable = key.writable !== undefined ? key.writable : (i < 3); // First few accounts are usually writable
          const isSigner = key.signer !== undefined ? key.signer : false;

          // Skip known addresses
          if (
            address === SOL_MINT ||
            address === programId ||
            address === "11111111111111111111111111111111" || // System program
            address === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || // Token program
            address === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" || // ATA program
            address === "SysvarRent111111111111111111111111111111111" || // Rent sysvar
            Object.values(METEORA_PROGRAMS).includes(address)
          ) {
            continue;
          }

          // The pool address is typically a writable non-signer account
          // It's usually created in the transaction (new account)
          if (isWritable && !isSigner && address.length >= 32 && address.length <= 44) {
            // For DAMM v2, pool is usually the first or second writable account after payer
            poolAddress = address;
            break;
          }
        }
      }
    }

    if (mintAddress) {
      return { mintAddress, poolAddress };
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Check if transaction logs indicate pool creation
 * @param {string[]} logs - Transaction logs
 * @param {string} programType - Type of Meteora program
 * @returns {boolean}
 */
function isPoolCreationTransaction(logs, programType) {
  if (!logs || !Array.isArray(logs)) return false;

  const indicators = POOL_INIT_INDICATORS[programType] || [];

  return logs.some((log) => {
    const logLower = log.toLowerCase();
    return indicators.some((indicator) =>
      logLower.includes(indicator.toLowerCase())
    );
  });
}

/**
 * Start monitoring Meteora programs for new pool creation
 * @param {Connection} connection - Solana connection
 * @param {Function} onNewPool - Callback (signature, mintAddress, transaction, programType)
 * @param {string[]} programTypes - Which Meteora programs to monitor (default: all)
 */
export async function startMeteoraMonitoring(
  connection,
  onNewPool,
  programTypes = ["DLMM", "DAMM_V2"]
) {
  await logEvent("INFO", `Starting Meteora monitoring for: ${programTypes.join(", ")}`);

  for (const programType of programTypes) {
    const programId = METEORA_PROGRAMS[programType];

    if (!programId) {
      await logEvent("WARN", `Unknown Meteora program type: ${programType}`);
      continue;
    }

    try {
      const subscriptionId = connection.onLogs(
        new PublicKey(programId),
        async ({ logs, signature, err }) => {
          // Skip failed transactions
          if (err) return;

          // Check if this is a pool creation transaction
          if (!isPoolCreationTransaction(logs, programType)) return;

          // Skip if already processed
          if (hasProcessedSignature(signature)) return;

          // Mark as processed immediately
          markSignatureProcessed(signature);

          await logEvent("INFO", `[METEORA-${programType}] New pool detected`, { signature });

          try {
            // Fetch full transaction details
            const tx = await connection.getParsedTransaction(signature, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            });

            const info = extractInfoFromMeteoraTransaction(tx, programType);

            if (info && info.mintAddress) {
              await logEvent("INFO", `[METEORA-${programType}] Token mint: ${info.mintAddress}`, {
                poolAddress: info.poolAddress || "unknown"
              });
              // Pass pool address as 5th parameter
              await onNewPool(signature, info.mintAddress, tx, programType, info.poolAddress);
            } else {
              await logEvent("WARN", `[METEORA-${programType}] Could not extract mint from transaction`);
            }
          } catch (txError) {
            await logEvent("WARN", `[METEORA-${programType}] Failed to fetch transaction`, {
              signature,
              error: txError.message,
            });
          }
        },
        "processed" // Use 'processed' for faster detection
      );

      activeSubscriptions.set(programType, subscriptionId);
      await logEvent("SUCCESS", `Subscribed to Meteora ${programType}: ${programId}`);
    } catch (error) {
      await logEvent("ERROR", `Failed to subscribe to Meteora ${programType}`, {
        error: error.message,
      });
    }
  }
}

/**
 * Stop all Meteora monitoring
 * @param {Connection} connection - Solana connection
 */
export async function stopMeteoraMonitoring(connection) {
  for (const [programType, subscriptionId] of activeSubscriptions) {
    try {
      await connection.removeOnLogsListener(subscriptionId);
      await logEvent("INFO", `Unsubscribed from Meteora ${programType}`);
    } catch (error) {
      // Ignore cleanup errors
    }
  }
  activeSubscriptions.clear();
}

/**
 * Get list of active Meteora subscriptions
 * @returns {string[]} - List of active program types
 */
export function getActiveMeteoraSubscriptions() {
  return Array.from(activeSubscriptions.keys());
}

/**
 * Check if a specific Meteora program is being monitored
 * @param {string} programType - Program type to check
 * @returns {boolean}
 */
export function isMonitoringMeteora(programType) {
  return activeSubscriptions.has(programType);
}

/**
 * Get all Meteora program IDs as an array
 * @returns {string[]}
 */
export function getAllMeteoraProgramIds() {
  return Object.values(METEORA_PROGRAMS);
}

/**
 * Identify which Meteora program a transaction belongs to
 * @param {string} programId - Program ID from transaction
 * @returns {string|null} - Program type or null
 */
export function identifyMeteoraProgram(programId) {
  for (const [type, id] of Object.entries(METEORA_PROGRAMS)) {
    if (id === programId) return type;
  }
  return null;
}
