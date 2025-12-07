import express from "express";
import { logEvent } from "./databaseService.js";
import { SOL_MINT, RAYDIUM_AMM_PROGRAM } from "../utils/constants.js";

let onNewPoolCallback = null;
const processedSignatures = new Set();
const MAX_SIGNATURES_CACHE = 10000;

/**
 * Set the callback function to be called when a new pool is detected
 * @param {Function} callback - Function to call with (signature, mintAddress, transaction)
 */
export function setNewPoolCallback(callback) {
  onNewPoolCallback = callback;
}

/**
 * Check if a signature has already been processed
 * @param {string} signature
 * @returns {boolean}
 */
export function hasProcessedSignature(signature) {
  return processedSignatures.has(signature);
}

/**
 * Mark a signature as processed
 * @param {string} signature
 */
export function markSignatureProcessed(signature) {
  processedSignatures.add(signature);

  // Cleanup old signatures to prevent memory leak
  if (processedSignatures.size > MAX_SIGNATURES_CACHE) {
    const iterator = processedSignatures.values();
    for (let i = 0; i < 1000; i++) {
      processedSignatures.delete(iterator.next().value);
    }
  }
}

/**
 * Extract mint address from Helius enhanced webhook payload
 * @param {Object} transaction - Enhanced transaction from Helius
 * @returns {string|null} - Mint address or null
 */
function extractMintFromWebhook(transaction) {
  try {
    if (transaction.tokenTransfers && transaction.tokenTransfers.length > 0) {
      for (const transfer of transaction.tokenTransfers) {
        if (transfer.mint && transfer.mint !== SOL_MINT) {
          return transfer.mint;
        }
      }
    }

    if (transaction.accountData) {
      for (const account of transaction.accountData) {
        if (account.tokenBalanceChanges) {
          for (const change of account.tokenBalanceChanges) {
            if (change.mint && change.mint !== SOL_MINT) {
              return change.mint;
            }
          }
        }
      }
    }

    if (transaction.instructions) {
      for (const ix of transaction.instructions) {
        if (ix.programId === RAYDIUM_AMM_PROGRAM) {
          if (ix.accounts && ix.accounts.length > 8) {
            for (const account of ix.accounts) {
              if (account !== SOL_MINT && account !== RAYDIUM_AMM_PROGRAM) {
                if (account && account.length >= 32 && account.length <= 44) {
                  return account;
                }
              }
            }
          }
        }
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Process incoming webhook from Helius
 * @param {Object} payload - Webhook payload from Helius
 */
async function processWebhookPayload(payload) {
  try {
    // Helius sends array of transactions
    const transactions = Array.isArray(payload) ? payload : [payload];

    for (const tx of transactions) {
      const signature = tx.signature;

      if (!signature) continue;

      // Skip if already processed (deduplication with onLogs)
      if (hasProcessedSignature(signature)) {
        continue;
      }

      // Check for Raydium pool creation
      const isPoolCreation =
        tx.type === "CREATE_POOL" ||
        tx.type === "SWAP" ||
        (tx.description && tx.description.toLowerCase().includes("initialize")) ||
        (tx.source === "RAYDIUM");

      if (!isPoolCreation && tx.type !== "UNKNOWN") {
        continue;
      }

      // Extract mint address
      const mintAddress = extractMintFromWebhook(tx);

      if (mintAddress) {
        markSignatureProcessed(signature);

        await logEvent("INFO", `[WEBHOOK] New pool detected via Helius webhook`, {
          signature,
          mint: mintAddress,
          type: tx.type,
          source: tx.source || "UNKNOWN"
        });

        // Call the registered callback
        if (onNewPoolCallback) {
          await onNewPoolCallback(signature, mintAddress, tx);
        }
      }
    }
  } catch (error) {
    await logEvent("ERROR", "Error processing webhook payload", { error: error.message });
  }
}

/**
 * Create and configure the webhook receiver Express app
 * @param {Express} app - Express app instance
 * @param {string} webhookPath - Path for webhook endpoint (default: /webhook)
 */
export function setupWebhookReceiver(app, webhookPath = "/webhook") {
  // Parse JSON bodies
  app.use(express.json({ limit: "10mb" }));

  // Webhook endpoint for Helius
  app.post(webhookPath, async (req, res) => {
    try {
      // Immediately respond to Helius (they have timeout requirements)
      res.status(200).send("OK");

      // Process in background
      await processWebhookPayload(req.body);
    } catch (error) {
      await logEvent("ERROR", "Webhook endpoint error", { error: error.message });
    }
  });

  // Webhook health check
  app.get(webhookPath, (req, res) => {
    res.status(200).json({
      status: "active",
      processedSignatures: processedSignatures.size
    });
  });

  logEvent("INFO", `Webhook receiver configured at ${webhookPath}`);
}

/**
 * Create Helius webhook via API (one-time setup)
 * @param {string} apiKey - Helius API key
 * @param {string} webhookUrl - Your public webhook URL
 * @returns {Promise<Object>} - Created webhook details
 */
export async function createHeliusWebhook(apiKey, webhookUrl) {
  try {
    const response = await fetch(
      `https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookURL: webhookUrl,
          transactionTypes: ["ANY"],
          accountAddresses: [RAYDIUM_AMM_PROGRAM],
          webhookType: "enhanced",
        }),
      }
    );

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error);
    }

    await logEvent("SUCCESS", "Helius webhook created successfully", {
      webhookId: data.webhookID,
      webhookUrl,
    });

    return data;
  } catch (error) {
    await logEvent("ERROR", "Failed to create Helius webhook", { error: error.message });
    throw error;
  }
}

/**
 * List existing Helius webhooks
 * @param {string} apiKey - Helius API key
 * @returns {Promise<Array>} - List of webhooks
 */
export async function listHeliusWebhooks(apiKey) {
  try {
    const response = await fetch(
      `https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`
    );
    return await response.json();
  } catch (error) {
    await logEvent("ERROR", "Failed to list Helius webhooks", { error: error.message });
    return [];
  }
}

/**
 * Delete a Helius webhook
 * @param {string} apiKey - Helius API key
 * @param {string} webhookId - Webhook ID to delete
 */
export async function deleteHeliusWebhook(apiKey, webhookId) {
  try {
    await fetch(
      `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${apiKey}`,
      { method: "DELETE" }
    );
    await logEvent("INFO", `Deleted webhook ${webhookId}`);
  } catch (error) {
    await logEvent("ERROR", "Failed to delete webhook", { error: error.message });
  }
}
