import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import path from "path";
import { Tool, MCPConfig } from "./types.js";
import { createLogger } from "./logger.js";

// Create logger instances for different components
const serverLogger = createLogger('MCPServer');

export class MCPServerManager {
  private mcpClients: Map<string, Client> = new Map();
  private mcpTransports: Map<string, StdioClientTransport> = new Map();
  private tools: Tool[] = [];
  private toolServerMap: Map<string, {serverId: string, originalName: string}> = new Map();

  constructor() {}

  /**
   * Returns the current list of tools
   */
  public getTools(): Tool[] {
    return this.tools;
  }

  /**
   * Returns the tool server map
   */
  public getToolServerMap(): Map<string, {serverId: string, originalName: string}> {
    return this.toolServerMap;
  }

  /**
   * Returns the MCP client for a specific server
   */
  public getMCPClient(serverId: string): Client | undefined {
    return this.mcpClients.get(serverId);
  }

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
   * Helper function to determine server type
   */
  private determineServerType(command: string, args: string[]) {
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
          const { isJs, isPy, isDocker, isNpx, isUvx } = this.determineServerType(command, args);
          
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
            const uvxInitialDelay = 2000; // 2 seconds initial delay for UVX
            serverLogger.info(`UVX server detected, waiting ${uvxInitialDelay}ms for initialization...`);
            await new Promise(resolve => setTimeout(resolve, uvxInitialDelay));
          }
          
          // Store the client and transport in our maps
          this.mcpClients.set(serverId, mcpClient);
          this.mcpTransports.set(serverId, transport);
          
          // Implement retry mechanism with exponential backoff for server initialization
          const maxRetries = 5;
          const initialDelayMs = 1000; // Start with 1 second delay
          let retryCount = 0;
          let toolsResult;
          
          // Since we've already added a delay for UVX servers above, we can simplify this loop
          while (retryCount < maxRetries) {
            try {
              // Attempt to retrieve tools from the server
              toolsResult = await mcpClient.listTools();
              serverLogger.info(`Successfully retrieved tools from server '${serverId}' on attempt ${retryCount + 1}`);
              break; // Success! Exit the retry loop
            } catch (error: unknown) {
              retryCount++;
              
              // Safely handle error object by checking its type
              const errorObj = error as Error;
              const errorMessage = errorObj && errorObj.message ? errorObj.message : String(error);
              
              if (retryCount >= maxRetries) {
                // If we've reached max retries, rethrow the error
                serverLogger.error(`Failed to retrieve tools from server '${serverId}' after ${maxRetries} attempts:`, errorObj);
                throw error;
              } else {
                // Calculate delay with exponential backoff
                const delayMs = initialDelayMs * Math.pow(2, retryCount);
                
                if (errorMessage.includes('Received request before initialization was complete')) {
                  // This is the specific error we're trying to handle with retries
                  serverLogger.warn(`Server '${serverId}' not initialized yet. Retrying in ${delayMs}ms... (Attempt ${retryCount}/${maxRetries})`);
                } else {
                  // For other errors, also retry but log differently
                  serverLogger.warn(`Error retrieving tools from server '${serverId}': ${errorMessage}. Retrying in ${delayMs}ms... (Attempt ${retryCount}/${maxRetries})`);
                }
                
                await new Promise(resolve => setTimeout(resolve, delayMs));
              }
            }
          }
          
          // If we've exited the retry loop without a toolsResult, something went wrong
          if (!toolsResult) {
            throw new Error(`Failed to retrieve tools from server '${serverId}' after ${maxRetries} attempts`);
          }
          
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
   * Closes all MCP client connections
   */
  public async closeConnections(): Promise<void> {
    // Close all MCP client connections
    for (const [serverId, transport] of this.mcpTransports.entries()) {
      try {
        await transport.close();
        serverLogger.info(`Closed connection to MCP server: ${serverId}`);
      } catch (error: any) {
        // Ignore EPIPE errors as they're common during shutdown
        if (error.code === 'EPIPE') {
          serverLogger.info(`EPIPE error ignored when closing connection to MCP server: ${serverId}`);
        } else {
          serverLogger.error(`Error closing connection to MCP server ${serverId}:`, error);
        }
      }
    }
    
    // Add a small delay to allow connections to fully close
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Clear maps
    this.mcpClients.clear();
    this.mcpTransports.clear();
    this.toolServerMap.clear();
    this.tools = [];
  }
}
