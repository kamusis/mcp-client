# MCP Client

A TypeScript client for the Model Context Protocol (MCP) that enables communication between language models and external MCP server tools/services.

## Overview

This MCP client provides a flexible interface for connecting to various MCP servers, allowing language models like OpenAI's GPT and Anthropic's Claude to access external tools and services through a standardized protocol. The client supports multiple server types and handles cross-platform compatibility.

## Features

- Connect to multiple MCP servers simultaneously
- Support for both OpenAI and Anthropic language models
- Cross-platform compatibility (Windows, macOS, Linux)
- Automatic handling of platform-specific commands
- Configurable environment variables

## Prerequisites

- Node.js (v16+)
- npm or yarn
- TypeScript

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/kamusis/mcp-client.git
   cd mcp-client
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the project root with your API keys:
   ```
   # LLM (OPENAI or ANTHROPIC)
   LLM=OPENAI
   OPENAI_MODEL=gpt-4o
   ANTHROPIC_MODEL=claude-3-5-sonnet-20241022

   # LLM API Key
   ANTHROPIC_API_KEY=your_anthropic_api_key
   OPENAI_API_KEY=your_openai_api_key

   # MCP Configuration File Path (optional, defaults to ./mcp_config.json)
   # MCP_CONFIG_PATH=./mcp_config.json
   ```

4. Configure your MCP servers in `mcp_config.json`:
   ```json
   {
     "mcpServers": {
       "sequential-thinking": {
         "command": "npx",
         "args": [
           "-y",
           "@modelcontextprotocol/server-sequential-thinking"
         ]
       },
       "postgres-full-localhost-dev": {
         "command": "node",
         "args": [
           "/path/to/mcp-postgres-full-access-extended/dist/index.js",
           "postgresql://postgres:postgres@127.0.0.1:5432/postgres"
         ],
         "env": {
           "TRANSACTION_TIMEOUT_MS": "60000",
           "MAX_CONCURRENT_TRANSACTIONS": "20",
           "PG_STATEMENT_TIMEOUT_MS": "30000"
         }
       }
     }
   }
   ```

## Building and Running

1. Build the project:
   ```bash
   npm run build
   ```

2. Run the client:
   ```bash
   node build/index.js
   ```

## Configuration

### Environment Variables

- `LLM`: The language model provider to use (`OPENAI` or `ANTHROPIC`)
- `OPENAI_MODEL`: The OpenAI model to use (e.g., `gpt-4o`)
- `ANTHROPIC_MODEL`: The Anthropic model to use (e.g., `claude-3-5-sonnet-20241022`)
- `ANTHROPIC_API_KEY`: Your Anthropic API key
- `OPENAI_API_KEY`: Your OpenAI API key
- `MCP_CONFIG_PATH`: Path to the MCP configuration file (optional, defaults to `./mcp_config.json`)

### MCP Server Configuration

The `mcp_config.json` file defines the MCP servers to connect to. Each server entry includes:

- `command`: The command to run the server
- `args`: Arguments to pass to the command
- `env`: Environment variables for the server (optional)

## Cross-Platform Compatibility

The client automatically handles platform-specific differences:

- On Windows, `npx` commands are adjusted to use `npx.cmd`
- Python commands are adjusted based on the platform (`python` on Windows, `python3` on Unix-like systems)
- Environment variables are properly passed to child processes

## License

MIT
