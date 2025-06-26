import { OpenAI } from "openai";
import { StateGraph } from "@langchain/langgraph";
import readline from "readline/promises";
import process from "process";
import { traceable } from "langsmith/traceable";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { randomUUID } from "crypto";

dotenv.config();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// MCP HTTP client setup
const MCP_SERVER_URL =
  process.env.MCP_SERVER_URL || "http://localhost:3001/mcp";
const SESSION_ID_HEADER_NAME = "mcp-session-id";
let sessionId = null;

// HTTP-based MCP client
class MCPHTTPClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.sessionId = null;
  }

async makeRequest(method, params = {}) {
  const requestBody = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: method,
    params: params,
  };

  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };

  // Add session ID header if we have one
  if (this.sessionId) {
    headers[SESSION_ID_HEADER_NAME] = this.sessionId;
  }

  try {
    console.log('🌐 Making request to:', this.serverUrl);
    console.log('📝 Request method:', method);
    console.log('📋 Request headers:', headers);
    console.log('📄 Request body:', JSON.stringify(requestBody, null, 2));

    const response = await fetch(this.serverUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(requestBody),
    });

    console.log('📨 Response status:', response.status);
    console.log('📨 Response headers:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Response error body:', errorText);
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
    }

    // Extract session ID from response headers if available
    const responseSessionId = response.headers.get(SESSION_ID_HEADER_NAME);
    if (responseSessionId && !this.sessionId) {
      this.sessionId = responseSessionId;
      console.log(`📋 Session ID established: ${this.sessionId}`);
    }

    const responseText = await response.text();
    console.log('📄 Raw response:', responseText);

    // Check if response is SSE format
    if (responseText.startsWith('event:') || responseText.includes('data:')) {
      console.log('📡 Detected SSE response, parsing...');
      return this.parseSSEResponse(responseText);
    }

    // Try to parse as JSON
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ Failed to parse JSON response:', parseError);
      throw new Error(`Invalid JSON response: ${responseText}`);
    }

    if (responseData.error) {
      throw new Error(`MCP Error: ${JSON.stringify(responseData.error)}`);
    }

    return responseData.result;
  } catch (error) {
    console.error("❌ MCP request failed:", error);
    throw error;
  }
}

parseSSEResponse(sseText) {
  const lines = sseText.split('\n');
  let data = '';
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      data += line.substring(6);
    }
  }
  
  if (data) {
    try {
      return JSON.parse(data);
    } catch (error) {
      console.error('❌ Failed to parse SSE data as JSON:', error);
      return { raw: data };
    }
  }
  
  return { raw: sseText };
}

  async initialize() {
    try {
      const result = await this.makeRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {
          roots: {
            listChanged: false,
          },
          sampling: {},
          tools: {},
        },
        clientInfo: {
          name: "langraph-mcp-http-client",
          version: "0.1.0",
        },
      });

      console.log("✅ Connected to MCP server via HTTP");
      console.log("📋 Server capabilities:", JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      console.error("❌ Failed to initialize MCP connection:", error);
      throw error;
    }
  }

  async listTools() {
    try {
      const result = await this.makeRequest("tools/list");
      return result;
    } catch (error) {
      console.error("❌ Failed to list tools:", error);
      throw error;
    }
  }

  async callTool(name, arguments_) {
    try {
      const result = await this.makeRequest("tools/call", {
        name: name,
        arguments: arguments_,
      });
      return result;
    } catch (error) {
      console.error(`❌ Failed to call tool ${name}:`, error);
      throw error;
    }
  }
}

// MCP client instance
let mcpClient;

