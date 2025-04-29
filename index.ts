import { Anthropic } from "@anthropic-ai/sdk";
import { OpenAI } from "openai";
import {
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";

// Extend the Tool type to add additional properties we need
interface Tool extends AnthropicTool {
  _serverId?: string;
  _originalName?: string;
}
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { createLogger } from "./logger.js";


dotenv.config();

// Create logger instances for different components
const logger = createLogger('MCPClient');
const serverLogger = createLogger('Server');
const apiLogger = createLogger('API');

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

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set");
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is not set");
}

/**
 * Global constant for the selected LLM backend (OPENAI or ANTHROPIC).
 * This is determined at startup and does NOT update if the environment changes at runtime.
 */
const LLM = (process.env.LLM || "ANTHROPIC").toUpperCase();

/**
 * Interface for MCP server configuration in JSON file
 */
interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Interface for the complete MCP configuration file
 */
interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

class MCPClient {
  private mcpClients: Map<string, Client> = new Map();
  private mcpTransports: Map<string, StdioClientTransport> = new Map();
  private anthropic: Anthropic;
  private openai: OpenAI;
  private tools: Tool[] = [];
  // Map to store the relationship between tool names, server IDs, and original tool names
  private toolServerMap: Map<string, {serverId: string, originalName: string}> = new Map();
  // Store readline interface for access in event handlers
  private rl: readline.Interface | null = null;
  public model: string;

  /**
   * Initializes the LLM clients (Anthropic and OpenAI) and MCP client.
   * Throws an error if required API keys are missing.
   */
  constructor() {
    this.anthropic = new Anthropic({
      apiKey: ANTHROPIC_API_KEY,
    });
    this.openai = new OpenAI({
      apiKey: OPENAI_API_KEY,
    });
    this.model = LLM;
  }

  /**
   * Connects to a single MCP server using provided configuration.
   * @param serverId Unique identifier for this server connection
   * @param serverScriptPath Path to the MCP server script
   * @param serverParams Parameters for the MCP server
   * @param serverEnv Optional environment variables for the server process
   */


  /**
   * Loads MCP configuration from a JSON file
   * @returns The parsed MCP configuration
   */
  private loadMCPConfig(): MCPConfig {
    // Get config file path from environment or use default
    const configPath = process.env.MCP_CONFIG_PATH || path.join(process.cwd(), 'mcp_config.json');
    
    try {
      // Check if file exists
      if (!fs.existsSync(configPath)) {
        throw new Error(`MCP configuration file not found at: ${configPath}`);
      }
      
      // Read and parse the config file
      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configContent) as MCPConfig;
      
      // Validate the config
      if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        throw new Error('Invalid MCP configuration: missing or invalid mcpServers object');
      }
      
