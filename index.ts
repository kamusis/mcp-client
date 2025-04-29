import readline from "readline/promises";
import dotenv from "dotenv";
import { createLogger } from "./logger.js";
import { LLM } from "./types.js";
import { MCPServerManager } from "./mcp-server.js";
import { OpenAIClient } from "./openai-client.js";
import { AnthropicClient } from "./anthropic-client.js";

// Initialize environment variables
dotenv.config();

// Create logger instances for different components
const logger = createLogger('MainLoop');

// Add global error handler for EPIPE errors
process.on('uncaughtException', (error: any) => {
  if (error.code === 'EPIPE') {
    // Silently ignore EPIPE errors which commonly occur during shutdown
    logger.info('Ignoring EPIPE error during shutdown');
    return;
  }
  // For other errors, log and exit
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

// Check for required API keys
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set");
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is not set");
}

class MCPClient {
  private mcpServerManager: MCPServerManager;
  private openaiClient: OpenAIClient;
  private anthropicClient: AnthropicClient;
  private rl: readline.Interface | null = null;
  public model: string;

  /**
   * Initializes the LLM clients (Anthropic and OpenAI) and MCP client.
   * Throws an error if required API keys are missing.
   */
  constructor() {
    this.mcpServerManager = new MCPServerManager();
    // We've already checked that these API keys exist above, so we can safely assert they're not undefined
    this.openaiClient = new OpenAIClient(OPENAI_API_KEY!, this.mcpServerManager);
    this.anthropicClient = new AnthropicClient(ANTHROPIC_API_KEY!, this.mcpServerManager);
    this.model = LLM;
  }

  /**
   * Connects to MCP servers defined in the configuration file
   */
  public async connectToServers(): Promise<void> {
    return this.mcpServerManager.connectToServers();
  }

  /**
   * Processes a user query using the selected LLM backend (Anthropic or OpenAI).
   */
  public async processQuery(query: string): Promise<string> {
    // Use global LLM constant instead of re-computing
    const llm = LLM;
    if (llm === "OPENAI") {
      return await this.openaiClient.processQuery(query);
    }
    // Default to Anthropic
    return await this.anthropicClient.processQuery(query);
  }

  /**
   * Runs the main chat loop for the CLI interface.
   */
  public async chatLoop(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  
    try {
      logger.info("MCP Client Started!");
      // Use global LLM constant instead of re-computing
      const llm = LLM;
      if (llm === "OPENAI") {
        logger.info(`Using LLM: OPENAI (model: ${process.env.OPENAI_MODEL || "gpt-4o"})`);
      } else {
        logger.info(`Using LLM: ANTHROPIC (model: ${process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022"})`);
      }
      logger.info("Type your queries or 'quit' to exit.");
  
      // Store readline interface at class level for access in event handlers
      this.rl = rl;
      
      // Note: We're not setting up additional event handlers here since we already have global handlers
      // This avoids duplicate handlers that could cause issues
  
      while (true) {
        let message;
        try {
          message = await rl.question("\nQuery: ");
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Error reading input: ${errorMessage}`);
          logger.info('\nRetrying...');
          continue;
        }
        
        // Allow both 'quit' and 'exit' to end the program
        if (["quit", "exit"].includes(message.toLowerCase())) {
          break;
        }
        
        // Check if the query is empty
        if (!message.trim()) {
          logger.info("\nQuery cannot be empty. Please try again.");
          continue;
        }
        
        try {
          const response = await this.processQuery(message);
          console.log("\n" + response); // this is the response from the LLM, will not use logger
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`\n[ERROR] Failed to process query: ${errorMessage}`);
          logger.info('\nSorry, there was an error processing your query. Please try again or type "quit" to exit.');
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`\n[CRITICAL] Fatal error in chat loop: ${errorMessage}`);
      logger.info('\nThe application will now attempt to exit gracefully.');
    } finally {
      rl.close();
    }
  }
  
  /**
   * Cleans up resources and closes the MCP client connection.
   */
  public async cleanup(): Promise<void> {
    await this.mcpServerManager.closeConnections();
  }
}

/**
 * Main entry point for the MCP client CLI.
 * Connects to MCP servers defined in the configuration file.
 */
async function main() {
  const mcpClient = new MCPClient();
  try {
    // Connect to servers, but continue even if some or all fail
    try {
      await mcpClient.connectToServers();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error connecting to MCP servers: ${errorMessage}`);
      logger.warn('Continuing without MCP server connections. Some functionality may be limited.');
    }
    
    // Start the chat loop
    await mcpClient.chatLoop();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Fatal error in main process: ${errorMessage}`);
  } finally {
    // Always try to clean up resources
    try {
      await mcpClient.cleanup();
    } catch (cleanupError: unknown) {
      const errorMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      logger.error(`Error during cleanup: ${errorMessage}`);
    }
    process.exit(0);
  }
}

main();