import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction as solanaSendAndConfirm,
  ComputeBudgetProgram,
  Transaction
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT
} from "@solana/spl-token";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import { RPC_URL, WALLET_KEYPAIR, SLIPPAGE_BPS } from "../config.js";
import { logEvent } from "./databaseService.js";
import { connection } from "./solanaService.js";

// Initialize Meteora DAMM v2 SDK
let cpAmm = null;

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/**
 * Initialize the Meteora CpAmm SDK
 */
export async function initMeteoraSwap() {
  try {
    cpAmm = new CpAmm(connection);
    await logEvent("INFO", "Meteora DAMM v2 swap SDK initialized");
    return true;
  } catch (error) {
    await logEvent("ERROR", "Failed to initialize Meteora SDK", { error: error.message });
    return false;
  }
}

/**
 * Fetch pool state directly by pool address
 * @param {string} poolAddressStr - The pool address
 * @param {string} tokenMint - Token mint for determining tokenIsMintA
 * @returns {Promise<Object|null>} - Pool info or null
 */
async function fetchPoolByAddress(poolAddressStr, tokenMint) {
  try {
    if (!cpAmm) {
      await initMeteoraSwap();
    }

    const poolAddress = new PublicKey(poolAddressStr);
    const poolState = await cpAmm.fetchPoolState(poolAddress);

    if (!poolState) {
      await logEvent("WARN", `Could not fetch pool state for ${poolAddressStr}`);
      return null;
    }

    // Determine if token is mint A or B
    const tokenIsMintA = poolState.tokenAMint.toString() === tokenMint;

    // Verify it's a SOL pair
    const hasSol = poolState.tokenAMint.toString() === SOL_MINT.toString() ||
                   poolState.tokenBMint.toString() === SOL_MINT.toString();

    if (!hasSol) {
      await logEvent("WARN", `Pool ${poolAddressStr} is not a SOL pair`);
      return null;
    }

    await logEvent("INFO", `Fetched Meteora pool directly: ${poolAddressStr}`, {
      tokenAMint: poolState.tokenAMint.toString(),
      tokenBMint: poolState.tokenBMint.toString(),
      tokenIsMintA
    });

    return {
      poolAddress,
      poolState,
      tokenIsMintA
    };
  } catch (error) {
    await logEvent("ERROR", "Error fetching pool by address", {
      error: error.message,
      poolAddress: poolAddressStr
    });
    return null;
  }
}

/**
 * Find a Meteora DAMM v2 pool for a given token mint paired with SOL
 * @param {string} tokenMint - The token mint address
 * @param {string} knownPoolAddress - Optional known pool address from detection
 * @returns {Promise<Object|null>} - Pool state or null if not found
 */
export async function findMeteoraPool(tokenMint, knownPoolAddress = null) {
  try {
    if (!cpAmm) {
      await initMeteoraSwap();
    }

    // If we have a known pool address, try to fetch it directly first
    if (knownPoolAddress) {
      await logEvent("INFO", `Trying known pool address: ${knownPoolAddress}`);
      const directResult = await fetchPoolByAddress(knownPoolAddress, tokenMint);
      if (directResult) {
        return directResult;
      }
    }

    const tokenMintPubkey = new PublicKey(tokenMint);

    // Try to find pool where token is tokenA (SOL is tokenB)
    let pools = await cpAmm.fetchPoolStatesByTokenAMint(tokenMintPubkey);

    // Filter for SOL pairs
    let solPool = pools.find(p =>
      p.account.tokenBMint.toString() === SOL_MINT.toString()
    );

    if (solPool) {
      await logEvent("INFO", `Found Meteora pool (token is A): ${solPool.publicKey.toString()}`);
      return {
        poolAddress: solPool.publicKey,
        poolState: solPool.account,
        tokenIsMintA: true
      };
    }

    // Try to find pool where SOL is tokenA (token is tokenB)
    pools = await cpAmm.fetchPoolStatesByTokenAMint(SOL_MINT);
    solPool = pools.find(p =>
      p.account.tokenBMint.toString() === tokenMint
    );

    if (solPool) {
      await logEvent("INFO", `Found Meteora pool (token is B): ${solPool.publicKey.toString()}`);
      return {
        poolAddress: solPool.publicKey,
        poolState: solPool.account,
        tokenIsMintA: false
      };
    }

    await logEvent("WARN", `No Meteora SOL pool found for ${tokenMint}`);
    return null;
  } catch (error) {
    await logEvent("ERROR", "Error finding Meteora pool", {
      error: error.message,
      tokenMint
    });
    return null;
  }
}

/**
 * Get token price in SOL from Meteora pool
 * @param {string} tokenMint - Token mint address
 * @returns {Promise<number>} - Price in SOL or 0 if unavailable
 */
