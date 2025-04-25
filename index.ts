import { Anthropic } from "@anthropic-ai/sdk";
import { OpenAI } from "openai";
import {
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";


dotenv.config();

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

class MCPClient {
  private mcp: Client;
  private anthropic: Anthropic;
  private openai: OpenAI;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];

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
    this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  }

  /**
   * Connects to the MCP server using configuration from environment variables.
   * Reads MCP_SERVER_PATH and MCP_SERVER_PARAMS from process.env.
   * Throws an error if either variable is missing.
   */
  /**
   * Connects to the MCP server using configuration from environment variables.
   * Reads MCP_SERVER_PATH and MCP_SERVER_PARAMS from process.env.
   * Throws an error if either variable is missing.
   */
  public async connectToServer(): Promise<void> {
    // Read MCP server path and server parameters from environment variables
    const serverScriptPath = process.env.MCP_SERVER_PATH;
    const serverParams = process.env.MCP_SERVER_PARAMS;
    if (!serverScriptPath || !serverParams) {
      throw new Error("MCP_SERVER_PATH or MCP_SERVER_PARAMS is not set in environment variables (.env)");
    }
    try {
      // Only support .js or .py files
      const isJs = serverScriptPath.endsWith(".js");
      const isPy = serverScriptPath.endsWith(".py");
      if (!isJs && !isPy) {
        throw new Error("Server script must be a .js or .py file");
      }
      // Choose the correct command for the script type
      const command = isPy
        ? process.platform === "win32"
          ? "python"
          : "python3"
        : process.execPath;
      // Pass both the script path and connection string as arguments
      // Prepare environment variables for the MCP server process
      const serverEnv: Record<string, string> = {};
      // Only include relevant MCP server env variables if they are set
      if (process.env.TRANSACTION_TIMEOUT_MS) serverEnv.TRANSACTION_TIMEOUT_MS = process.env.TRANSACTION_TIMEOUT_MS;
      if (process.env.MAX_CONCURRENT_TRANSACTIONS) serverEnv.MAX_CONCURRENT_TRANSACTIONS = process.env.MAX_CONCURRENT_TRANSACTIONS;
      if (process.env.PG_STATEMENT_TIMEOUT_MS) serverEnv.PG_STATEMENT_TIMEOUT_MS = process.env.PG_STATEMENT_TIMEOUT_MS;
      // Pass the env option to StdioClientTransport
      this.transport = new StdioClientTransport({
        command,
        args: [serverScriptPath, serverParams], // Pass script path and params to server
        env: serverEnv,
      });
      this.mcp.connect(this.transport);
      // Retrieve and store available tools
      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map((tool) => {
        return {
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        };
      });
      console.log(
        "Connected to server with tools:",
        this.tools.map(({ name }) => name)
      );
    } catch (e) {
      console.log("Failed to connect to MCP server: ", e);
      throw e;
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
  console.debug("[DEBUG] Starting OpenAI tool calling (Anthropic-style chain)");

  // Helper function to recursively process OpenAI tool calls
  const processOpenAI = async (messages: OpenAI.ChatCompletionMessageParam[]): Promise<string> => {
    try {
      console.debug('[DEBUG] Entering processOpenAI with messages:', JSON.stringify(messages, null, 2));
      console.debug('[DEBUG] About to call OpenAI API');
      let response;
      try {
        response = await this.openai.chat.completions.create({
          model,
          messages,
          max_tokens: 1000,
          tools,
        });
        console.debug('[DEBUG] OpenAI API call completed successfully');
      } catch (apiError) {
        console.error('[ERROR] OpenAI API call failed:', apiError);
        throw apiError;
      }
      
      //console.debug('[DEBUG] Full OpenAI API response:', JSON.stringify(response, null, 2));
      const choice = response.choices[0];
      const msg = choice.message;
      console.debug(`[DEBUG] OpenAI response message:`, JSON.stringify(msg, null, 2));
    // If we get a final assistant message with content, return it
    if (msg.role === "assistant" && msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      finalText.push(msg.content);
      console.debug(`[DEBUG] Assistant message received. Returning.`);
      console.debug('[DEBUG] Exiting processOpenAI. Returning:', finalText.join("\n"));
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
      
      console.debug(`[DEBUG] Added assistant message with tool_calls to history`);
      
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
        console.debug(`[DEBUG] Tool call requested: ${toolName} with args ${JSON.stringify(toolArgs)}`);
        // Call the tool using MCP
        const result = await this.mcp.callTool({
          name: toolName,
          arguments: toolArgs,
        });
        console.debug(`[DEBUG] Tool result for ${toolName}:`, result.content);
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
        console.debug(`[DEBUG] Tool message appended for ${toolName}.`);
      }
      console.debug(`[DEBUG] Recursively calling OpenAI with updated messages.`);
      try {
        const result = await processOpenAI(messages);
        console.debug('[DEBUG] Recursive call completed successfully');
        return result;
      } catch (recursionError) {
        console.error('[ERROR] Error in recursive OpenAI call:', recursionError);
        throw recursionError;
      }
    }
    // No tool calls, return what we have
    if (!msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      console.debug(`[DEBUG] Returning early: assistant message has no content and no tool_calls. Message object:`, JSON.stringify(msg, null, 2));
    } else if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.debug(`[DEBUG] Returning: assistant message has content but no tool_calls. Message object:`, JSON.stringify(msg, null, 2));
    } else {
      console.debug(`[DEBUG] Returning: unknown early exit condition. Message object:`, JSON.stringify(msg, null, 2));
    }
    console.debug('[DEBUG] Exiting processOpenAI. Returning:', finalText.join("\n"));
    return finalText.join("\n");
    } catch (error) {
      console.error('[ERROR] Unhandled exception in processOpenAI:', error);
      throw error;
    }
  };

// Wrap main processQuery with error handling
const originalProcessQuery = MCPClient.prototype.processQuery;
MCPClient.prototype.processQuery = async function(query: string) {
  try {
    return await originalProcessQuery.call(this, query);
  } catch (e) {
    console.error('[ERROR] Unhandled exception in processQuery:', e);
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
        const result = await this.mcp.callTool({
          name: toolName,
          arguments: toolArgs,
        });
        toolResults.push(result);
        finalText.push(
          `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
        );
        messages.push({
          role: "user",
          content: result.content as string,
        });
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
      console.log("\nMCP Client Started!");
      // Use global LLM constant instead of re-computing
      const llm = LLM;
      if (llm === "OPENAI") {
        console.log(`Using LLM: OPENAI (model: ${process.env.OPENAI_MODEL || "gpt-4o"})`);
      } else {
        console.log(`Using LLM: ANTHROPIC (model: ${process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022"})`);
      }
      console.log("Type your queries or 'quit' to exit.");
  
      while (true) {
        const message = await rl.question("\nQuery: ");
        // Allow both 'quit' and 'exit' to end the program
        if (["quit", "exit"].includes(message.toLowerCase())) {
          break;
        }
        const response = await this.processQuery(message);
        console.log("\n" + response);
      }
    } finally {
      rl.close();
    }
  }
  
  /**
   * Cleans up resources and closes the MCP client connection.
   */
  public async cleanup(): Promise<void> {
    await this.mcp.close();
  }
}



/**
 * Main entry point for the MCP client CLI.
 * For testing, connects to a hardcoded MCP server.
 */
async function main() {
  const mcpClient = new MCPClient();
  try {
    await mcpClient.connectToServer();
    await mcpClient.chatLoop();
  } finally {
    await mcpClient.cleanup();
    process.exit(0);
  }
}

main();