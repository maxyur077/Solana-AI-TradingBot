import {
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
} from "@solana/spl-token";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import { WALLET_KEYPAIR, SLIPPAGE_BPS } from "../config.js";
import { logEvent } from "./databaseService.js";
import { connection } from "./solanaService.js";
import { SOL_MINT } from "../utils/constants.js";

let cpAmm = null;
const SOL_MINT_PUBKEY = new PublicKey(SOL_MINT);

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

async function fetchPoolByAddress(poolAddressStr, tokenMint) {
  try {
    if (!cpAmm) {
      await initMeteoraSwap();
    }

    const poolAddress = new PublicKey(poolAddressStr);
    const poolState = await cpAmm.fetchPoolState(poolAddress);

    if (!poolState) {
      return null;
    }

    const tokenIsMintA = poolState.tokenAMint.toString() === tokenMint;
    const hasSol = poolState.tokenAMint.toString() === SOL_MINT || poolState.tokenBMint.toString() === SOL_MINT;

    if (!hasSol) {
      return null;
    }

    return { poolAddress, poolState, tokenIsMintA };
  } catch (error) {
    return null;
  }
}

export async function findMeteoraPool(tokenMint, knownPoolAddress = null) {
  try {
    if (!cpAmm) {
      await initMeteoraSwap();
    }

    if (knownPoolAddress) {
      const directResult = await fetchPoolByAddress(knownPoolAddress, tokenMint);
      if (directResult) {
        return directResult;
      }
    }

    const tokenMintPubkey = new PublicKey(tokenMint);

    let pools = await cpAmm.fetchPoolStatesByTokenAMint(tokenMintPubkey);
    let solPool = pools.find((p) => p.account.tokenBMint.toString() === SOL_MINT);

    if (solPool) {
      return {
        poolAddress: solPool.publicKey,
        poolState: solPool.account,
        tokenIsMintA: true,
      };
    }

    pools = await cpAmm.fetchPoolStatesByTokenAMint(SOL_MINT_PUBKEY);
    solPool = pools.find((p) => p.account.tokenBMint.toString() === tokenMint);

    if (solPool) {
      return {
        poolAddress: solPool.publicKey,
        poolState: solPool.account,
        tokenIsMintA: false,
      };
    }

    return null;
  } catch (error) {
    return null;
  }
}

export async function getMeteoraTokenPrice(tokenMint) {
  try {
    if (!cpAmm) {
      await initMeteoraSwap();
    }

    const poolInfo = await findMeteoraPool(tokenMint);
    if (!poolInfo) {
      return 0;
    }

    const { poolState } = poolInfo;

    const slot = await connection.getSlot();
    const blockTime = await connection.getBlockTime(slot);

    const testAmount = new BN("1000000000");

    const quote = await cpAmm.getQuote({
      inAmount: testAmount,
      inputTokenMint: new PublicKey(tokenMint),
      slippage: 100,
      poolState: poolState,
      currentTime: blockTime,
      currentSlot: slot,
    });

    if (quote && quote.swapOutAmount) {
      return parseInt(quote.swapOutAmount.toString()) / LAMPORTS_PER_SOL;
    }

    return 0;
  } catch (error) {
    return 0;
  }
}

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

    const slot = await connection.getSlot();
    const blockTime = await connection.getBlockTime(slot);

    const amountInLamports = new BN(Math.round(solAmount * LAMPORTS_PER_SOL));

    const quote = await cpAmm.getQuote({
      inAmount: amountInLamports,
      inputTokenMint: SOL_MINT_PUBKEY,
      slippage: SLIPPAGE_BPS / 100,
      poolState: poolState,
      currentTime: blockTime,
      currentSlot: slot,
    });

    return { poolAddress, poolState, quote, tokenIsMintA };
  } catch (error) {
    await logEvent("ERROR", "Error getting Meteora quote", { error: error.message, tokenMint });
    return null;
  }
}

