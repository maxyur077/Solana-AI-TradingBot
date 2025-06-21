import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_API_KEY } from "../config.js";
import { logEvent } from "./databaseService.js";

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

export async function shouldBuyToken(tokenInfo, rugCheckReport) {
  const prompt = `
        You are an expert Solana meme coin trader with a high-risk, high-reward strategy. Your goal is to identify explosive new meme coins while avoiding obvious scams.
        A new token has been detected and vetted. Here is the data:
        - Name: "${tokenInfo.name}"
        - Symbol: "${tokenInfo.symbol}"
        - RugCheck Risk Level: "${
          rugCheckReport.risk.level
        }" (Levels: GOOD, WARNING, DANGER)
        - RugCheck Top Risk Factor: "${rugCheckReport.risks[0]?.name || "None"}"
        - RugCheck Score: ${rugCheckReport.score} / 1000
        My trading strategy is to invest a small amount ($5) into any coin that seems to have viral potential, even with a 'WARNING' or 'DANGER' risk, as I have different profit-taking strategies for each risk level.
        Based on the token's name and symbol, does this have meme potential? Ignore the risk report for this decision, as I am already aware of it.
        Respond with ONLY one word: 'BUY' or 'PASS'.
    `;
  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const decision = response.text().trim().toUpperCase();
    await logEvent(
      "INFO",
      `Gemini AI decision for ${tokenInfo.symbol}: ${decision}`
    );
    return decision === "BUY";
  } catch (error) {
    await logEvent("ERROR", "Error getting decision from Gemini AI:", {
      error,
    });
    return false;
  }
}
