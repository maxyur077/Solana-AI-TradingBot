import { Connection, PublicKey } from "@solana/web3.js";
import { logEvent } from "./databaseService.js";
import ReconnectingWebSocket from "reconnecting-websocket";
import WebSocket from "ws";
import { sleep } from "../utils/helpers.js";
import { MAX_TOKEN_AGE_MINUTES } from "../config.js";

const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPFUN_PROGRAM_PUBKEY = new PublicKey(PUMPFUN_PROGRAM_ID);

let pumpfunConnection = null;
let pumpfunWebSocket = null;
let pumpfunCallback = null;
let isPumpfunSubscribed = false;
let pumpfunSubscriptionId = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let isPumpfunPaused = false;

export function initPumpfunConnection(rpcUrl) {
  if (!pumpfunConnection) {
    pumpfunConnection = new Connection(rpcUrl, {
      commitment: "confirmed",
      wsEndpoint: rpcUrl.replace("https://", "wss://"),
    });
  }
  return pumpfunConnection;
}

export function setPumpfunCallback(callback) {
  pumpfunCallback = callback;
}

export async function subscribeToPumpfun(connection, rpcWsUrl) {
  if (isPumpfunSubscribed) {
    await logEvent("WARN", "Pump.fun already subscribed. Skipping.");
    return;
  }

  await logEvent("INFO", "Subscribing to Pump.fun token creation events...");

  const wsUrl = rpcWsUrl || connection._rpcWsEndpoint;

  pumpfunWebSocket = new ReconnectingWebSocket(wsUrl, [], {
    WebSocket: WebSocket,
    connectionTimeout: 10000,
    maxRetries: MAX_RECONNECT_ATTEMPTS,
    minReconnectionDelay: 2000,
    maxReconnectionDelay: 30000,
  });

  pumpfunWebSocket.addEventListener("open", async () => {
    await logEvent("INFO", "Pump.fun WebSocket connected");
    reconnectAttempts = 0;

    const subscribeMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          mentions: [PUMPFUN_PROGRAM_ID],
        },
        {
          commitment: "confirmed",
        },
      ],
    };

    pumpfunWebSocket.send(JSON.stringify(subscribeMessage));
  });

  pumpfunWebSocket.addEventListener("message", async (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.result && !pumpfunSubscriptionId) {
        pumpfunSubscriptionId = data.result;
        isPumpfunSubscribed = true;
        await logEvent("SUCCESS", `Pump.fun subscription active: ${pumpfunSubscriptionId}`);
        return;
      }

      if (data.method === "logsNotification" && data.params) {
        if (isPumpfunPaused) return;

        const { value } = data.params.result;
        const signature = value.signature;
        const logs = value.logs || [];

        const isCreateEvent = logs.some(
          (log) =>
            log.includes("Program log: Instruction: Create") ||
            log.includes("Program log: Instruction: InitializeMint") ||
            log.includes("create") ||
            log.includes("CreateEvent")
        );

        if (isCreateEvent && pumpfunCallback) {
          const tx = await fetchTransactionWithRetry(connection, signature);
          if (tx) {
            const mintAddress = extractMintFromPumpfunTransaction(tx);
            if (mintAddress) {
              const isNewCoin = await checkIfNewlyCreated(connection, tx, mintAddress);
              if (isNewCoin) {
                await pumpfunCallback(signature, mintAddress, tx);
              } else {
                await logEvent("INFO", `Skipping old Pump.fun coin (age > ${MAX_TOKEN_AGE_MINUTES} minutes)`, {
                  mintAddress,
                  signature,
                });
              }
            }
          }
        }
      }
    } catch (error) {
      await logEvent("ERROR", "Error processing Pump.fun message", {
        error: error.message,
      });
    }
  });

  pumpfunWebSocket.addEventListener("error", async (error) => {
    await logEvent("ERROR", "Pump.fun WebSocket error", {
      error: error.message,
    });
  });

  pumpfunWebSocket.addEventListener("close", async () => {
    isPumpfunSubscribed = false;
    pumpfunSubscriptionId = null;
    reconnectAttempts++;

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      await logEvent("ERROR", "Pump.fun WebSocket max reconnection attempts reached");
    } else {
      await logEvent("WARN", `Pump.fun WebSocket closed. Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
    }
  });
}

export async function unsubscribeFromPumpfun() {
  if (!isPumpfunSubscribed || !pumpfunWebSocket) {
    return;
  }

  try {
    if (pumpfunSubscriptionId) {
      const unsubscribeMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "logsUnsubscribe",
        params: [pumpfunSubscriptionId],
      };
      pumpfunWebSocket.send(JSON.stringify(unsubscribeMessage));
    }

    pumpfunWebSocket.close();
    pumpfunWebSocket = null;
    isPumpfunSubscribed = false;
    pumpfunSubscriptionId = null;

    await logEvent("INFO", "Unsubscribed from Pump.fun");
  } catch (error) {
    await logEvent("ERROR", "Error unsubscribing from Pump.fun", {
      error: error.message,
    });
  }
}

async function fetchTransactionWithRetry(connection, signature, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await sleep(200 * (i + 1));
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx) return tx;
    } catch (error) {
      if (i === maxRetries - 1) {
        await logEvent("ERROR", `Failed to fetch Pump.fun transaction after ${maxRetries} attempts`, {
          signature,
          error: error.message,
        });
      }
    }
  }
  return null;
}

function extractMintFromPumpfunTransaction(tx) {
  try {
    if (!tx || !tx.transaction) return null;

    const accountKeys = tx.transaction.message.accountKeys || [];
    const instructions = tx.transaction.message.instructions || [];

    for (const instruction of instructions) {
      const programId = accountKeys[instruction.programIdIndex]?.pubkey?.toString();

      if (programId === PUMPFUN_PROGRAM_ID) {
        for (const accountIndex of instruction.accounts || []) {
          const account = accountKeys[accountIndex];
          if (account && account.pubkey) {
            const possibleMint = account.pubkey.toString();
            if (possibleMint !== PUMPFUN_PROGRAM_ID && possibleMint.length === 44) {
              return possibleMint;
            }
          }
        }
      }
    }

    const postTokenBalances = tx.meta?.postTokenBalances || [];
    for (const balance of postTokenBalances) {
      if (balance.mint && balance.mint !== PUMPFUN_PROGRAM_ID) {
        return balance.mint;
      }
    }

    return null;
  } catch (error) {
    logEvent("ERROR", "Error extracting mint from Pump.fun transaction", {
      error: error.message,
    });
    return null;
  }
}

export function getPumpfunSubscriptionStatus() {
  return {
    subscribed: isPumpfunSubscribed,
    subscriptionId: pumpfunSubscriptionId,
    reconnectAttempts,
  };
}

async function checkIfNewlyCreated(connection, transaction, mintAddress) {
  try {
    if (!transaction || !transaction.blockTime) {
      return true;
    }

    const now = Math.floor(Date.now() / 1000);
    const txTime = transaction.blockTime;
    const ageInSeconds = now - txTime;
    const ageInMinutes = ageInSeconds / 60;

    if (ageInMinutes > MAX_TOKEN_AGE_MINUTES) {
      return false;
    }

    try {
      const mintPubkey = new PublicKey(mintAddress);
      const accountInfo = await connection.getAccountInfo(mintPubkey);

      if (!accountInfo) {
        return false;
      }

      return true;
    } catch (error) {
      await logEvent("WARN", "Error checking mint account info", {
        mintAddress,
        error: error.message,
      });
      return true;
    }
  } catch (error) {
    await logEvent("ERROR", "Error in checkIfNewlyCreated", {
      error: error.message,
    });
    return true;
  }
}

export function isPumpfunActive() {
  return isPumpfunSubscribed;
}

export function pausePumpfunInternal() {
  isPumpfunPaused = true;
}

export function resumePumpfunInternal() {
  isPumpfunPaused = false;
}
