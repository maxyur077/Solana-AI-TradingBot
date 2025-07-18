
# Solana AI Trading Bot

Welcome! This is a professional-grade, automated trading bot for sniping new meme coins on the Solana blockchain, developed by software developer and crypto enthusiast Mayur Maskar.

This bot leverages AI-powered analysis, sophisticated risk management, and dynamic trading strategies to navigate the fast-paced world of meme coin trading with the goal of maximizing profit while mitigating risk.

## 🚀Features
- AI-Powered Decisions: Uses the Google Gemini API to analyze token names and symbols for viral potential, providing an intelligent layer beyond simple metrics.

- Dynamic, Risk-Adjusted Trading: Automatically adjusts its strategy based on a token's risk profile from rugcheck.xyz.

- Variable Trade Sizing: Places smaller bets on high-risk (DANGER) tokens and larger bets on more promising (GOOD) tokens.

- Custom Take-Profit & Stop-Loss: Applies different, fully configurable take-profit and stop-loss rules for each risk level.

- Advanced Pre-Trade Vetting: Before spending any SOL, the bot performs critical safety checks:
   - Liquidity Threshold: Ignores tokens with insufficient initial liquidity.
   -  Mandatory Security Checks: Automatically rejects tokens if liquidity isn't 100% locked or if the mint/freeze authority has not been renounced.
   - Holder Analysis: Rejects tokens with dangerously high holder concentration.

- Intelligent Profit Protection:
   - Trailing Stop-Loss: Locks in gains by automatically selling a position if it drops a certain percentage from its peak price.
  -  Time-Based Selling: Automatically sells profitable but risky (DANGER) tokens after a configurable time limit to avoid "stale" trades.

- Robust & Reliable:
   - Automatic Retries: If a transaction fails due to network congestion or slippage, the bot automatically retries.
  -  Priority Fees: Uses Jupiter's auto priority fee settings to ensure transactions are processed quickly and reliably.
  -   No Re-Buys & Blacklist: Prevents buying the same token twice and allows you to maintain a blacklist.txt of tokens to ignore.

- Comprehensive Logging:
   - Database Records: Logs every trade, fee, and system event to a local SQLite database.
  -  Live Console Output: Provides real-time, color-coded logs in the console.
  -  Total P&L Tracking: Calculates and displays your running total Profit/Loss in USD after every sell trade.



## Demo

https://github.com/user-attachments/assets/7408831d-59ed-4448-8422-82a980fe4c2c


![WhatsApp Image 2025-07-15 at 6 12 42 PM](https://github.com/user-attachments/assets/545dcfb6-8749-4864-a80e-d3f03125d9e8)




## 🛠️ Setup Instructions

  -    Install Node.js: Ensure you have Node.js v18.0 or higher.
  - Clone & Install Dependencies:

```bash
# Clone the repository
git clone https://github.com/maxyur077/Solana-AI-TradingBot.git

# Install the Dependencies
npm init

```
- Get API Keys & Private Key:
  - Helius API Key: Sign up at helius.xyz to get an RPC URL.
  - Gemini API Key: Create a key at Google AI Studio.
  - Solana Private Key: Export your wallet's private key from your wallet's settings. NEVER SHARE THIS KEY.
 - Configure Environment:
   - create a file named .env in the project root.
   - Copy the contents of _env.example into it and fill in your keys and strategy parameters.
- Create Blacklist (Optional):
  - Create a file named blacklist.txt in the root directory.
  - Add any token names or symbols you wish to avoid, one per line.

- Run the Bot:
```bash
node index.js
```
## ⚠️ Disclaimer


This trading bot is provided "as is" and for educational purposes. Cryptocurrency trading, especially with new and volatile meme coins, is inherently high-risk. The creators and contributors of this software are not responsible for any financial losses you may incur.

You are solely responsible for managing your own risk, configuring the bot correctly, and complying with all applicable laws and regulations. Always do your own research (DYOR) and never invest more than you are willing to lose.
## 💖 Support the Project

If you find this bot useful and wish to support its development, you can leave a tip by sending SOL to the following address:

`D4cHq2xeb6RqSKydgkF6HHd4o57ZtD9nB5uKw1dp2htM`
## License

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://choosealicense.com/licenses/mit/)


## Documentation

[Documentation](https://linktodocumentation)

