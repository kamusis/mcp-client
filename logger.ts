
/**
 * Centralized logging utility for consistent logging across the application
 * Uses Node.js built-in console for logging
 */
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Define log levels
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

// Set default log level to 'info' to avoid showing debug logs
let currentLogLevel: LogLevel = 'info';

// Allow overriding via environment variable
if (process.env.LOG_LEVEL && ['debug', 'info', 'warn', 'error'].includes(process.env.LOG_LEVEL)) {
  currentLogLevel = process.env.LOG_LEVEL as LogLevel;
}

// Define log level priorities (higher number = more important)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  'error': 3,
  'warn': 2,
  'info': 1,
  'debug': 0
};

// Helper function to format date consistently
function getFormattedDate(): string {
  const now = new Date();
  return now.toISOString();
}

// Helper function to check if a message should be logged based on current log level
function shouldLog(messageLevel: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[messageLevel] >= LOG_LEVEL_PRIORITY[currentLogLevel];
}

/**
 * Creates a logger instance for a specific module
 * @param module The module name to be included in log messages
 * @returns A logger object with methods for different log levels
 */
export function createLogger(module: string) {
  return {
    debug: (...args: unknown[]) => {
      if (shouldLog('debug')) {
        console.debug(`DEBUG [${getFormattedDate()}] [${module}]`, ...args);
      }
    },
    info: (...args: unknown[]) => {
      if (shouldLog('info')) {
        console.info(`INFO [${getFormattedDate()}] [${module}]`, ...args);
      }
    },
    warn: (...args: unknown[]) => {
      if (shouldLog('warn')) {
        console.warn(`WARN [${getFormattedDate()}] [${module}]`, ...args);
      }
    },
    error: (...args: unknown[]) => {
      if (shouldLog('error')) {
        console.error(`ERROR [${getFormattedDate()}] [${module}]`, ...args);
      }
    },
    setLevel: (level: LogLevel) => {
      currentLogLevel = level;
    }
  };
}

/**
 * Set the global log level
 * @param level The log level to set
 */
export function setLogLevel(level: LogLevel) {
  currentLogLevel = level;
}
