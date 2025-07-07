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
      maxRetries: 2,
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
      await logEvent("ERROR", "Transaction confirmation failed", {
        signature,
        error: confirmation.value.err,
      });
      return null;
    }

    const txDetails = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    const fee = txDetails ? txDetails.meta.fee / LAMPORTS_PER_SOL : 0;
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
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mintAddress}&amount=1000000&slippageBps=100`;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Jupiter API Error: ${response.statusText}`);
    const data = await response.json();
    const outAmount = parseInt(data.outAmount, 10);
    if (outAmount === 0) return 0;
    const price = outAmount / (1000000 / 1e9);
    return 1 / price;
  } catch (error) {
    await logEvent("WARN", `Could not fetch price for ${mintAddress}`, {
      error: error.message,
    });
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
