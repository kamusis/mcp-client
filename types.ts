import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";

/**
 * Extend the Tool type to add additional properties we need
 */
export interface Tool extends AnthropicTool {
  _serverId?: string;
  _originalName?: string;
}

/**
 * Interface for MCP server configuration in JSON file
 */
export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Interface for the complete MCP configuration file
 */
export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * Interface for a chat message
 */
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string; // Required for tool messages
}

/**
 * Maximum number of chat turns to keep in history
 * Each turn consists of a user message and an assistant response
 */
export const MAX_CHAT_TURNS = 30;

/**
 * Global constant for the selected LLM backend (OPENAI or ANTHROPIC).
 * This is determined at startup and does NOT update if the environment changes at runtime.
 */
export const LLM = (process.env.LLM || "ANTHROPIC").toUpperCase();
