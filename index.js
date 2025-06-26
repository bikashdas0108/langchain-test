import { OpenAI } from "openai";
import { StateGraph } from "@langchain/langgraph";
import readline from "readline/promises";
import process from "process";
import { traceable } from "langsmith/traceable";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Custom MCP HTTP client
class MCPHTTPClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.sessionId = null;
  }

  async initialize() {
    const response = await fetch(this.serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "langraph-mcp-client",
            version: "0.1.0",
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      this.sessionId = sessionId;
    }

    const data = await response.text();
    const lines = data.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const jsonData = JSON.parse(line.substring(6));
        if (jsonData.result) {
          return jsonData.result;
        }
      }
    }

    throw new Error("Failed to initialize MCP connection");
  }

  async listTools() {
    if (!this.sessionId) {
      throw new Error("Not initialized. Call initialize() first.");
    }

    const response = await fetch(this.serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": this.sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "tools/list",
        params: {},
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.text();
    const lines = data.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const jsonData = JSON.parse(line.substring(6));
        if (jsonData.result) {
          return jsonData.result;
        }
      }
    }

    throw new Error("Failed to list tools");
  }

  async callTool(name, arguments_) {
    if (!this.sessionId) {
      throw new Error("Not initialized. Call initialize() first.");
    }

    const response = await fetch(this.serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": this.sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "3",
        method: "tools/call",
        params: {
          name: name,
          arguments: arguments_,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.text();
    const lines = data.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const jsonData = JSON.parse(line.substring(6));
        if (jsonData.result) {
          return jsonData.result;
        }
        if (jsonData.error) {
          throw new Error(jsonData.error.message);
        }
      }
    }

    throw new Error("Failed to call tool");
  }
}

// MCP client setup
let mcpClient;

// Initialize MCP connection
async function initializeMCP() {
  try {
    mcpClient = new MCPHTTPClient("http://localhost:3000/mcp");

    await mcpClient.initialize();
    console.log("✅ Connected to MCP HTTP server");

    const tools = await mcpClient.listTools();
    console.log("📋 Available MCP tools:");
    tools.tools.forEach((tool) => {
      console.log(`  - ${tool.name}: ${tool.description}`);
    });

    return tools.tools;
  } catch (error) {
    console.error("❌ Failed to initialize MCP connection:", error);
    return [];
  }
}

// Define state structure with proper merge functions
const stateSchema = {
  messages: {
    value: (prev, newMsgs) => [...prev, ...newMsgs], // Proper merge function
    default: () => [], // Default empty array
  },
  result: {
    value: null,
  },
};

// Function to convert MCP tools to OpenAI format
function convertMCPToolsToOpenAI(mcpTools) {
  return mcpTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

// MCP tool implementations
const mcpToolImplementations = {
  recommend_candidate: traceable(
    async (params) => {
      try {
        const result = await mcpClient.callTool("recommend_candidate", params);
        return {
          result:
            result.content[0]?.text || "Recommendation completed successfully",
        };
      } catch (error) {
        return {
          result: `Error recommending candidate: ${error.message}`,
        };
      }
    },
    { name: "recommend_candidate", run_type: "tool" }
  ),
};

// Global variables for tools
let allTools = [];
let allToolImplementations = {};

// Create workflow
const workflow = new StateGraph({ channels: stateSchema });

// Add nodes with tracing
workflow.addNode(
  "generate_response",
  traceable(
    async (state) => {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: state.messages,
        tools: allTools,
        tool_choice: "auto",
      });

      const responseMessage = response.choices[0].message;

      return {
        messages: [responseMessage], // Return new messages to be merged
        result: responseMessage,
      };
    },
    { name: "generate_response_llm", run_type: "llm" }
  )
);

workflow.addNode(
  "execute_tools",
  traceable(
    async (state) => {
      const lastMessage = state.messages[state.messages.length - 1];
      const toolCalls = lastMessage.tool_calls || [];
      const toolOutputs = [];

      console.log("🔧 Tool calls detected:", toolCalls.length);

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        let toolParams;

        try {
          toolParams = JSON.parse(toolCall.function.arguments);
          console.log(`🔧 Executing tool: ${toolName}`);
          console.log(`📝 Parameters:`, toolParams);
        } catch (parseError) {
          console.error("❌ Error parsing tool arguments:", parseError);
          console.error("Raw arguments:", toolCall.function.arguments);
          toolOutputs.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: toolName,
            content: JSON.stringify({
              result: `Error parsing arguments: ${parseError.message}`,
            }),
          });
          continue;
        }

        if (allToolImplementations[toolName]) {
          try {
            const output = await allToolImplementations[toolName](toolParams);
            console.log(`✅ Tool ${toolName} executed successfully`);
            toolOutputs.push({
              tool_call_id: toolCall.id,
              role: "tool",
              name: toolName,
              content: JSON.stringify(output.result),
            });
          } catch (toolError) {
            console.error(`❌ Error executing tool ${toolName}:`, toolError);
            toolOutputs.push({
              tool_call_id: toolCall.id,
              role: "tool",
              name: toolName,
              content: JSON.stringify({
                result: `Tool execution error: ${toolError.message}`,
              }),
            });
          }
        } else {
          console.error(`❌ Tool not found: ${toolName}`);
          console.log("Available tools:", Object.keys(allToolImplementations));
          toolOutputs.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: toolName,
            content: JSON.stringify({ result: `Tool ${toolName} not found` }),
          });
        }
      }

      return {
        messages: toolOutputs,
      };
    },
    { name: "execute_tools_node", run_type: "tool" }
  )
);

