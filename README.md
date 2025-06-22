Advanced Solana AI Trading Bot

A professional-grade, automated trading bot for sniping new meme coins on the Solana blockchain, developed by software developer and crypto enthusiast Mayur Maskar.

🚀 Table of Contents

Key Features

Prerequisites

Installation & Setup

Configuration

Running the Bot

Safety & Security

Support & Tips

License

🔑 Key Features

AI-Powered Decisions: Integrates with Google Gemini API to analyze token names and symbols for viral potential.

Dynamic, Risk-Adjusted Trading: Adjusts strategy based on a token's risk profile from rugcheck.xyz.

Variable Trade Sizing: Smaller stakes on DANGER tokens, larger bets on GOOD tokens.

Custom Take-Profit & Stop-Loss: Fully configurable rules per risk level.

Advanced Pre-Trade Vetting:

Liquidity threshold checks

100% locked liquidity requirement

Renounced mint/freeze authority verification

Holder concentration analysis

Intelligent Profit Protection:

Trailing stop-loss

Time-based auto-sell for stale trades

Robust & Reliable:

Automatic retries on failures

Priority fee management via Jupiter API

Blacklist support to skip unwanted tokens

Comprehensive Logging:

SQLite database for all trades and events

Live, color-coded console output

Real-time profit & loss (P&L) tracking in USD

🛠️ Prerequisites

Node.js v18.0 or higher

Git for cloning the repository

API keys for Helius and Google Gemini

A Solana wallet private key (keep secure!)

📥 Installation & Setup

# Clone the repository

git clone https://github.com/your-username/solana-ai-bot.git
cd solana-ai-bot

# Initialize and install dependencies

npm install

⚙️ Configuration

Environment Variables: Rename \_env.example to .env and fill in the following keys:

HELIUS_API_KEY=your-helius-key
GEMINI_API_KEY=your-gemini-key
SOLANA_PRIVATE_KEY=your-base58-private-key

# Strategy parameters (customize!)

RISK_GOOD=0.5
RISK_DANGER=0.1
TAKE_PROFIT_GOOD=1.2
STOP_LOSS_DANGER=0.8
...

Blacklist (Optional): Create blacklist.txt in the project root and list any tokens (name or symbol) to ignore, one per line.

▶️ Running the Bot

# Start the trading bot

node index.js

The bot will perform all pre-trade checks, execute buys/sells, and log events to both console and SQLite database.

🛡️ Safety & Security

Never share your private key or .env file.

This bot is provided as-is for educational purposes. Trading meme coins is high-risk.

Always run on a test wallet before committing significant funds.

Comply with all applicable regulations in your jurisdiction.
