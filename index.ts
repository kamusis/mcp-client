import readline from "readline/promises";
import dotenv from "dotenv";
import { createLogger } from "./logger.js";
import { LLM, ChatMessage, MAX_CHAT_TURNS } from "./types.js";
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
  private chatHistory: ChatMessage[] = [];
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
   * @param query - The user's query to process
   * @returns A string response from the model
   */
  public async processQuery(query: string): Promise<string> {
    // Use global LLM constant instead of re-computing
    const llm = LLM;
    let response: string;
    
    // Pass chat history to the appropriate client
    if (llm === "OPENAI") {
      response = await this.openaiClient.processQuery(query, this.chatHistory);
    } else {
      // Default to Anthropic
      response = await this.anthropicClient.processQuery(query, this.chatHistory);
    }
    
    // Add the new messages to chat history
    this.addToChatHistory(query, response);
    
    return response;
  }
  
  /**
   * Adds a user query and model response to the chat history
   * @param query - The user's query
   * @param response - The model's response
   */
  private addToChatHistory(query: string, response: string): void {
    // Add user message to chat history
    this.chatHistory.push({ role: "user", content: query });
    
    // Extract tool calls and responses from the model's response if present
    // This is a simplified approach - in a real implementation we would parse the
    // actual tool call information from the LLM response
    
    // For this implementation, we'll just add the assistant response
    // The actual tool calls will be handled by the respective LLM clients
    this.chatHistory.push({ role: "assistant", content: response });
    
    // Manage maximum chat history
    this.pruneHistory();
  }
  
  /**
   * Ensures chat history doesn't exceed the maximum number of turns
   * Removes oldest turns (user + assistant message pairs) when necessary
   */
  private pruneHistory(): void {
    // Get the current number of turns we have
    // A turn typically consists of a user message followed by an assistant response
    // and possibly tool messages in between
    
    // Check if we need to remove history
    if (this.chatHistory.length > MAX_CHAT_TURNS * 2) {
      logger.warn(`Chat history exceeding ${MAX_CHAT_TURNS} turns limit. Removing oldest turn.`);
    }
    
    // Count sequences of user→assistant as turns, removing oldest sequences first
    while (this.chatHistory.length > MAX_CHAT_TURNS * 2) {
      // Remove the oldest chunk of conversation (typically a user message and all responses)
      // Find the next user message after the current one
      let firstUserMsgIndex = 0; // Start with first message
      let secondUserMsgIndex = -1;
      
      // Find second user message
      for (let i = 1; i < this.chatHistory.length; i++) {
        if (this.chatHistory[i].role === "user") {
          secondUserMsgIndex = i;
          break;
        }
      }
      
      if (secondUserMsgIndex > 0) {
        // Remove all messages up to but not including second user message
        this.chatHistory.splice(0, secondUserMsgIndex);
      } else {
        // Only one user message found, which means we don't have enough history
        // to worry about pruning yet
        break;
      }
    }
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