      return config;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Failed to parse MCP configuration file: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Connects to MCP servers defined in the configuration file
   */
  public async connectToServers(): Promise<void> {
    try {
      // Load configuration from JSON file
      const config = this.loadMCPConfig();
      const serverConfigs = config.mcpServers;
      
      // Check if we have any server configurations
      const serverIds = Object.keys(serverConfigs);
      if (serverIds.length === 0) {
        throw new Error('No MCP servers defined in configuration file');
      }
      
      // Connect to each configured server
      let connectedServers = 0;
      
      // Helper function to determine server type
      const determineServerType = (command: string, args: string[]) => {
        // Create a string representation for detection
        const commandString = `${command} ${args.join(' ')}`;
        
        // Determine script type and appropriate command
        const isJs = command === 'node' || 
                    args.some(arg => arg.includes('.js')) || 
                    commandString.includes('.js');
        
        const isPy = command === 'python' || 
                    args.some(arg => arg.includes('.py')) || 
                    commandString.includes('.py');
        
        const isDocker = command === 'docker' || 
                        commandString.includes('docker');
        
        const isNpx = command === 'npx' || 
                     commandString.includes('npx');
        
        const isUvx = command === 'uvx' || 
                     commandString.includes('uvx');
        
        return { isJs, isPy, isDocker, isNpx, isUvx };
      };
      
      // Process servers in sequence to better isolate errors
      for (const serverId of serverIds) {
        const serverConfig = serverConfigs[serverId];
        
        // Validate server configuration
        if (!serverConfig.command || !Array.isArray(serverConfig.args)) {
          serverLogger.warn(`Invalid configuration for server '${serverId}', skipping`);
          continue;
        }
        
        try {
          serverLogger.info(`=========== CONNECTING TO SERVER: ${serverId} ===========`);
          
          // Create transport for this server
          let command = serverConfig.command;
          let args = [...serverConfig.args]; // Create a copy to avoid modifying the original
          
          // Determine server type based on command and args
          const { isJs, isPy, isDocker, isNpx, isUvx } = determineServerType(command, args);
          
          // Log server type information for debugging
          serverLogger.debug(`Server type detection for ${serverId}:`, { isJs, isPy, isDocker, isNpx, isUvx });
          
          // Following the sample code approach for handling different command types
          // Handle platform-specific command adjustments
          if (process.platform === 'win32') {
            if (isNpx) {
              // On Windows, npx needs to be called as npx.cmd
              command = 'npx.cmd';
              serverLogger.debug(`Adjusted command for Windows: ${command}`);
            } else if (isPy && command === 'python3') {
              // On Windows, python3 command is typically just 'python'
              command = 'python';
              serverLogger.debug(`Adjusted Python command for Windows: ${command}`);
            }
          } else if (isPy && command === 'python') {
            // On Unix-like systems, prefer python3 for explicit versioning
            command = 'python3';
            serverLogger.debug(`Adjusted Python command for Unix-like systems: ${command}`);
          }
          // No need to detect npx path as our config already has the command defined
          
          // Create environment with process.env and server config env
          // Ensure all environment variables are strings to satisfy type requirements
          const combinedEnv: Record<string, string> = {};
          
          // Add process.env values, ensuring they are strings
          for (const key in process.env) {
            if (process.env[key] !== undefined) {
              combinedEnv[key] = process.env[key] as string;
            }
          }
          
          // Add server config env values
          if (serverConfig.env) {
            for (const key in serverConfig.env) {
              combinedEnv[key] = serverConfig.env[key];
            }
          }
          
          const transport = new StdioClientTransport({
            command,
            args,
            env: combinedEnv,
          });

          // Debug the transport that will be used
          serverLogger.info(`Created transport configuration for server '${serverId}'`);
          serverLogger.info(`Command: ${command}`);
          serverLogger.info(`Args: ${JSON.stringify(args)}`);
          serverLogger.info(`Env: ${JSON.stringify(serverConfig.env || {})}`);
          
          // Add a small delay to ensure logs are flushed
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Create a new MCP client for this server
          const mcpClient = new Client({ 
            name: `mcp-client-cli-${serverId}`, 
            version: "1.0.0" 
          });
          
          // Connect the client to the transport
          serverLogger.info(`Connecting MCP client for server '${serverId}'...`);
          await mcpClient.connect(transport);
          
          // Add a small delay after connection to ensure initialization
          if (isUvx) {
            const uvxInitialDelay = 3000; // 3 seconds initial delay for UVX
            serverLogger.info(`UVX server detected, waiting ${uvxInitialDelay}ms for initialization...`);
            await new Promise(resolve => setTimeout(resolve, uvxInitialDelay));
          }
          
          // Store the client and transport in our maps
          this.mcpClients.set(serverId, mcpClient);
          this.mcpTransports.set(serverId, transport);
          
          // Retrieve and store available tools from this server
          const toolsResult = await mcpClient.listTools();
          const serverTools = toolsResult.tools.map((tool) => {
            // Create a unique tool name by prefixing with server ID
            const uniqueToolName = `${serverId}_${tool.name}`;
            
            // Store the association between unique tool name, server ID, and original tool name in the map
            this.toolServerMap.set(uniqueToolName, {
              serverId: serverId,
              originalName: tool.name
            });
            
            // Return a tool object that complies with Anthropic API requirements
            return {
              name: uniqueToolName,  // Use the unique prefixed tool name
              description: `[${serverId}] ${tool.description}`,  // Add server ID to the description
              input_schema: tool.inputSchema
            };
          });
          
          // Add these tools to our combined tools list
          this.tools = [...this.tools, ...serverTools];
          
          serverLogger.info(
            `Connected to server '${serverId}' with tools:`,
            serverTools.map(({ name }) => name)
          );
          
          connectedServers++;
        } catch (error) {
          serverLogger.error(`Failed to connect to MCP server '${serverId}':`, error);
          // Continue with other servers even if one fails
        }
      }
      
      if (connectedServers === 0) {
        serverLogger.warn('Warning: Failed to connect to any MCP servers. Client will continue running but MCP tool functionality will be unavailable.');
      }
      
      serverLogger.info(`Successfully connected to ${connectedServers} MCP servers with a total of ${this.tools.length} tools`);
    } catch (error) {
      serverLogger.error('Error connecting to MCP servers:', error);
      throw error;
    }
  }