workflow.addNode(
  "final_response",
  traceable(
    async (state) => {
      // Get all tool outputs and their corresponding tool calls
      const toolOutputs = state.messages.filter((msg) => msg.role === "tool");
      const toolCalls = state.messages
        .filter((msg) => msg.tool_calls)
        .flatMap((msg) => msg.tool_calls);

      if (toolOutputs.length > 0) {
        try {
          // Create a summary of all operations
          const operations = toolOutputs.map((output, index) => {
            const toolCall = toolCalls[index];
            const toolResult = JSON.parse(output.content);

            return {
              operation: toolCall.function.name,
              params: JSON.parse(toolCall.function.arguments),
              result: toolResult.result,
              success: toolResult.success,
              error: toolResult.error,
              rawError: toolResult.rawError,
            };
          });

          // Create a context message for the AI
          const contextMessage = {
            role: "system",
            content: `You are a helpful assistant summarizing multiple operations. Here are all the operations that were performed:

${operations
  .map(
    (op) => `
Operation: ${op.operation}
Parameters: ${JSON.stringify(op.params)}
Result: ${op.result}
${op.rawError ? `Raw Error: ${op.rawError}` : ""}
`
  )
  .join("\n")}

Please provide a natural, conversational response that:
1. Summarizes all operations performed in sequence
2. For each operation:
   - If successful, confirm what was done and include relevant details
   - If there was an error:
     * Analyze the raw error message to understand what went wrong
     * Explain the error in natural language
     * Suggest what the user can do to resolve the issue
3. Keep the response concise but informative
4. Use natural language to connect the operations (e.g., "First, I... Then, I...")
5. If there are API errors, explain them in terms of what they mean for the user's request`,
          };

          // Generate a natural response using the AI
          const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [contextMessage],
            temperature: 0.7,
          });

          return {
            messages: [response.choices[0].message],
            result: response.choices[0].message,
          };
        } catch (e) {
          console.error("Error parsing tool outputs:", e);
        }
      }

      // If no tool output or parsing failed, generate a response
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: state.messages,
        temperature: 0.7,
      });

      return {
        messages: [response.choices[0].message],
        result: response.choices[0].message,
      };
    },
    { name: "final_response_llm", run_type: "llm" }
  )
);

// Set entry point
workflow.setEntryPoint("generate_response");

// Add conditional edges with proper configuration
workflow.addConditionalEdges(
  "generate_response",
  (state) => (state.result?.tool_calls ? "execute_tools" : "__end__"),
  {
    execute_tools: "execute_tools",
    __end__: "__end__",
  }
);

// Add edge from tools back to generation
workflow.addEdge("execute_tools", "final_response");

// Add this new edge to end the workflow
workflow.addEdge("final_response", "__end__");

// Cleanup function
async function cleanup() {
  console.log("\n🧹 Cleaning up...");
  if (mcpClient) {
    // No need to close the custom client
  }
}

// Main function
async function main() {
  console.log("🚀 Starting LangGraph with MCP Integration...");

  // Check for OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY environment variable is required");
    console.error("💡 Create a .env file with: OPENAI_API_KEY=your-key-here");
    process.exit(1);
  }

  try {
    // Initialize MCP connection and get tools
    const mcpTools = await initializeMCP();
    const mcpToolsForOpenAI = convertMCPToolsToOpenAI(mcpTools);

    // Combine all tools
    allTools = [...mcpToolsForOpenAI];
    allToolImplementations = {
      ...mcpToolImplementations,
    };

    // Compile the workflow
    const app = await workflow.compile();

    // CLI Interface with proper error handling
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(
      '🤖 Internship Assistant with MCP HTTP Server: Type "exit" to quit\n'
    );

    const chat = traceable(
      async () => {
        while (true) {
          const query = await rl.question("\nYou: ");
          if (query.toLowerCase() === "exit") {
            console.log(
              "\n👋 Goodbye! Thank you for using the Internship Assistant."
            );
            await cleanup();
            process.exit(0);
          }

          try {
            console.log("🔍 Processing query:", query);

            const initialState = {
              messages: [
                {
                  role: "system",
                  content:
                    "You are a helpful internship assistant. Help users with recommending candidates for internship positions. You have access to the recommend_candidate MCP tool that can recommend a candidate to a company for an internship position. The tool requires candidateId, companyId, and pocId parameters. Be concise and helpful.",
                },
                {
                  role: "user",
                  content: query,
                },
              ],
              result: null,
            };

            console.log("🚀 Invoking workflow...");
            const result = await app.invoke(initialState);
            console.log("✅ Workflow completed");

            // Get the final response
            const assistantMessages = result.messages.filter(
              (msg) => msg.role === "assistant" && !msg.tool_calls
            );

            // Use the last assistant message as the final response
            const finalResponse =
              assistantMessages.length > 0
                ? assistantMessages[assistantMessages.length - 1].content
                : "I couldn't process that request.";

            console.log(`🤖: ${finalResponse}`);
          } catch (error) {
            console.error("❌ Chat error details:", error);
            console.error("❌ Stack trace:", error.stack);
            console.log("🤖: Sorry, I encountered an error. Please try again.");
          }
        }
      },
      { name: "chat_session", run_type: "chain" }
    );

    // Start the chat
    await chat();
  } catch (error) {
    console.error("❌ Application failed to start:", error);
    await cleanup();
    process.exit(1);
  }
}

// Start the application
main().catch(async (error) => {
  console.error("❌ Application failed to start:", error);
  await cleanup();
  process.exit(1);
});
