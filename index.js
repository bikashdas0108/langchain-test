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

  /**
   * Makes a JSON-RPC request to the MCP server
   * @param {string} method - The method name to call
   * @param {Object} params - Parameters to send with the request
   * @returns {Promise<any>} The result from the server
   */
  async makeRequest(method, params = {}) {
    // Prepare the JSON-RPC request payload
    const requestBody = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: method,
      params: params,
    };

    // Set up HTTP headers
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    // Include session ID in headers if available
    if (this.sessionId) {
      headers[SESSION_ID_HEADER_NAME] = this.sessionId;
    }

    try {
      // Log request details for debugging
      this.logRequestDetails(method, headers, requestBody);

      // Make the HTTP request
      const response = await fetch(this.serverUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(requestBody),
      });

      // Log response details
      this.logResponseDetails(response);

      // Check for HTTP errors
      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Response error body:", errorText);
        throw new Error(
          `HTTP error! status: ${response.status}, body: ${errorText}`
        );
      }

      // Handle session management
      this.handleSessionFromResponse(response);

      // Get response text
      const responseText = await response.text();
      console.log("📄 Raw response:", responseText);

      // Parse and return the response
      return this.parseResponse(responseText);
    } catch (error) {
      console.error("❌ MCP request failed:", error);
      throw error;
    }
  }

  /**
   * Logs request details for debugging
   */
  logRequestDetails(method, headers, requestBody) {
    console.log("🌐 Making request to:", this.serverUrl);
    console.log("📝 Request method:", method);
    console.log("📋 Request headers:", headers);
    console.log("📄 Request body:", JSON.stringify(requestBody, null, 2));
  }

  /**
   * Logs response details for debugging
   */
  logResponseDetails(response) {
    console.log("📨 Response status:", response.status);
    console.log(
      "📨 Response headers:",
      Object.fromEntries(response.headers.entries())
    );
  }

  /**
   * Extracts and stores session ID from response headers
   */
  handleSessionFromResponse(response) {
    const responseSessionId = response.headers.get(SESSION_ID_HEADER_NAME);
    if (responseSessionId && !this.sessionId) {
      this.sessionId = responseSessionId;
      console.log(`📋 Session ID established: ${this.sessionId}`);
    }
  }

  /**
   * Parses the response text based on content type
   * @param {string} responseText - Raw response text
   * @returns {any} Parsed response data
   */
  parseResponse(responseText) {
    console.log("🔍 Parsing response of length:", responseText.length);
    console.log("🔍 Response starts with:", responseText.substring(0, 100));

    // Check if response is Server-Sent Events format
    if (this.isSSEResponse(responseText)) {
      console.log("📡 Detected SSE response, parsing...");
      return this.parseSSEResponse(responseText);
    }

    // Parse as JSON response
    return this.parseJSONResponse(responseText);
  }

  /**
   * Checks if response is in SSE format
   */
  isSSEResponse(responseText) {
    const isSSE =
      responseText.startsWith("event:") ||
      responseText.includes("data:") ||
      responseText.includes("event:");
    console.log("🔍 Is SSE response:", isSSE);
    return isSSE;
  }

  /**
   * Parses Server-Sent Events response
   * @param {string} responseText - Raw SSE response text
   * @returns {any} Parsed result data
   */
  parseSSEResponse(responseText) {
    console.log("📡 Parsing SSE response...");

    const lines = responseText.split("\n");
    let result = null;

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const dataStr = line.substring(6); // Remove 'data: ' prefix
        console.log("📡 Found data line:", dataStr);

        if (dataStr.trim() === "[DONE]") {
          break;
        }

        try {
          const data = JSON.parse(dataStr);
          if (data.result) {
            result = data.result;
          }
        } catch (e) {
          console.warn("⚠️ Failed to parse SSE data line:", dataStr, e);
        }
      }
    }

    return result;
  }

  /**
   * Parses JSON response and handles errors
   * @param {string} responseText - Raw JSON response text
   * @returns {any} Parsed result data
   */
  parseJSONResponse(responseText) {
    console.log("📄 Parsing as JSON response...");

    let responseData;

    try {
      responseData = JSON.parse(responseText);
      console.log("✅ Successfully parsed JSON:", responseData);
    } catch (parseError) {
      console.error("❌ Failed to parse JSON response:", parseError);
      console.error("❌ Raw response was:", responseText);
      throw new Error(
        `Invalid JSON response: ${responseText.substring(0, 200)}...`
      );
    }

    // Check for JSON-RPC errors
    if (responseData.error) {
      console.error("❌ JSON-RPC error:", responseData.error);
      throw new Error(`MCP Error: ${JSON.stringify(responseData.error)}`);
    }

    console.log("✅ Returning result:", responseData.result);
    return responseData.result;
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
        const result = await mcpClient.callTool(
          "get_internship_opportunity_list",
          params
        );
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

  get_company_project_list: traceable(
    async (params) => {
      try {
        const result = await mcpClient.callTool(
          "get_company_project_list",
          params
        );
        return (
          result.content[0]?.text ||
          "Company project list retrieved successfully"
        );
      } catch (error) {
        return `Error retrieving Company project list: ${error.message}`;
      }
    },
    { name: "get_company_project_list", run_type: "tool" }
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
- get_company_project_list: Get available company projects
- shortlist_intern: Shortlist candidates for future reference and consideration

CORE PRINCIPLES:
- Be precise and efficient in tool usage
- Always match user intent accurately
- Handle multiple criteria combinations gracefully
- Provide clear feedback on search results
- Use minimum necessary tool calls

TOOL USAGE DECISION TREE:

1. SHORTLISTING OPERATIONS (Direct Action):
   Keywords: "shortlist", "add to shortlist", "shortlist intern", "save candidate"
   Action: Call shortlist_intern ONLY with provided intern ID
   Examples:
   - "Shortlist intern with ID 1398" → shortlist_intern(internId: "1398")
   - "Add candidate 2045 to shortlist" → shortlist_intern(internId: "2045")
   - "Save intern 3399" → shortlist_intern(internId: "3399")

2. CAREER FIELD-BASED SEARCHES (Two-Step Process):
   Keywords: "career field", "field", "domain", "area", field names like "Business", "Engineering", "Marketing", "Data Science", "Finance"
   Process: get_career_field_list → find matching ID → get_candidate_list
   Examples:
   - "Show candidates in Engineering field" → Get career fields → Find Engineering ID → Get candidates
   - "Find Business domain candidates" → Get career fields → Find Business ID → Get candidates
   - "Candidates interested in Data Science field" → Get career fields → Find Data Science ID → Get candidates

3. PROJECT-BASED SEARCHES (Two-Step Process):
   Keywords: "project", "work on", "working in", project names like "App development", "Web development", "Backend", "Frontend"
   Process: get_company_project_list → find matching ID → get_candidate_list
   Examples:
   - "Candidates for app development project" → Get projects → Find app development ID → Get candidates
   - "Who wants to work on backend project" → Get projects → Find backend ID → Get candidates
   - "Show me candidates for web development" → Get projects → Find web development ID → Get candidates

4. INTERNSHIP OPPORTUNITY-BASED SEARCHES (Two-Step Process):
   Keywords: "internship opportunity", "internship role", "intern position", role names like "Software Engineer Intern", "Marketing Intern"
   Process: get_internship_opportunity_list → find matching ID → get_candidate_list
   Examples:
   - "Candidates for software engineering internship" → Get opportunities → Find software engineering ID → Get candidates
   - "Marketing intern candidates" → Get opportunities → Find marketing intern ID → Get candidates
   - "Data science internship applicants" → Get opportunities → Find data science internship ID → Get candidates

5. DIRECT CANDIDATE SEARCHES (Single-Step Process):
   Keywords: Skills, technologies, dates, locations, universities, experience, duration
   Action: Call get_candidate_list directly with appropriate parameters
   Examples:
   - "JavaScript developers" → get_candidate_list(skillIds: [JavaScript_ID])
   - "Candidates available in January 2024" → get_candidate_list(preferredStartMonths: ["01/2024"])
   - "3-month internship candidates" → get_candidate_list(durations: ["3 months"])
   - "Candidates from MIT" → get_candidate_list(universityName: "MIT")

6. INFORMATION-ONLY REQUESTS (Single-Step Process):
   - "What career fields are available?" → get_career_field_list()
   - "Show all internship opportunities" → get_internship_opportunity_list()
   - "List company projects" → get_company_project_list()

COMPLEX SEARCH COMBINATIONS:
Handle multiple criteria by combining parameters in single get_candidate_list call:

Examples:
- "JavaScript candidates in Engineering field available in January"
  → Get career fields → Find Engineering ID → get_candidate_list(careerFieldIds: [Engineering_ID], skillIds: [JavaScript_ID], preferredStartMonths: ["01/2024"])

- "Business field candidates for app development project with 6-month duration"
  → Get career fields → Get projects → get_candidate_list(careerFieldIds: [Business_ID], projectIds: [App_Dev_ID], durations: ["6 months"])

FUZZY MATCHING STRATEGY:
When searching for IDs by name:
- Use case-insensitive partial matching
- Try variations (e.g., "Software Engineering" matches "Software Engineer", "Engineering - Software")
- If exact match not found, suggest closest matches
- Handle common abbreviations (e.g., "JS" for "JavaScript", "ML" for "Machine Learning")

ERROR HANDLING:
- If no matching career field/project/opportunity found, list available options
- If search returns no candidates, suggest broader criteria
- If user provides invalid intern ID for shortlisting, inform them clearly

RESPONSE FORMATTING:
- Always summarize what search was performed
- Show relevant statistics (total found, filters applied)
- Present results in clear, scannable format
- Include next steps or suggestions when appropriate

PAGINATION HANDLING:
- Use pageNumber and perPage parameters when dealing with large result sets
- Inform users about pagination options
- Default to reasonable page sizes (10-20 results)

REMEMBER: The goal is to help users find the right candidates efficiently. Be proactive in suggesting refinements if searches are too broad or too narrow.`;

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
