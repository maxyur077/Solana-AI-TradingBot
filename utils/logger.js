import chalk from "chalk";

export const logger = {
  info: (message, details = null) => {
    const detailsStr = details ? ` ${JSON.stringify(details)}` : "";
    console.log(chalk.cyan(`[INFO] ${message}${detailsStr}`));
  },
  success: (message, details = null) => {
    const detailsStr = details ? ` ${JSON.stringify(details)}` : "";
    console.log(chalk.green.bold(`[SUCCESS] ${message}${detailsStr}`));
  },
  warn: (message, details = null) => {
    const detailsStr = details ? ` ${JSON.stringify(details)}` : "";
    console.log(chalk.yellow.bold(`[WARN] ${message}${detailsStr}`));
  },
  error: (message, details = null) => {
    const detailsStr = details ? ` ${JSON.stringify(details)}` : "";
    console.log(chalk.red.bold(`[ERROR] ${message}${detailsStr}`));
  },
  pnl: (message, totalPnl) => {
    const pnlStr = totalPnl !== null ? ` | Total PnL: $${totalPnl.toFixed(4)}` : "";
    console.log(chalk.magenta(`[PNL] ${message}${pnlStr}`));
  },
  banner: (lines) => {
    console.log(chalk.bold.magenta("===================================================="));
    lines.forEach((line) => console.log(chalk.bold.magenta(line)));
    console.log(chalk.bold.magenta("===================================================="));
  },
};