export async function swapOnMeteora(tokenMint, solAmount, knownPoolAddress = null) {
  try {
    if (!cpAmm) {
      await initMeteoraSwap();
    }

    const poolInfo = await findMeteoraPool(tokenMint, knownPoolAddress);
    if (!poolInfo) {
      throw new Error("No Meteora pool found");
    }

    const { poolAddress } = poolInfo;
    const tokenMintPubkey = new PublicKey(tokenMint);
    const amountInLamports = new BN(Math.round(solAmount * LAMPORTS_PER_SOL));

    const freshPoolState = await cpAmm.fetchPoolState(poolAddress);
    if (!freshPoolState) {
      throw new Error("Failed to fetch fresh pool state");
    }

    // For volatile meme tokens, we skip the quote-based slippage and use minimumAmountOut = 0
    // This ensures the swap always executes regardless of price movement
    // Reference: https://solana.stackexchange.com/questions/8446/the-most-time-efficient-way-to-set-slippage-before-swapping

    const latestBlockhash = await connection.getLatestBlockhash("confirmed");

    const finalTx = new Transaction();
    finalTx.recentBlockhash = latestBlockhash.blockhash;
    finalTx.feePayer = WALLET_KEYPAIR.publicKey;

    finalTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 })
    );

    const userTokenAta = await getAssociatedTokenAddress(tokenMintPubkey, WALLET_KEYPAIR.publicKey);

    try {
      await connection.getTokenAccountBalance(userTokenAta);
    } catch {
      finalTx.add(
        createAssociatedTokenAccountInstruction(
          WALLET_KEYPAIR.publicKey,
          userTokenAta,
          WALLET_KEYPAIR.publicKey,
          tokenMintPubkey
        )
      );
    }

    const swapTx = await cpAmm.swap({
      payer: WALLET_KEYPAIR.publicKey,
      pool: poolAddress,
      inputTokenMint: SOL_MINT_PUBKEY,
      outputTokenMint: tokenMintPubkey,
      amountIn: amountInLamports,
      minimumAmountOut: new BN(0),  // Bypass slippage check for volatile tokens
      tokenAVault: freshPoolState.tokenAVault,
      tokenBVault: freshPoolState.tokenBVault,
      tokenAMint: freshPoolState.tokenAMint,
      tokenBMint: freshPoolState.tokenBMint,
      tokenAProgram: freshPoolState.tokenAProgram || TOKEN_PROGRAM_ID,
      tokenBProgram: freshPoolState.tokenBProgram || TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
    });

    for (const ix of swapTx.instructions) {
      finalTx.add(ix);
    }

    const signature = await solanaSendAndConfirm(connection, finalTx, [WALLET_KEYPAIR], {
      skipPreflight: true,
      commitment: "confirmed",
      maxRetries: 3,
    });

    const txDetails = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    const fee = txDetails?.meta?.fee ? txDetails.meta.fee / LAMPORTS_PER_SOL : 0;

    await logEvent("SUCCESS", "Meteora swap executed successfully", { signature, fee: `${fee} SOL`, tokenMint });

    return { signature, fee };
  } catch (error) {
    // Parse Meteora-specific errors
    const errorMsg = error?.message || String(error) || "Unknown error";
    let errorDetails = errorMsg;
    if (errorMsg.includes("Custom\":1")) {
      errorDetails = "Slippage exceeded - price moved too much during swap. Token may be highly volatile or have low liquidity.";
    } else if (errorMsg.includes("Custom\":6")) {
      errorDetails = "Insufficient liquidity in pool for this swap amount.";
    }
    await logEvent("ERROR", "Error executing Meteora swap", { error: errorDetails, tokenMint, rawError: errorMsg });
    return null;
  }
}

export async function sellOnMeteora(tokenMint, tokenAmount) {
  try {
    if (!cpAmm) {
      await initMeteoraSwap();
    }

    const poolInfo = await findMeteoraPool(tokenMint);
    if (!poolInfo) {
      throw new Error("No Meteora pool found for selling");
    }

    const { poolAddress } = poolInfo;
    const tokenMintPubkey = new PublicKey(tokenMint);

    const freshPoolState = await cpAmm.fetchPoolState(poolAddress);
    if (!freshPoolState) {
      throw new Error("Failed to fetch fresh pool state for sell");
    }

    const amountIn = new BN(tokenAmount);

    // For volatile meme tokens, bypass slippage check to ensure sell executes
    const latestBlockhash = await connection.getLatestBlockhash("confirmed");

    const finalTx = new Transaction();
    finalTx.recentBlockhash = latestBlockhash.blockhash;
    finalTx.feePayer = WALLET_KEYPAIR.publicKey;

    finalTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 })
    );

    const swapTx = await cpAmm.swap({
      payer: WALLET_KEYPAIR.publicKey,
      pool: poolAddress,
      inputTokenMint: tokenMintPubkey,
      outputTokenMint: SOL_MINT_PUBKEY,
      amountIn: amountIn,
      minimumAmountOut: new BN(0),  // Bypass slippage check for volatile tokens
      tokenAVault: freshPoolState.tokenAVault,
      tokenBVault: freshPoolState.tokenBVault,
      tokenAMint: freshPoolState.tokenAMint,
      tokenBMint: freshPoolState.tokenBMint,
      tokenAProgram: freshPoolState.tokenAProgram || TOKEN_PROGRAM_ID,
      tokenBProgram: freshPoolState.tokenBProgram || TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
    });

    for (const ix of swapTx.instructions) {
      finalTx.add(ix);
    }

    const signature = await solanaSendAndConfirm(connection, finalTx, [WALLET_KEYPAIR], {
      skipPreflight: true,
      commitment: "confirmed",
      maxRetries: 3,
    });

    const txDetails = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    const fee = txDetails?.meta?.fee ? txDetails.meta.fee / LAMPORTS_PER_SOL : 0;

    // Calculate actual SOL received from transaction balance changes
    let solReceived = 0;
    if (txDetails?.meta) {
      const preBalance = txDetails.meta.preBalances[0] || 0;
      const postBalance = txDetails.meta.postBalances[0] || 0;
      const txFee = txDetails.meta.fee || 0;
      solReceived = (postBalance - preBalance + txFee) / LAMPORTS_PER_SOL;
    }

    await logEvent("SUCCESS", "Meteora sell executed successfully", { signature, fee: `${fee} SOL`, solReceived: `${solReceived} SOL` });

    return { signature, fee, solReceived };
  } catch (error) {
    // Parse Meteora-specific errors
    const errorMsg = error?.message || String(error) || "Unknown error";
    let errorDetails = errorMsg;
    if (errorMsg.includes("Custom\":1")) {
      errorDetails = "Slippage exceeded - price moved too much during sell. Token may be highly volatile or have low liquidity.";
    } else if (errorMsg.includes("Custom\":6")) {
      errorDetails = "Insufficient liquidity in pool for this sell amount.";
    }
    await logEvent("ERROR", "Error executing Meteora sell", { error: errorDetails, tokenMint, rawError: errorMsg });
    return null;
  }
}

export function isMeteoraInitialized() {
  return cpAmm !== null;
}
