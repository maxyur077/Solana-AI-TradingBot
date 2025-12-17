import { Connection, PublicKey } from "@solana/web3.js";
import { logEvent } from "./databaseService.js";
import {
  RPC_URL,
  ADDITIONAL_RPC_URLS,
  METEORA_ENABLED,
  RAYDIUM_ENABLED,
  getActiveDexConfig,
} from "../config.js";
import {
  METEORA_PROGRAMS,
  POOL_INIT_INDICATORS,
  RAYDIUM_AMM_PROGRAM,
  SOL_MINT,
  RAYDIUM_AUTHORITY,
  COMMON_TOKENS,
  SYSTEM_PROGRAMS,
} from "../utils/constants.js";
import { createWsEndpoint, getRpcName } from "../utils/helpers.js";
import {
  hasProcessedSignature,
  markSignatureProcessed,
} from "./webhookService.js";
import {
  subscribeToPumpfun as pumpfunSubscribe,
  unsubscribeFromPumpfun as pumpfunUnsubscribe,
  setPumpfunCallback,
  initPumpfunConnection,
  getPumpfunSubscriptionStatus,
  isPumpfunActive as checkPumpfunActive,
  pausePumpfunInternal,
  resumePumpfunInternal,
} from "./pumpfunService.js";

const activeRaydiumSubscriptions = new Map();
const activeMeteoraSubscriptions = new Map();
const activeConnections = new Map();

let meteoraCallback = null;
let raydiumCallback = null;
let primaryConnection = null;

let isMeteoraSubscribed = false;
let isRaydiumSubscribed = false;

let isMeteoraPaused = false;
let isRaydiumPaused = false;
let isPumpfunPaused = false;

export function initDexManager() {
  primaryConnection = new Connection(RPC_URL, {
    commitment: "processed",
    wsEndpoint: createWsEndpoint(RPC_URL),
  });
  activeConnections.set(RPC_URL, primaryConnection);
  return primaryConnection;
}

export function getPrimaryConnection() {
  if (!primaryConnection) {
    initDexManager();
  }
  return primaryConnection;
}

export function setMeteoraCallback(callback) {
  meteoraCallback = callback;
}

export function setRaydiumCallback(callback) {
  raydiumCallback = callback;
}

function extractMintFromRaydiumTransaction(transaction) {
  try {
    if (
      !transaction ||
      !transaction.meta ||
      !transaction.meta.postTokenBalances
    ) {
      return null;
    }

    const postTokenBalances = transaction.meta.postTokenBalances;

    const newMintInfo = postTokenBalances.find(
      (tb) => tb.mint !== SOL_MINT && tb.owner === RAYDIUM_AUTHORITY
    );

    return newMintInfo ? newMintInfo.mint : null;
  } catch (error) {
    return null;
  }
}

