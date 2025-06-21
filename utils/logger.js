import chalk from "chalk";

export const logger = {
  info: (message, ...args) => {
    console.log(chalk.cyan(message), ...args);
  },
  success: (message, ...args) => {
    console.log(chalk.green.bold(message), ...args);
  },
  warn: (message, ...args) => {
    console.log(chalk.yellow.bold(message), ...args);
  },
  error: (message, ...args) => {
    console.log(chalk.red.bold(message), ...args);
  },
};