// Initialize MCP connection
async function initializeMCP() {
  try {
    console.log("🔗 Attempting to connect to MCP server at:", MCP_SERVER_URL);

    mcpClient = new MCPHTTPClient(MCP_SERVER_URL);
    console.log("🚀 ~ initializeMCP ~ mcpClient:", mcpClient.initialize);

    // Test server connectivity first
    try {
      const healthCheck = await fetch(
        MCP_SERVER_URL.replace("/mcp", "/health")
      );
      if (!healthCheck.ok) {
        throw new Error(`Health check failed: ${healthCheck.status}`);
      }
      console.log("✅ MCP server health check passed");
    } catch (healthError) {
      console.error("❌ MCP server health check failed:", healthError.message);
      console.error(
        "💡 Make sure your MCP server is running on the correct port"
      );
      return [];
    }

    // Initialize the connection
    await mcpClient.initialize();

    // List available tools
    const tools = await mcpClient.listTools();
    console.log("📋 Available MCP tools:");
    tools?.result?.tools.forEach((tool) => {
      console.log(`  - ${tool.name}: ${tool.description}`);
    });

    return tools?.result?.tools || [];
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
  toolCallCount: {
    value: 0, // Track number of tool call rounds
  },
  maxToolCalls: {
    value: 3, // Maximum number of tool call rounds to prevent infinite loops
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
  get_candidate_list: traceable(
    async (params) => {
      try {
        const result = await mcpClient.callTool("get_candidate_list", params);
        return (
          result.content[0]?.text || "Candidate list retrieved successfully"
        );
      } catch (error) {
        return `Error retrieving candidate list: ${error.message}`;
      }
    },
    { name: "get_candidate_list", run_type: "tool" }
  ),

  get_career_field_list: traceable(
    async (params) => {
      try {
        const result = await mcpClient.callTool(
          "get_career_field_list",
          params
        );
        return (
          result.content[0]?.text || "Career field list retrieved successfully"
        );
      } catch (error) {
        return `Error retrieving career field list: ${error.message}`;
      }
    },
    { name: "get_career_field_list", run_type: "tool" }
  ),

  get_internship_opportunity_list: traceable(
    async (params) => {
      try {
        const result = await mcpClient.callTool("get_internship_opportunity_list", params);
        return (
          result.content[0]?.text ||
          "Internship opportunity list retrieved successfully"
        );
      } catch (error) {
        return `Error retrieving Internship opportunity list: ${error.message}`;
      }
    },
    { name: "get_internship_opportunity_list", run_type: "tool" }
  ),

  shortlist_intern: traceable(
    async (params) => {
      try {
        const result = await mcpClient.callTool("shortlist_intern", params);
        return result.content[0]?.text || "Intern shortlisted successfully";
      } catch (error) {
        return `Error shortlisting candidate: ${error.message}`;
      }
    },
    { name: "shortlist_intern", run_type: "tool" }
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
      // Check if we've exceeded maximum tool calls to prevent infinite loops
      if (state.toolCallCount >= state.maxToolCalls) {
        console.log(
          "⚠️ Maximum tool call limit reached, generating final response"
        );
        return {
          messages: [
            {
              role: "assistant",
              content:
                "I've reached the maximum number of tool calls. Let me provide a response based on the information I've gathered so far.",
            },
          ],
          result: {
            role: "assistant",
            content:
              "I've reached the maximum number of tool calls. Let me provide a response based on the information I've gathered so far.",
          },
        };
      }

      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: state.messages,
        tools: allTools,
        tool_choice: "auto",
      });

      const responseMessage = response.choices[0].message;

      if (responseMessage.tool_calls) {
        console.log("🔍 LLM decided to make tool calls:");
        responseMessage.tool_calls.forEach((toolCall, index) => {
          console.log(`  ${index + 1}. ${toolCall.function.name}`);
          console.log(`     Arguments: ${toolCall.function.arguments}`);
        });
      } else {
        console.log("🔍 LLM decided not to make any tool calls");
      }

      return {
        messages: [responseMessage], // Return new messages to be merged
        result: responseMessage,
        toolCallCount: responseMessage.tool_calls
          ? state.toolCallCount + 1
          : state.toolCallCount,
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
            content: `Error parsing arguments: ${parseError.message}`,
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
              content: output, // Direct output, no JSON wrapping
            });
          } catch (toolError) {
            console.error(`❌ Error executing tool ${toolName}:`, toolError);
            toolOutputs.push({
              tool_call_id: toolCall.id,
              role: "tool",
              name: toolName,
              content: `Tool execution error: ${toolError.message}`,
            });
          }
        } else {
          console.error(`❌ Tool not found: ${toolName}`);
          console.log("Available tools:", Object.keys(allToolImplementations));
          toolOutputs.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: toolName,
            content: `Tool ${toolName} not found`,
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
      // Check if we have tool outputs to process
      const toolOutputs = state.messages.filter((msg) => msg.role === "tool");

      if (toolOutputs.length > 0) {
        // Include ALL messages in the conversation, including tool responses
        // This ensures the conversation flow is maintained for OpenAI API
        const response = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: state.messages, // Include all messages including tool responses
          temperature: 0.7,
        });

        return {
          messages: [response.choices[0].message],
          result: response.choices[0].message,
        };
      }

      // If no tool output, generate a response normally
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
  (state) => {
    if (state.result?.tool_calls) {
      return "execute_tools";
    }
    return "__end__";
  },
  {
    execute_tools: "execute_tools",
    __end__: "__end__",
  }
);