  /**
   * Processes a user query using the selected LLM backend (Anthropic or OpenAI).
   * If LLM=OPENAI, throws an error (OpenAI logic not implemented yet).
   * If LLM=ANTHROPIC or unset, uses Anthropic Claude as before.
   */
  public async processQuery(query: string): Promise<string> {
    // Use global LLM constant instead of re-computing
    const llm = LLM;
    if (llm === "OPENAI") {
      return await this.callOpenAI(query);
    }
    // Default to Anthropic
    return await this.callAnthropic(query);
  }

  /**
   * Handles the OpenAI tool calling and chat loop logic.
   * Extracts plain text from tool results for best model performance.
   */
  private async callOpenAI(query: string): Promise<string> {
  let openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "user",
      content: query,
    },
  ];
  const tools = this.tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || {},
    },
  }));
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const finalText: string[] = [];
  apiLogger.debug("Starting OpenAI tool calling (Anthropic-style chain)");

  // Helper function to recursively process OpenAI tool calls
  const processOpenAI = async (messages: OpenAI.ChatCompletionMessageParam[]): Promise<string> => {
    try {
      apiLogger.debug('Entering processOpenAI with messages:', JSON.stringify(messages, null, 2));
      apiLogger.debug('About to call OpenAI API');
      let response;
      try {
        response = await this.openai.chat.completions.create({
          model,
          messages,
          max_tokens: 1000,
          tools,
        });
        apiLogger.debug('OpenAI API call completed successfully');
      } catch (apiError) {
        apiLogger.error('OpenAI API call failed:', apiError);
        throw apiError;
      }
      
      apiLogger.debug('Full OpenAI API response:', JSON.stringify(response, null, 2));
      const choice = response.choices[0];
      const msg = choice.message;
      apiLogger.debug('OpenAI response message:', JSON.stringify(msg, null, 2));
    // If we get a final assistant message with content, return it
    if (msg.role === "assistant" && msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      finalText.push(msg.content);
      apiLogger.debug(`Assistant message received. Returning.`);
      apiLogger.debug('Exiting processOpenAI. Returning:', finalText.join("\n"));
      return finalText.join("\n");
    }
    // If there are tool calls, handle each (new API)
    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // Add the assistant's message with tool_calls to the history
      messages.push({
        role: "assistant",
        content: msg.content,
        tool_calls: msg.tool_calls
      });
      
      apiLogger.debug('Added assistant message with tool_calls to history');
      
      for (const toolCall of msg.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs: any = {};
        try {
          toolArgs = toolCall.function.arguments
            ? JSON.parse(toolCall.function.arguments)
            : {};
        } catch (e) {
          toolArgs = {};
        }
        apiLogger.debug(`Tool call requested: ${toolName} with args ${JSON.stringify(toolArgs)}`);
        // Find the tool matching the name and its server ID
        let serverId = 'default';
        let originalToolName = toolName;
        
        // Look up server information for this tool from the map
        const toolServerInfo = this.toolServerMap.get(toolName);
        if (toolServerInfo) {
          serverId = toolServerInfo.serverId;
          originalToolName = toolServerInfo.originalName;
        }
        
        try {
          // Get the appropriate MCP client for this server
          const mcpClient = this.mcpClients.get(serverId);
          if (!mcpClient) {
            throw new Error(`No MCP client found for server ID: ${serverId}`);
          }
          
          apiLogger.debug(`Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}`);
          // Call the tool using the appropriate MCP client
          const result = await mcpClient.callTool({
            name: originalToolName,  // Use the original tool name without server prefix
            arguments: toolArgs,
          });
          apiLogger.debug(`Tool result for ${toolName}:`, result.content);
          let toolContent = result.content;
          if (Array.isArray(toolContent) && toolContent[0]?.type === "text") {
            toolContent = toolContent.map((c: any) => c.text).join("\n");
          }
          
          // Push tool call log for debugging
          finalText.push(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`);
          // Add tool result as a tool message
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolContent as string,
          });
          apiLogger.debug(`Tool message appended for ${toolName}.`);
        } catch (error) {
          apiLogger.error(`Failed to call tool ${toolName}:`, error);
          // Add error message as tool result
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          finalText.push(`[Error calling tool ${toolName}: ${errorMessage}]`);
          // Add error as tool message so the LLM can handle it
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error: ${errorMessage}. The tool call failed, please try a different approach or continue without this tool.`,
          });
          apiLogger.debug(`Error message appended for ${toolName}.`);
          // Continue with next tool call instead of crashing
          continue;
        }
      }
      apiLogger.debug(`Recursively calling OpenAI with updated messages.`);
      try {
        const result = await processOpenAI(messages);
        apiLogger.debug('Recursive call completed successfully');
        return result;
      } catch (recursionError) {
        apiLogger.error('Error in recursive OpenAI call:', recursionError);
        throw recursionError;
      }
    }
    // No tool calls, return what we have
    if (!msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      apiLogger.debug(`Returning early: assistant message has no content and no tool_calls. Message object:`, JSON.stringify(msg, null, 2));
    } else if (!msg.tool_calls || msg.tool_calls.length === 0) {
      apiLogger.debug(`Returning: assistant message has content but no tool_calls. Message object:`, JSON.stringify(msg, null, 2));
    } else {
      apiLogger.debug(`Returning: unknown early exit condition. Message object:`, JSON.stringify(msg, null, 2));
    }
    apiLogger.debug('Exiting processOpenAI. Returning:', finalText.join("\n"));
    return finalText.join("\n");
    } catch (error) {
      apiLogger.error('Unhandled exception in processOpenAI:', error);
      throw error;
    }
  };

