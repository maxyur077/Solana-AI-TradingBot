import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { RPC_URL, SOL_MINT } from "../config.js";
import { logEvent } from "./databaseService.js";
import fetch from "cross-fetch";

export const connection = new Connection(RPC_URL, "confirmed");

/**
 * A robust function to send and confirm a transaction, handling blockhash expiration.
 * @param {VersionedTransaction} tx - The transaction to send.
 * @param {object} latestBlockhash - The latest blockhash object from connection.getLatestBlockhash().
 * @returns {Promise<object|null>} An object with signature and fee, or null if it fails.
 */
export async function sendAndConfirmTransaction(tx, latestBlockhash) {
  try {
    // Send the transaction
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, // Recommended for sniping
    });
    await logEvent("INFO", `Transaction sent with signature: ${signature}`);

    // Confirm the transaction using the modern strategy
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

    // Get transaction details to calculate the fee
    const txDetails = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    const fee = txDetails?.meta?.fee
      ? txDetails.meta.fee / LAMPORTS_PER_SOL
      : 0;

    await logEvent("SUCCESS", "Transaction successfully confirmed", {
      signature,
      fee: `${fee} SOL`,
    });
    return { signature, fee };
  } catch (error) {
    // Log the full error, which will now include the "block height exceeded" message
    await logEvent("ERROR", "Error sending transaction", {
      error: error.message,
    });
    return null;
  }
}

/**
 * Fetches the price of a token in terms of SOL.
 * @param {string} mintAddress - The mint address of the token.
 * @returns {Promise<number>} The price of one whole token in SOL.
 */
export async function getTokenPriceInSol(mintAddress) {
  try {
    // We get a quote for 1 whole token (e.g., 1000000 lamports for a 6-decimal token)
    const url = `https://quote-api.jup.ag/v6/price?ids=${mintAddress}&vsToken=${SOL_MINT}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch price from Jupiter API: ${response.statusText}`
      );
    }
    const data = await response.json();
    const price = data.data[mintAddress]?.price;

    if (price) {
      return price;
    }
    return 0;
  } catch (error) {
    await logEvent(
      "WARN",
      `Could not fetch price for ${mintAddress}: ${error.message}`
    );
    return 0;
  }
}

/**
 * Gets the current price of SOL in USD.
 * @returns {Promise<number>}
 */
export async function getSolPriceUsd() {
  try {
    const response = await fetch(
      `https://lite-api.jup.ag/price/v2?ids=${SOL_MINT}`
    );
    const data = await response.json();

    if (data && data.data && data.data[SOL_MINT]) {
      return parseFloat(data.data[SOL_MINT].price);
    }
    throw new Error("Invalid response from price API");
  } catch (error) {
    // Assuming logEvent is defined elsewhere in your project
    await logEvent("ERROR", "Failed to fetch SOL price in USD", {
      error: error.message,
    });
    return 0; // Return 0 as a safe fallback
  }
}
