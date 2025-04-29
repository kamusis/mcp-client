import { Anthropic } from "@anthropic-ai/sdk";
import { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { createLogger } from "./logger.js";
import { MCPServerManager } from "./mcp-server.js";

// Create logger instance for API calls
const apiLogger = createLogger('ANTHROPIC-CLIENT');

export class AnthropicClient {
  private anthropic: Anthropic;
  private mcpServerManager: MCPServerManager;

  constructor(apiKey: string, mcpServerManager: MCPServerManager) {
    this.anthropic = new Anthropic({
      apiKey: apiKey,
    });
    this.mcpServerManager = mcpServerManager;
  }

  /**
   * Handles the Anthropic tool calling and chat loop logic.
   * Sends tool results as user messages for Claude models.
   */
  public async processQuery(query: string): Promise<string> {
    // Create initial message with user query
    const messages: Array<MessageParam> = [
      {
        role: "user",
        content: query,
      },
    ];
    
    // Get the tools from the MCP server manager
    const tools = this.mcpServerManager.getTools();
    
    // Create the initial response from Anthropic
    const response = await this.anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
      max_tokens: 1000,
      messages: messages,
      tools: tools,
    });
    
    const finalText: string[] = [];
    
    // Process the response content
    for (const content of response.content) {
      if (content.type === "text") {
        // Add text content to the final output
        finalText.push(content.text);
      } else if (content.type === "tool_use") {
        // Handle tool use
        const toolName = content.name;
        const toolArgs = content.input as Record<string, unknown>;
        
        // Find the tool matching the name and its server ID
        let serverId = 'default';
        let originalToolName = toolName;
        
        // Look up server information for this tool from the map
        const toolServerMap = this.mcpServerManager.getToolServerMap();
        const toolServerInfo = toolServerMap.get(toolName);
        
        if (toolServerInfo) {
          serverId = toolServerInfo.serverId;
          originalToolName = toolServerInfo.originalName;
        }
        
        try {
          // Get the appropriate MCP client for this server
          const mcpClient = this.mcpServerManager.getMCPClient(serverId);
          if (!mcpClient) {
            throw new Error(`No MCP client found for server ID: ${serverId}`);
          }
          
          // Call the tool using the appropriate MCP client
          const result = await mcpClient.callTool({
            name: originalToolName,  // Use the original tool name without server prefix
            arguments: toolArgs,
          });
          
          // Add tool call information to the final output
          finalText.push(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`);
          
          // Add tool result as a user message
          const userMessage: MessageParam = {
            role: "user",
            content: `Tool result for ${toolName}: ${JSON.stringify(result.content)}`,
          };
          messages.push(userMessage);
          
          // Get a follow-up response from the model
          const followUpResponse = await this.anthropic.messages.create({
            model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
            max_tokens: 1000,
            messages: messages,
          });
          
          // Add the follow-up response to the final output
          if (followUpResponse.content[0]?.type === "text") {
            finalText.push(followUpResponse.content[0].text);
          }
        } catch (error: unknown) {
          // Handle errors
          apiLogger.error(`Failed to call tool ${toolName}:`, error);
          
          // Extract error message
          const errorObj = error as Error;
          const errorMessage = errorObj?.message || String(error);
          
          // Check if this is a connection closed error
          const isConnectionClosed = errorMessage.includes('Connection closed');
          
          // If it's a connection closed error, notify the server manager
          if (isConnectionClosed) {
            apiLogger.warn(`MCP client for server '${serverId}' has disconnected.`);
          }
          
          // Add error message as tool result
          finalText.push(`[Error calling tool ${toolName}: ${errorMessage}]`);
          
          // Add error message as a user message so the LLM can handle the error situation
          const errorUserMessage: MessageParam = {
            role: "user",
            content: `Error when calling tool ${toolName}: ${errorMessage}. Please try a different approach or continue without this tool.`,
          };
          messages.push(errorUserMessage);
          
          // Get a follow-up response after the error
          try {
            const errorFollowUpResponse = await this.anthropic.messages.create({
              model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
              max_tokens: 1000,
              messages: messages,
            });
            
            // Add the follow-up response to the final output
            if (errorFollowUpResponse.content[0]?.type === "text") {
              finalText.push(errorFollowUpResponse.content[0].text);
            }
          } catch (followUpError) {
            apiLogger.error(`Failed to get follow-up response after tool error:`, followUpError);
          }
        }
      }
    }
    
    // Join all the text pieces with newlines
    return finalText.join("\n");
  }
}
