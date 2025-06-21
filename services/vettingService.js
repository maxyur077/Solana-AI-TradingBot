import axios from "axios";
import { logEvent } from "./databaseService.js";
import { RPC_URL, MAX_HOLDER_CONCENTRATION_PERCENT } from "../config.js";
import fetch from "cross-fetch";

export async function getTokenMetadata(mintAddress) {
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "helius-test",
        method: "getAsset",
        params: { id: mintAddress },
      }),
    });
    const { result } = await response.json();
    if (result && result.content && result.content.metadata) {
      return {
        name: result.content.metadata.name,
        symbol: result.content.metadata.symbol,
      };
    }
    await logEvent("WARN", `Could not find metadata for mint: ${mintAddress}`);
    return null;
  } catch (error) {
    await logEvent(
      "ERROR",
      `Error fetching token metadata for ${mintAddress}`,
      { error }
    );
    return null;
  }
}

export async function checkRug(mintAddress) {
  await logEvent("INFO", `Checking rug risk for token: ${mintAddress}`);
  try {
    const url = `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`;
    const response = await axios.get(url);

    if (response.data) {
      const report = response.data;
      const summary = report.summary;

      if (report.lp?.lockedPct < 1) {
        await logEvent("WARN", `Vetting failed: LP not 100% locked.`, {
          mint: mintAddress,
          lockedPct: report.lp?.lockedPct,
        });
        return null;
      }
      if (
        report.token.metadata?.updateAuthority &&
        report.token.metadata.updateAuthority !==
          "11111111111111111111111111111111"
      ) {
        await logEvent("WARN", `Vetting failed: Metadata is mutable.`, {
          mint: mintAddress,
        });
        return null;
      }
      if (report.token.mint?.freezeAuthority) {
        await logEvent("WARN", `Vetting failed: Token is freezable.`, {
          mint: mintAddress,
        });
        return null;
      }
      if (report.token.mint?.mintAuthority) {
        await logEvent("WARN", `Vetting failed: Token is mintable.`, {
          mint: mintAddress,
        });
        return null;
      }
      if (report.holders?.top10Pct > MAX_HOLDER_CONCENTRATION_PERCENT / 100) {
        await logEvent(
          "WARN",
          `Vetting failed: Top 10 holders own > ${MAX_HOLDER_CONCENTRATION_PERCENT}%.`,
          { mint: mintAddress, concentration: report.holders.top10Pct }
        );
        return null;
      }

      let overallRiskLevel = "GOOD";
      if (summary.risks && summary.risks.length > 0) {
        const riskLevels = summary.risks.map((r) => r.level.toUpperCase());
        if (riskLevels.includes("DANGER")) overallRiskLevel = "DANGER";
        else if (riskLevels.includes("WARN")) overallRiskLevel = "WARNING";
      }
      summary.risk = { level: overallRiskLevel };
      await logEvent("SUCCESS", `RugCheck report received.`, {
        mint: mintAddress,
        risk: summary.risk.level,
      });
      return summary;
    }
    return null;
  } catch (error) {
    await logEvent("ERROR", `Error calling RugCheck API`, {
      mint: mintAddress,
      error: error.message,
    });
    return null;
  }
}
