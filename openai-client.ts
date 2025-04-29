import { OpenAI } from "openai";
import { createLogger } from "./logger.js";
import { MCPServerManager } from "./mcp-server.js";

// Create logger instance for API calls
const apiLogger = createLogger('OPENAI-CLIENT');

export class OpenAIClient {
  private openai: OpenAI;
  private mcpServerManager: MCPServerManager;

  constructor(apiKey: string, mcpServerManager: MCPServerManager) {
    this.openai = new OpenAI({
      apiKey: apiKey,
    });
    this.mcpServerManager = mcpServerManager;
  }

  /**
   * Handles the OpenAI tool calling and chat loop logic.
   * Extracts plain text from tool results for best model performance.
   */
  public async processQuery(query: string): Promise<string> {
    let openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: query,
      },
    ];
    
    const tools = this.mcpServerManager.getTools().map((tool) => ({
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

    return await this.processOpenAI(openaiMessages, tools, finalText);
  }

  /**
   * Helper function to recursively process OpenAI tool calls
   */
  private async processOpenAI(
    messages: OpenAI.ChatCompletionMessageParam[], 
    tools: any[], 
    finalText: string[]
  ): Promise<string> {
    try {
      apiLogger.debug('Entering processOpenAI with messages:', JSON.stringify(messages, null, 2));
      apiLogger.debug('About to call OpenAI API');
      let response;
      
      try {
        response = await this.openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || "gpt-4o",
          messages,
          max_tokens: 1000,
          tools,
        });
        apiLogger.debug('OpenAI API call completed successfully');
      } catch (apiError: unknown) {
        const errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
        apiLogger.error(`OpenAI API call failed: ${errorMessage}`);
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
          } catch (error: unknown) {
            const errorObj = error as Error;
            const errorMessage = errorObj?.message || String(error);
            apiLogger.error(`Failed to call tool ${toolName}: ${errorMessage}`);
            // Add error message as tool result
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
          const result = await this.processOpenAI(messages, tools, finalText);
          apiLogger.debug('Recursive call completed successfully');
          return result;
        } catch (recursionError: unknown) {
          const errorMessage = recursionError instanceof Error ? recursionError.message : String(recursionError);
          apiLogger.error(`Error in recursive OpenAI call: ${errorMessage}`);
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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      apiLogger.error(`Unhandled exception in processOpenAI: ${errorMessage}`);
      throw error;
    }
  }
}