function extractInfoFromMeteoraTransaction(transaction, programType) {
  try {
    if (!transaction || !transaction.meta) return null;

    let mintAddress = null;
    let poolAddress = null;

    if (transaction.meta.postTokenBalances) {
      for (const balance of transaction.meta.postTokenBalances) {
        if (
          balance.mint &&
          balance.mint !== SOL_MINT &&
          !COMMON_TOKENS.includes(balance.mint)
        ) {
          mintAddress = balance.mint;
          break;
        }
      }
    }

    if (!mintAddress && transaction.meta.innerInstructions) {
      for (const inner of transaction.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          if (ix.parsed && ix.parsed.info && ix.parsed.info.mint) {
            if (
              ix.parsed.info.mint !== SOL_MINT &&
              !COMMON_TOKENS.includes(ix.parsed.info.mint)
            ) {
              mintAddress = ix.parsed.info.mint;
              break;
            }
          }
        }
        if (mintAddress) break;
      }
    }

    if (transaction.transaction && transaction.transaction.message) {
      const accountKeys = transaction.transaction.message.accountKeys;
      const programId = METEORA_PROGRAMS[programType];

      if (accountKeys) {
        for (let i = 0; i < accountKeys.length; i++) {
          const key = accountKeys[i];
          const address = key.pubkey ? key.pubkey.toString() : key.toString();
          const isWritable = key.writable !== undefined ? key.writable : i < 3;
          const isSigner = key.signer !== undefined ? key.signer : false;

          const excludedAddresses = [
            SOL_MINT,
            programId,
            ...SYSTEM_PROGRAMS,
            ...Object.values(METEORA_PROGRAMS),
          ];

          if (excludedAddresses.includes(address)) continue;

          if (
            isWritable &&
            !isSigner &&
            address.length >= 32 &&
            address.length <= 44
          ) {
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

export async function subscribeToMeteora(programTypes = ["DLMM", "DAMM_V2"]) {
  if (!METEORA_ENABLED) {
    await logEvent("INFO", "Meteora is disabled via config");
    return;
  }

  if (isMeteoraSubscribed) {
    await logEvent("INFO", "Meteora already subscribed");
    return;
  }

  const connection = getPrimaryConnection();

  await logEvent("INFO", `Subscribing to Meteora: ${programTypes.join(", ")}`);

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
          if (err) return;

          if (isMeteoraPaused) return;

          if (!isPoolCreationTransaction(logs, programType)) return;

          if (hasProcessedSignature(signature)) return;

          markSignatureProcessed(signature);

          await logEvent("INFO", `[METEORA-${programType}] New pool detected`, {
            signature,
          });

          try {
            const tx = await connection.getParsedTransaction(signature, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            });

            const info = extractInfoFromMeteoraTransaction(tx, programType);

            if (info && info.mintAddress && meteoraCallback) {
              await logEvent(
                "INFO",
                `[METEORA-${programType}] Token mint: ${info.mintAddress}`,
                {
                  poolAddress: info.poolAddress || "unknown",
                }
              );
              await meteoraCallback(
                signature,
                info.mintAddress,
                tx,
                programType,
                info.poolAddress
              );
            }
          } catch (txError) {
            await logEvent(
              "WARN",
              `[METEORA-${programType}] Failed to fetch transaction`,
              {
                signature,
                error: txError.message,
              }
            );
          }
        },
        "processed"
      );

      activeMeteoraSubscriptions.set(programType, subscriptionId);
      await logEvent(
        "SUCCESS",
        `Subscribed to Meteora ${programType}: ${programId}`
      );
    } catch (error) {
      await logEvent("ERROR", `Failed to subscribe to Meteora ${programType}`, {
        error: error.message,
      });
    }
  }

  isMeteoraSubscribed = activeMeteoraSubscriptions.size > 0;
}

export async function unsubscribeFromMeteora() {
  if (!isMeteoraSubscribed) return;

  const connection = getPrimaryConnection();

  for (const [programType, subscriptionId] of activeMeteoraSubscriptions) {
    try {
      await connection.removeOnLogsListener(subscriptionId);
      await logEvent("INFO", `Unsubscribed from Meteora ${programType}`);
    } catch (error) {
      await logEvent(
        "WARN",
        `Error unsubscribing from Meteora ${programType}`,
        { error: error.message }
      );
    }
  }

  activeMeteoraSubscriptions.clear();
  isMeteoraSubscribed = false;
  await logEvent("SUCCESS", "Unsubscribed from all Meteora pools");
}

export async function subscribeToRaydium() {
  if (!RAYDIUM_ENABLED) {
    await logEvent("INFO", "Raydium is disabled via config");
    return;
  }

  if (isRaydiumSubscribed) {
    await logEvent("INFO", "Raydium already subscribed");
    return;
  }

  const rpcUrls = [RPC_URL, ...ADDITIONAL_RPC_URLS].filter(Boolean);

  await logEvent(
    "INFO",
    `Subscribing to Raydium on ${rpcUrls.length} RPC endpoints`
  );

  for (const url of rpcUrls) {
    try {
      let connection = activeConnections.get(url);
      if (!connection) {
        connection = new Connection(url, {
          commitment: "processed",
          wsEndpoint: createWsEndpoint(url),
        });
        activeConnections.set(url, connection);
      }

      const subscriptionId = connection.onLogs(
        new PublicKey(RAYDIUM_AMM_PROGRAM),
        async ({ logs, signature, err }) => {
          if (err) return;

          if (isRaydiumPaused) return;

          if (!logs.some((log) => log.includes("initialize2"))) return;

          if (hasProcessedSignature(signature)) return;

          markSignatureProcessed(signature);

          const rpcName = getRpcName(url);
          await logEvent("INFO", `[${rpcName}] New Raydium pool detected`, {
            signature,
          });

          try {
            const tx = await connection.getParsedTransaction(signature, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            });

            const mintAddress = extractMintFromRaydiumTransaction(tx);

            if (mintAddress && raydiumCallback) {
              await raydiumCallback(signature, mintAddress, tx);
            }
          } catch (txError) {
            await logEvent("WARN", `Failed to fetch Raydium transaction`, {
              signature,
              error: txError.message,
            });
          }
        },
        "processed"
      );

      activeRaydiumSubscriptions.set(url, subscriptionId);
      await logEvent("SUCCESS", `Subscribed to Raydium on ${getRpcName(url)}`);
    } catch (error) {
      await logEvent("ERROR", `Failed to subscribe to Raydium on ${url}`, {
        error: error.message,
      });
    }
  }

  isRaydiumSubscribed = activeRaydiumSubscriptions.size > 0;
}

