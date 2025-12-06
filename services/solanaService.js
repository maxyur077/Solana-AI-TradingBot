import {
  Connection,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { RPC_URL, WALLET_KEYPAIR, SOL_MINT } from "../config.js";
import fetch from "cross-fetch";
import { logEvent } from "./databaseService.js";

export const connection = new Connection(RPC_URL, "confirmed");

export async function sendAndConfirmTransaction(tx, latestBlockhash) {
  try {
    tx.sign([WALLET_KEYPAIR]);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
    await logEvent("INFO", `Transaction sent with signature: ${signature}`);

    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );

    if (confirmation.value.err) {
      throw new Error(
        `Transaction confirmation failed: ${JSON.stringify(
          confirmation.value.err
        )}`
      );
    }

    const txDetails = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    const fee = txDetails?.meta?.fee
      ? txDetails.meta.fee / LAMPORTS_PER_SOL
      : 0;
    await logEvent("SUCCESS", `Transaction successfully confirmed`, {
      signature,
      fee: `${fee} SOL`,
    });
    return { signature, fee };
  } catch (error) {
    await logEvent("ERROR", "Error sending transaction", {
      error: error.message,
    });
    return null;
  }
}

export async function getTokenPriceInSol(mintAddress) {
  // Try multiple price sources with retry
  const maxRetries = 2;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Method 1: Jupiter Price API v2
      const url = `https://api.jup.ag/price/v2?ids=${mintAddress}&vsToken=${SOL_MINT}`;
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
        }
      });

      if (response.ok) {
        const data = await response.json();
        const price = data.data?.[mintAddress]?.price;
        if (price && price > 0) {
          return price;
        }
      }

      // Small delay before retry
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (error) {
      // Continue to next attempt
    }
  }

  // Don't log warning for every failed price fetch to reduce spam
  return 0;
}

/**
 * Gets the current price of SOL in USD.
 * @returns {Promise<number>}
 */
export async function getSolPriceUsd() {
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Method 1: Jupiter Price API v2
      const response = await fetch(
        `https://api.jup.ag/price/v2?ids=${SOL_MINT}`,
        {
          headers: { 'Accept': 'application/json' },
        }
      );

      if (response.ok) {
        const data = await response.json();
        if (data && data.data && data.data[SOL_MINT] && data.data[SOL_MINT].price) {
          return parseFloat(data.data[SOL_MINT].price);
        }
      }

      // Small delay before retry
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (error) {
      // Continue to next attempt
    }
  }

  // Fallback: Try CoinGecko API
  try {
    const cgResponse = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      {
        headers: { 'Accept': 'application/json' },
      }
    );

    if (cgResponse.ok) {
      const cgData = await cgResponse.json();
      if (cgData && cgData.solana && cgData.solana.usd) {
        return parseFloat(cgData.solana.usd);
      }
    }
  } catch (error) {
    // CoinGecko also failed
  }

  // Don't spam logs, just return 0
  return 0;
}