// Wrap main processQuery with error handling
const originalProcessQuery = MCPClient.prototype.processQuery;
MCPClient.prototype.processQuery = async function(query: string) {
  try {
    return await originalProcessQuery.call(this, query);
  } catch (e) {
    logger.error('Unhandled exception in processQuery:', e);
    // Return error message to user instead of crashing
    const errorMessage = e instanceof Error ? e.message : 'Unknown error occurred';
    return `Error processing query: ${errorMessage}. Please try again or use a different query.`;
  }
};
  return await processOpenAI(openaiMessages);
}

  /**
   * Handles the Anthropic tool calling and chat loop logic.
   * Sends tool results as user messages for Claude models.
   */
  private async callAnthropic(query: string): Promise<string> {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: query,
      },
    ];
    const response = await this.anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
      max_tokens: 1000,
      messages,
      tools: this.tools,
    });
    const finalText = [];
    const toolResults = [];
    for (const content of response.content) {
      if (content.type === "text") {
        finalText.push(content.text);
      } else if (content.type === "tool_use") {
        const toolName = content.name;
        const toolArgs = content.input as { [x: string]: unknown } | undefined;
        // Find the tool matching the name and its server ID
        let serverId = 'default';
        let originalToolName = toolName;
        
        // Look up server information for this tool from the map
        const toolServerInfo = this.toolServerMap.get(toolName);
        if (toolServerInfo) {
          serverId = toolServerInfo.serverId;
          originalToolName = toolServerInfo.originalName;
        }
        
        try {
          // Get the appropriate MCP client for this server
          const mcpClient = this.mcpClients.get(serverId);
          if (!mcpClient) {
            throw new Error(`No MCP client found for server ID: ${serverId}`);
          }
          
          // Call the tool using the appropriate MCP client
          const result = await mcpClient.callTool({
            name: originalToolName,  // Use the original tool name without server prefix
            arguments: toolArgs,
          });
          toolResults.push(result);
          finalText.push(
            `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
          );
          
          // Add tool result as a user message
          messages.push({
            role: "user",
            content: `Tool result for ${toolName}: ${JSON.stringify(result.content)}`,
          });
        } catch (error: any) {
          apiLogger.error(`Failed to call tool ${toolName}:`, error);
          
          // Check if this is a connection closed error
          const isConnectionClosed = error.message && error.message.includes('Connection closed');
          
          // If it's a connection closed error, remove the server from the maps
          if (isConnectionClosed) {
            apiLogger.warn(`MCP client for server '${serverId}' has disconnected. Removing from available servers.`);
            this.mcpClients.delete(serverId);
            this.mcpTransports.delete(serverId);
            
            // Remove all tools associated with this server
            const toolsToRemove = [];
            for (const [toolName, info] of this.toolServerMap.entries()) {
              if (info.serverId === serverId) {
                toolsToRemove.push(toolName);
              }
            }
            
            // Remove tools from the tool map and tool list
            for (const toolName of toolsToRemove) {
              this.toolServerMap.delete(toolName);
            }
            this.tools = this.tools.filter(tool => {
              const info = this.toolServerMap.get(tool.name);
              return info && info.serverId !== serverId;
            });
          }
          
          // Add error message as tool result
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          finalText.push(`[Error calling tool ${toolName}: ${errorMessage}]`);
          
          // Add error message as a user message so the LLM can handle the error situation
          messages.push({
            role: "user",
            content: `Error when calling tool ${toolName}: ${errorMessage}. Please try a different approach or continue without this tool.`,
          });
          
          // Continue processing other tool calls instead of throwing an error
          continue;
        }
        
        // Note: This part of the code has already been handled in the try block, no need to repeat
        // Previous code has already added the message, so we don't need to add it again here
        const response = await this.anthropic.messages.create({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1000,
          messages,
        });
        finalText.push(
          response.content[0].type === "text" ? response.content[0].text : ""
        );
      }
    }
    return finalText.join("\n");
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
      
      // Set up event handlers for unexpected errors
      process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception:', error);
        logger.info('The application encountered an uncaughtException error but will continue running.');
        logger.info('You may continue using the chat or type "quit" to exit.');
        // Force readline to redisplay the prompt
        process.stdout.write('\nQuery: ');
      });
      
      process.on('unhandledRejection', (reason, promise) => {
        logger.error('Unhandled promise rejection:', reason);
        logger.info('The application encountered an unhandledRejection error but will continue running.');
        logger.info('You may continue using the chat or type "quit" to exit.');
        // Force readline to redisplay the prompt
        process.stdout.write('\nQuery: ');
      });
  
      while (true) {
        let message;
        try {
          message = await rl.question("\nQuery: ");
        } catch (error) {
          logger.error('Error reading input:', error);
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
          logger.info("\n" + response);
        } catch (error) {
          logger.error('\n[ERROR] Failed to process query:', error);
          logger.info('\nSorry, there was an error processing your query. Please try again or type "quit" to exit.');
          
          // Check if any MCP clients are still connected
          let connectedClients = 0;
          for (const [serverId, mcpClient] of this.mcpClients.entries()) {
            try {
              // Try a simple operation to check if the client is still connected
              await mcpClient.listTools();
              connectedClients++;
            } catch (e) {
              logger.warn(`MCP client for server '${serverId}' appears to be disconnected.`);
              // Remove the disconnected client from our maps
              this.mcpClients.delete(serverId);
              this.mcpTransports.delete(serverId);
              
              // Remove tools associated with this server
              this.tools = this.tools.filter(tool => tool._serverId !== serverId);
            }
          }
          
          if (connectedClients === 0 && this.mcpClients.size > 0) {
            logger.warn('All MCP servers have disconnected. Continuing with LLM-only functionality.');
            this.mcpClients.clear();
            this.mcpTransports.clear();
            this.tools = [];
          }
        }
      }
    } catch (error) {
      logger.error('\n[CRITICAL] Fatal error in chat loop:', error);
      logger.info('\nThe application will now attempt to exit gracefully.');
    } finally {
      rl.close();
    }
  }
  
  /**
   * Closes all MCP client connections
   */
  private async closeConnections(): Promise<void> {
    // Close all MCP client connections
    for (const [serverId, transport] of this.mcpTransports.entries()) {
      try {
        await transport.close();
        logger.info(`Closed connection to MCP server: ${serverId}`);
      } catch (error: any) {
        // Ignore EPIPE errors as they're common during shutdown
        if (error.code === 'EPIPE') {
          logger.info(`EPIPE error ignored when closing connection to MCP server: ${serverId}`);
        } else {
          logger.error(`Error closing connection to MCP server ${serverId}:`, error);
        }
      }
    }
    
    // Add a small delay to allow connections to fully close
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Clear maps
    this.mcpClients.clear();
    this.mcpTransports.clear();
    this.toolServerMap.clear();
  }

  /**
   * Cleans up resources and closes the MCP client connection.
   */
  public async cleanup(): Promise<void> {
    await this.closeConnections();
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
    } catch (error) {
      logger.error('Error connecting to MCP servers:', error);
      logger.warn('Continuing without MCP server connections. Some functionality may be limited.');
    }
    
    // Start the chat loop
    await mcpClient.chatLoop();
  } catch (error) {
    logger.error('Fatal error in main process:', error);
  } finally {
    // Always try to clean up resources
    try {
      await mcpClient.cleanup();
    } catch (cleanupError) {
      logger.error('Error during cleanup:', cleanupError);
    }
    process.exit(0);
  }
}

main();