export async function unsubscribeFromRaydium() {
  if (!isRaydiumSubscribed) return;

  for (const [url, subscriptionId] of activeRaydiumSubscriptions) {
    try {
      const connection = activeConnections.get(url);
      if (connection) {
        await connection.removeOnLogsListener(subscriptionId);
      }
      await logEvent("INFO", `Unsubscribed from Raydium on ${getRpcName(url)}`);
    } catch (error) {
      await logEvent("WARN", `Error unsubscribing from Raydium`, {
        error: error.message,
      });
    }
  }

  activeRaydiumSubscriptions.clear();
  isRaydiumSubscribed = false;
  await logEvent("SUCCESS", "Unsubscribed from all Raydium pools");
}

export async function subscribeToAllDexes(meteoraTypes = ["DLMM", "DAMM_V2"]) {
  const dexConfig = getActiveDexConfig();

  await logEvent("INFO", `DEX Mode: ${dexConfig.mode}`);

  if (dexConfig.raydium) {
    await subscribeToRaydium();
  }

  if (dexConfig.meteora) {
    await subscribeToMeteora(meteoraTypes);
  }
}

export async function unsubscribeFromAllDexes() {
  await unsubscribeFromMeteora();
  await unsubscribeFromRaydium();
}

export function getSubscriptionStatus() {
  return {
    meteora: {
      enabled: METEORA_ENABLED,
      subscribed: isMeteoraSubscribed,
      subscriptions: Array.from(activeMeteoraSubscriptions.keys()),
    },
    raydium: {
      enabled: RAYDIUM_ENABLED,
      subscribed: isRaydiumSubscribed,
      subscriptions: activeRaydiumSubscriptions.size,
    },
  };
}

export function isMeteoraActive() {
  return isMeteoraSubscribed;
}

export function isRaydiumActive() {
  return isRaydiumSubscribed;
}

export function isPumpfunActive() {
  return isPumpfunSubscribed && checkPumpfunActive();
}

export async function pauseMeteora() {
  if (!isMeteoraSubscribed || isMeteoraPaused) return;
  isMeteoraPaused = true;
  await logEvent("INFO", "Meteora paused - processing current coin");
}

export async function resumeMeteora() {
  if (!isMeteoraSubscribed || !isMeteoraPaused) return;
  isMeteoraPaused = false;
  await logEvent("INFO", "Meteora resumed - listening for new coins");
}

export async function pauseRaydium() {
  if (!isRaydiumSubscribed || isRaydiumPaused) return;
  isRaydiumPaused = true;
  await logEvent("INFO", "Raydium paused - processing current coin");
}

export async function resumeRaydium() {
  if (!isRaydiumSubscribed || !isRaydiumPaused) return;
  isRaydiumPaused = false;
  await logEvent("INFO", "Raydium resumed - listening for new coins");
}

export async function pausePumpfun() {
  if (!isPumpfunSubscribed || isPumpfunPaused) return;
  isPumpfunPaused = true;
  pausePumpfunInternal();
  await logEvent("INFO", "Pumpfun paused - processing current coin");
}

export async function resumePumpfun() {
  if (!isPumpfunSubscribed || !isPumpfunPaused) return;
  isPumpfunPaused = false;
  resumePumpfunInternal();
  await logEvent("INFO", "Pumpfun resumed - listening for new coins");
}

export async function getRpcHealthStatus() {
  const status = [];

  for (const [url, connection] of activeConnections) {
    try {
      const startTime = Date.now();
      await connection.getSlot();
      const latency = Date.now() - startTime;

      status.push({
        url: url.substring(0, 50) + "...",
        name: getRpcName(url),
        status: "healthy",
        latency: `${latency}ms`,
      });
    } catch (error) {
      status.push({
        url: url.substring(0, 50) + "...",
        name: getRpcName(url),
        status: "unhealthy",
        error: error.message,
      });
    }
  }

  return status;
}