export async function getMeteoraTokenPrice(tokenMint) {
  try {
    if (!cpAmm) {
      await initMeteoraSwap();
    }

    const poolInfo = await findMeteoraPool(tokenMint);
    if (!poolInfo) {
      return 0;
    }

    const { poolState, tokenIsMintA } = poolInfo;

    // Get current slot and block time for quote
    const slot = await connection.getSlot();
    const blockTime = await connection.getBlockTime(slot);

    // Get quote for 1 token -> SOL to determine price
    // Use a small amount (1e9 = 1 token with 9 decimals)
    const testAmount = new BN("1000000000"); // 1 token (assuming 9 decimals)

    const quote = await cpAmm.getQuote({
      inAmount: testAmount,
      inputTokenMint: new PublicKey(tokenMint),
      slippage: 100, // 1% slippage for quote only
      poolState: poolState,
      currentTime: blockTime,
      currentSlot: slot,
    });

    if (quote && quote.swapOutAmount) {
      // swapOutAmount is in lamports, convert to SOL
      const priceInSol = parseInt(quote.swapOutAmount.toString()) / LAMPORTS_PER_SOL;
      return priceInSol;
    }

    return 0;
  } catch (error) {
    // Don't log - this is called frequently
    return 0;
  }
}

/**
 * Get a quote for swapping SOL to token on Meteora DAMM v2
 * @param {string} tokenMint - Token mint address
 * @param {number} solAmount - Amount of SOL to swap
 * @param {string} knownPoolAddress - Optional known pool address
 * @returns {Promise<Object|null>} - Quote details or null
 */
export async function getMeteoraQuote(tokenMint, solAmount, knownPoolAddress = null) {
  try {
    if (!cpAmm) {
      await initMeteoraSwap();
    }

    const poolInfo = await findMeteoraPool(tokenMint, knownPoolAddress);
    if (!poolInfo) {
      return null;
    }

    const { poolAddress, poolState, tokenIsMintA } = poolInfo;

    // Get current slot and block time for quote
    const slot = await connection.getSlot();
    const blockTime = await connection.getBlockTime(slot);

    const amountInLamports = new BN(Math.round(solAmount * LAMPORTS_PER_SOL));

    // Determine input/output mints based on pool configuration
    const inputTokenMint = SOL_MINT;
    const outputTokenMint = new PublicKey(tokenMint);

    const quote = await cpAmm.getQuote({
      inAmount: amountInLamports,
      inputTokenMint: inputTokenMint,
      slippage: SLIPPAGE_BPS / 100, // Convert basis points to percentage
      poolState: poolState,
      currentTime: blockTime,
      currentSlot: slot,
    });

    await logEvent("INFO", "Meteora quote received", {
      inAmount: quote.swapInAmount?.toString(),
      outAmount: quote.swapOutAmount?.toString(),
      minOut: quote.minSwapOutAmount?.toString(),
      priceImpact: quote.priceImpact,
    });

    return {
      poolAddress,
      poolState,
      quote,
      tokenIsMintA,
    };
  } catch (error) {
    await logEvent("ERROR", "Error getting Meteora quote", {
      error: error.message,
      tokenMint,
      solAmount
    });
    return null;
  }
}

/**
 * Execute a swap on Meteora DAMM v2 (buy token with SOL)
 * @param {string} tokenMint - Token mint address to buy
 * @param {number} solAmount - Amount of SOL to spend
 * @param {string} knownPoolAddress - Optional known pool address from detection
 * @returns {Promise<Object|null>} - Transaction result or null
 */
export async function swapOnMeteora(tokenMint, solAmount, knownPoolAddress = null) {
  try {
    if (!cpAmm) {
      await initMeteoraSwap();
    }

    const quoteResult = await getMeteoraQuote(tokenMint, solAmount, knownPoolAddress);
    if (!quoteResult) {
      throw new Error("Failed to get Meteora quote");
    }

    const { poolAddress, poolState, quote, tokenIsMintA } = quoteResult;

    const amountInLamports = new BN(Math.round(solAmount * LAMPORTS_PER_SOL));
    const tokenMintPubkey = new PublicKey(tokenMint);

    // Get latest blockhash first
    const latestBlockhash = await connection.getLatestBlockhash();

    // Create a new transaction with compute budget
    const finalTx = new Transaction();
    finalTx.recentBlockhash = latestBlockhash.blockhash;
    finalTx.feePayer = WALLET_KEYPAIR.publicKey;

    // Add compute budget instructions for complex swaps
    finalTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })
    );

    // Check if user has ATA for the output token, create if not
    const userTokenAta = await getAssociatedTokenAddress(
      tokenMintPubkey,
      WALLET_KEYPAIR.publicKey
    );

    try {
      await connection.getTokenAccountBalance(userTokenAta);
    } catch {
      // ATA doesn't exist, create it
      await logEvent("INFO", "Creating ATA for output token...");
      finalTx.add(
        createAssociatedTokenAccountInstruction(
          WALLET_KEYPAIR.publicKey,
          userTokenAta,
          WALLET_KEYPAIR.publicKey,
          tokenMintPubkey
        )
      );
    }

    // Build swap transaction from SDK
    const swapTx = await cpAmm.swap({
      payer: WALLET_KEYPAIR.publicKey,
      pool: poolAddress,
      inputTokenMint: SOL_MINT,
      outputTokenMint: tokenMintPubkey,
      amountIn: amountInLamports,
      minimumAmountOut: quote.minSwapOutAmount,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAProgram: poolState.tokenAProgram || TOKEN_PROGRAM_ID,
      tokenBProgram: poolState.tokenBProgram || TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
    });

    // Add all instructions from the SDK transaction to our transaction
    for (const ix of swapTx.instructions) {
      finalTx.add(ix);
    }

    // Sign and send the transaction
    try {
      await logEvent("INFO", "Sending Meteora swap transaction...");
      const signature = await solanaSendAndConfirm(
        connection,
        finalTx,
        [WALLET_KEYPAIR],
        {
          skipPreflight: true,
          commitment: "confirmed",
          maxRetries: 3,
        }
      );

      // Get transaction details for fee
      const txDetails = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      const fee = txDetails?.meta?.fee
        ? txDetails.meta.fee / LAMPORTS_PER_SOL
        : 0;

      await logEvent("SUCCESS", "Meteora swap executed successfully", {
        signature,
        fee: `${fee} SOL`,
        tokenMint,
        solAmount,
      });

      return { signature, fee };
    } catch (sendError) {
      // Try to get more error details
      const errorMsg = sendError.message || "Unknown error";
      await logEvent("ERROR", "Meteora transaction failed", {
        error: errorMsg,
        logs: sendError.logs ? sendError.logs.slice(-5) : [],
      });
      return null;
    }
  } catch (error) {
    await logEvent("ERROR", "Error executing Meteora swap", {
      error: error.message,
      tokenMint,
      solAmount
    });
    return null;
  }
}

