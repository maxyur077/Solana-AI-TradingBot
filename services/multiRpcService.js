import { Connection, PublicKey } from "@solana/web3.js";
import { logEvent } from "./databaseService.js";
import {
  hasProcessedSignature,
  markSignatureProcessed,
} from "./webhookService.js";

const RAYDIUM_AMM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Store active connections and subscriptions
const activeConnections = new Map();
const activeSubscriptions = new Map();

/**
 * Create connections to multiple RPC endpoints
 * @param {string[]} rpcUrls - Array of RPC URLs
 * @returns {Connection[]}
 */
export function createMultipleConnections(rpcUrls) {
  const connections = [];

  for (const url of rpcUrls) {
    try {
      // Use 'processed' for faster notifications (less confirmation wait)
      const connection = new Connection(url, {
        commitment: "processed",
        wsEndpoint: url.replace("https://", "wss://").replace("http://", "ws://"),
      });
      connections.push({ url, connection });
      activeConnections.set(url, connection);
    } catch (error) {
      logEvent("WARN", `Failed to create connection to ${url}`, { error: error.message });
    }
  }

  return connections;
}

/**
 * Extract mint address from transaction
 * @param {Object} transaction - Parsed transaction
 * @returns {string|null}
 */
function extractMintFromTransaction(transaction) {
  try {
    if (!transaction || !transaction.meta || !transaction.meta.postTokenBalances) {
      return null;
    }

    const postTokenBalances = transaction.meta.postTokenBalances;

    // Find the new token (not SOL, owned by Raydium authority)
    const newMintInfo = postTokenBalances.find(
      (tb) =>
        tb.mint !== SOL_MINT &&
        tb.owner === "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1" // Raydium authority
    );

    return newMintInfo ? newMintInfo.mint : null;
  } catch (error) {
    return null;
  }
}

/**
 * Start monitoring on multiple RPCs simultaneously
 * First response wins - prevents duplicate processing
 * @param {string[]} rpcUrls - Array of RPC URLs
 * @param {Function} onNewPool - Callback (signature, mintAddress, transaction)
 */
export async function startMultiRpcMonitoring(rpcUrls, onNewPool) {
  const connections = createMultipleConnections(rpcUrls);

  if (connections.length === 0) {
    await logEvent("ERROR", "No valid RPC connections established");
    return;
  }

  await logEvent("INFO", `Starting multi-RPC monitoring on ${connections.length} endpoints`);

  for (const { url, connection } of connections) {
    try {
      const subscriptionId = connection.onLogs(
        new PublicKey(RAYDIUM_AMM_PROGRAM),
        async ({ logs, signature, err }) => {
          // Skip failed transactions
          if (err) return;

          // Skip if not a pool initialization
          if (!logs.some((log) => log.includes("initialize2"))) return;

          // Skip if already processed by webhook or another RPC
          if (hasProcessedSignature(signature)) return;

          // Mark as processed immediately to prevent race conditions
          markSignatureProcessed(signature);

          const rpcName = url.includes("helius") ? "Helius" :
                         url.includes("quicknode") ? "QuickNode" :
                         url.includes("mainnet-beta") ? "Public" : "Custom";

          await logEvent("INFO", `[${rpcName}] New pool detected via onLogs`, { signature });

          try {
            // Fetch full transaction details
            const tx = await connection.getParsedTransaction(signature, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            });

            const mintAddress = extractMintFromTransaction(tx);

            if (mintAddress) {
              await onNewPool(signature, mintAddress, tx);
            }
          } catch (txError) {
            await logEvent("WARN", `Failed to fetch transaction ${signature}`, {
              error: txError.message,
            });
          }
        },
        "processed" // Use 'processed' for faster detection
      );

      activeSubscriptions.set(url, subscriptionId);
      await logEvent("INFO", `Subscribed to logs on ${url.substring(0, 50)}...`);
    } catch (error) {
      await logEvent("WARN", `Failed to subscribe on ${url}`, { error: error.message });
    }
  }
}

/**
 * Stop all RPC monitoring
 */
export async function stopMultiRpcMonitoring() {
  for (const [url, subscriptionId] of activeSubscriptions) {
    try {
      const connection = activeConnections.get(url);
      if (connection) {
        await connection.removeOnLogsListener(subscriptionId);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  activeSubscriptions.clear();
  activeConnections.clear();
  await logEvent("INFO", "Multi-RPC monitoring stopped");
}

/**
 * Get health status of all RPC connections
 * @returns {Promise<Object[]>}
 */
export async function getRpcHealthStatus() {
  const status = [];

  for (const [url, connection] of activeConnections) {
    try {
      const startTime = Date.now();
      await connection.getSlot();
      const latency = Date.now() - startTime;

      status.push({
        url: url.substring(0, 50) + "...",
        status: "healthy",
        latency: `${latency}ms`,
      });
    } catch (error) {
      status.push({
        url: url.substring(0, 50) + "...",
        status: "unhealthy",
        error: error.message,
      });
    }
  }

  return status;
}

/**
 * Reconnect a specific RPC if it fails
 * @param {string} url - RPC URL to reconnect
 * @param {Function} onNewPool - Callback for new pools
 */
export async function reconnectRpc(url, onNewPool) {
  // Remove old subscription
  const oldSubId = activeSubscriptions.get(url);
  if (oldSubId) {
    try {
      const oldConnection = activeConnections.get(url);
      if (oldConnection) {
        await oldConnection.removeOnLogsListener(oldSubId);
      }
    } catch (e) {
      // Ignore
    }
  }

  // Create new connection
  try {
    const connection = new Connection(url, {
      commitment: "processed",
      wsEndpoint: url.replace("https://", "wss://").replace("http://", "ws://"),
    });

    activeConnections.set(url, connection);

    const subscriptionId = connection.onLogs(
      new PublicKey(RAYDIUM_AMM_PROGRAM),
      async ({ logs, signature, err }) => {
        if (err) return;
        if (!logs.some((log) => log.includes("initialize2"))) return;
        if (hasProcessedSignature(signature)) return;

        markSignatureProcessed(signature);

        const tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });

        const mintAddress = extractMintFromTransaction(tx);
        if (mintAddress) {
          await onNewPool(signature, mintAddress, tx);
        }
      },
      "processed"
    );

    activeSubscriptions.set(url, subscriptionId);
    await logEvent("INFO", `Reconnected to ${url.substring(0, 50)}...`);
  } catch (error) {
    await logEvent("ERROR", `Failed to reconnect to ${url}`, { error: error.message });
  }
}