// Add conditional edge from tools - can either continue to generate more responses or end
workflow.addConditionalEdges(
  "execute_tools",
  (state) => {
    const hasToolResults = state.messages.some((msg) => msg.role === "tool");
    const reachedMaxCalls = state.toolCallCount >= state.maxToolCalls;

    // Get the last assistant message that had tool calls
    const lastAssistantMessage = state.messages
      .filter((msg) => msg.role === "assistant" && msg.tool_calls)
      .pop();

    // Check if the last tool calls were for "simple" operations that don't need follow-up
    const simpleOperations = ["shortlist_intern"]; // Add other simple operations here
    const hasOnlySimpleOperations = lastAssistantMessage?.tool_calls?.every(
      (toolCall) => simpleOperations.includes(toolCall.function.name)
    );

    // If we have tool results but they're from simple operations, go to final response
    if (hasToolResults && hasOnlySimpleOperations) {
      return "final_response";
    }

    // For complex operations, continue conversation if under max calls
    if (hasToolResults && !reachedMaxCalls) {
      return "continue_conversation";
    }

    return "final_response";
  },
  {
    continue_conversation: "generate_response",
    final_response: "final_response",
  }
);

// Add this new edge to end the workflow
workflow.addEdge("final_response", "__end__");

// Main function
async function main() {
  console.log("🚀 Starting LangGraph with HTTP MCP Integration...");

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

    console.log('🤖 Candidate Recommendation Assistant: Type "exit" to quit\n');
    console.log(
      '💡 Try asking: "Show me candidates in Business field" or "Get candidates in Engineering"\n'
    );

    const chat = traceable(
      async () => {
        while (true) {
          const query = await rl.question("\nYou: ");
          if (query.toLowerCase() === "exit") {
            console.log(
              "\n👋 Goodbye! Thank you for using the Candidate Recommendation Assistant."
            );
            process.exit(0);
          }

          try {
            console.log("🔍 Processing query:", query);

            const systemPrompt = `You are a helpful candidate recommendation assistant. You help users find and browse candidates for internship positions. 

You have access to these tools:
- get_candidate_list: Search and filter candidates by various criteria (skills, start dates, duration, projects, career fields, location, etc.)
- get_career_field_list: Get available career fields in the system
- get_internship_opportunity_list: Get available internship opportunities
- shortlist_intern: Shortlist candidates for future reference and consideration

TOOL USAGE GUIDELINES:

1. FOR SHORTLISTING OPERATIONS:
   - When users ask to "shortlist intern with ID X" or similar direct shortlisting requests
   - ONLY call shortlist_intern with the provided intern ID
   - Do NOT call get_candidate_list or other tools first
   - Example: "Shortlist intern with ID 1398" → Call shortlist_intern with internId: "1398"

2. FOR CAREER FIELD SEARCHES:
   - When users ask for candidates by career field NAME (like "Business", "Engineering", "Marketing")
   - FIRST call get_career_field_list to get all available career fields
   - Find the career field ID that matches the requested field name
   - THEN call get_candidate_list with the correct careerFieldIds parameter
   - Examples:
     * "Show me candidates in Business field" → First get career fields, find Business ID, then get candidates
     * "Find candidates interested in Software Engineering" → First get career fields, find Software Engineering ID, then get candidates
  
3. FOR INTERNSHIP OPPORTUNITIES SEARCHES:
   - When users ask for candidates by internship opportunity (like "Data science", "Engineering intern")
   - FIRST call get_internship_opportunity_list to get all available internship opportunity fields
   - Find the internship opportunity ID that matches the requested field name
   - THEN call get_candidate_list with the correct internshipOpportunityId parameter
   - Examples:
     * "Show me candidates for data science internship opportunity" → First get internship opportunity, find internship opportunity id, then get candidates

4. FOR DIRECT CANDIDATE SEARCHES:
   - When users provide specific criteria (skills, dates, etc.) without career field names
   - Call get_candidate_list directly with the appropriate parameters
   - Examples:
     * "Show me candidates with JavaScript skills" → Call get_candidate_list directly with skillIds
     * "Find candidates available in January 2024" → Call get_candidate_list directly with preferredStartMonths

5. FOR CAREER FIELD INFORMATION:
   - When users ask about available career fields
   - Call get_career_field_list directly

6. FOR INTERNSHIP OPPORTUNITY INFORMATION:
   - When users ask about available INTERNSHIP OPPORTUNITIES
   - Call get_internship_opportunity_list directly   

IMPORTANT: Use the minimum number of tool calls necessary. Don't gather extra information unless specifically requested by the user.`;

            const initialState = {
              messages: [
                {
                  role: "system",
                  content: systemPrompt,
                },
                {
                  role: "user",
                  content: query,
                },
              ],
              result: null,
              toolCallCount: 0,
              maxToolCalls: 3,
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

            console.log(`\n🤖 Assistant: ${finalResponse}`);
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
    process.exit(1);
  }
}

// Start the application
main().catch(async (error) => {
  console.error("❌ Application failed to start:", error);
  process.exit(1);
});