/**
 * Execute a sell swap on Meteora DAMM v2 (sell token for SOL)
 * @param {string} tokenMint - Token mint address to sell
 * @param {string} tokenAmount - Amount of tokens to sell (in raw units)
 * @returns {Promise<Object|null>} - Transaction result or null
 */
export async function sellOnMeteora(tokenMint, tokenAmount) {
  try {
    if (!cpAmm) {
      await initMeteoraSwap();
    }

    const poolInfo = await findMeteoraPool(tokenMint);
    if (!poolInfo) {
      throw new Error("No Meteora pool found for selling");
    }

    const { poolAddress, poolState, tokenIsMintA } = poolInfo;
    const tokenMintPubkey = new PublicKey(tokenMint);

    // Get current slot and block time for quote
    const slot = await connection.getSlot();
    const blockTime = await connection.getBlockTime(slot);

    const amountIn = new BN(tokenAmount);

    // Get quote for selling token -> SOL
    const quote = await cpAmm.getQuote({
      inAmount: amountIn,
      inputTokenMint: tokenMintPubkey,
      slippage: SLIPPAGE_BPS / 100,
      poolState: poolState,
      currentTime: blockTime,
      currentSlot: slot,
    });

    await logEvent("INFO", "Meteora sell quote received", {
      inAmount: quote.swapInAmount?.toString(),
      outAmount: quote.swapOutAmount?.toString(),
      minOut: quote.minSwapOutAmount?.toString(),
    });

    // Get latest blockhash
    const latestBlockhash = await connection.getLatestBlockhash();

    // Create transaction with compute budget
    const finalTx = new Transaction();
    finalTx.recentBlockhash = latestBlockhash.blockhash;
    finalTx.feePayer = WALLET_KEYPAIR.publicKey;

    // Add compute budget
    finalTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })
    );

    // Build swap transaction (token -> SOL)
    const swapTx = await cpAmm.swap({
      payer: WALLET_KEYPAIR.publicKey,
      pool: poolAddress,
      inputTokenMint: tokenMintPubkey,
      outputTokenMint: SOL_MINT,
      amountIn: amountIn,
      minimumAmountOut: quote.minSwapOutAmount,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAProgram: poolState.tokenAProgram || TOKEN_PROGRAM_ID,
      tokenBProgram: poolState.tokenBProgram || TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
    });

    // Add swap instructions
    for (const ix of swapTx.instructions) {
      finalTx.add(ix);
    }

    // Send transaction
    await logEvent("INFO", "Sending Meteora sell transaction...");
    const signature = await solanaSendAndConfirm(
      connection,
      finalTx,
      [WALLET_KEYPAIR],
      {
        skipPreflight: true,
        commitment: "confirmed",
        maxRetries: 3,
      }
    );

    // Get fee
    const txDetails = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    const fee = txDetails?.meta?.fee
      ? txDetails.meta.fee / LAMPORTS_PER_SOL
      : 0;

    // Calculate SOL received
    const solReceived = parseInt(quote.swapOutAmount.toString()) / LAMPORTS_PER_SOL;

    await logEvent("SUCCESS", "Meteora sell executed successfully", {
      signature,
      fee: `${fee} SOL`,
      tokenMint,
      solReceived: `${solReceived} SOL`,
    });

    return { signature, fee, solReceived };
  } catch (error) {
    await logEvent("ERROR", "Error executing Meteora sell", {
      error: error.message,
      tokenMint,
    });
    return null;
  }
}

/**
 * Check if Meteora SDK is initialized
 * @returns {boolean}
 */
export function isMeteoraInitialized() {
  return cpAmm !== null;
}
