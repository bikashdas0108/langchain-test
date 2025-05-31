import { OpenAI } from "openai";
import { StateGraph } from "@langchain/langgraph";
import readline from "readline/promises";
import process from "process";
import { traceable } from "langsmith/traceable";
import dotenv from "dotenv";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

dotenv.config();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// MCP client setup
let mcpClient;
let mcpTransport;

// Initialize MCP connection
async function initializeMCP() {
  try {
    mcpTransport = new StdioClientTransport({
      command: "node",
      args: ["server.js"],
    });

    mcpClient = new Client(
      {
        name: "langraph-mcp-client",
        version: "0.1.0",
      },
      {
        capabilities: {},
      }
    );

    await mcpClient.connect(mcpTransport);
    console.log("✅ Connected to MCP server");

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

// Enhanced mock database
const mockDB = {
  interviews: [
    {
      id: "int_1",
      company: "TechCorp",
      date: "2023-12-15",
      time: "10:00 AM",
      position: "Software Developer",
      status: "scheduled",
    },
    {
      id: "int_2",
      company: "DataSystems",
      date: "2023-12-18",
      time: "2:30 PM",
      position: "Data Analyst",
      status: "scheduled",
    },
  ],
};

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
        const result = await mcpClient.callTool({
          name: "recommend_candidate",
          arguments: params,
        });
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

  schedule_interview: traceable(
    async (params) => {
      try {
        const result = await mcpClient.callTool({
          name: "schedule_interview",
          arguments: params,
        });
        return {
          result: result.content[0]?.text || "Interview scheduled successfully",
        };
      } catch (error) {
        return {
          result: `Error scheduling interview: ${error.message}`,
        };
      }
    },
    { name: "schedule_interview", run_type: "tool" }
  ),
};

// Keep existing local tool implementations
const localToolImplementations = {
  // schedule_interview_local: traceable(
  //   async (params) => {
  //     const newInterview = {
  //       id: `int_${Math.random().toString(36).slice(2, 8)}`,
  //       company: params.company,
  //       date: params.date,
  //       time: params.time,
  //       position: params.position || "Software Engineer Intern",
  //       status: "scheduled",
  //     };

  //     mockDB.interviews.push(newInterview);

  //     return {
  //       result: `Successfully scheduled interview with ${params.company} on ${
  //         params.date
  //       } at ${params.time} for ${
  //         params.position || "Software Engineer Intern"
  //       }`,
  //     };
  //   },
  //   { name: "schedule_interview_local", run_type: "tool" }
  // ),

  cancel_interview: traceable(
    async (params) => {
      const scheduledInterviews = mockDB.interviews.filter(
        (i) => i.status === "scheduled"
      );

      if (scheduledInterviews.length === 0) {
        return {
          result: "You currently have no scheduled interviews to cancel.",
        };
      }

      if (!params.company && !params.interview_id) {
        const companiesList = scheduledInterviews
          .map((i) => `- ${i.company} (ID: ${i.id})`)
          .join("\n");
        return {
          result: `Please specify either:\n1. The exact company name\n2. Or the interview ID\n\nYour scheduled interviews are:\n${companiesList}`,
        };
      }

      if (params.company) {
        const companyName = params.company.trim().toLowerCase();
        const matchingInterview = scheduledInterviews.find(
          (i) => i.company.toLowerCase() === companyName
        );

        if (!matchingInterview) {
          const companiesList = scheduledInterviews
            .map((i) => `- ${i.company} (ID: ${i.id})`)
            .join("\n");
          return {
            result: `No interview found with company "${params.company}".\n\nYour scheduled interviews are:\n${companiesList}`,
          };
        }

        mockDB.interviews = mockDB.interviews.filter(
          (i) => i.id !== matchingInterview.id
        );
        return {
          result: `Successfully cancelled your interview with ${matchingInterview.company} scheduled for ${matchingInterview.date}.`,
        };
      }

      if (params.interview_id) {
        const interview = scheduledInterviews.find(
          (i) => i.id === params.interview_id
        );
        if (!interview) {
          return {
            result: `No scheduled interview found with ID "${params.interview_id}".`,
          };
        }

        mockDB.interviews = mockDB.interviews.filter(
          (i) => i.id !== params.interview_id
        );
        return {
          result: `Successfully cancelled your interview with ${interview.company} (ID: ${interview.id}) scheduled for ${interview.date}.`,
        };
      }
    },
    { name: "cancel_interview", run_type: "tool" }
  ),

  get_upcoming_interviews: traceable(
    async () => {
      const upcoming = mockDB.interviews
        .filter((i) => i.status === "scheduled")
        .map(
          (i) =>
            `${i.company} - ${i.date} at ${i.time} (${i.position}) [ID: ${i.id}]`
        )
        .join("\n");

      return {
        result: upcoming || "No upcoming interviews",
      };
    },
    { name: "get_upcoming_interviews", run_type: "tool" }
  ),

  get_requirements: traceable(
    async (params) => {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `Provide concise internship requirements for ${
              params.position || "a software engineering internship"
            } (3-5 bullet points)`,
          },
        ],
        temperature: 0.3,
      });

      return {
        result: response.choices[0].message.content,
      };
    },
    { name: "get_requirements", run_type: "tool" }
  ),
};

// Define local tools (keeping existing)
const localTools = [
  // {
  //   type: "function",
  //   function: {
  //     name: "schedule_interview_local",
  //     description: "Schedule a new local interview",
  //     parameters: {
  //       type: "object",
  //       properties: {
  //         company: {
  //           type: "string",
  //           description: "The company name for the interview",
  //         },
  //         date: {
  //           type: "string",
  //           description: "The date of the interview in YYYY-MM-DD format",
  //         },
  //         time: {
  //           type: "string",
  //           description: "The time of the interview in HH:MM AM/PM format",
  //         },
  //         position: {
  //           type: "string",
  //           description: "The position being interviewed for",
  //         },
  //       },
  //       required: ["company", "date", "time"],
  //     },
  //   },
  // },
  {
    type: "function",
    function: {
      name: "cancel_interview",
      description:
        "Cancel an existing interview by company name or interview ID",
      parameters: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "The exact company name for the interview to cancel",
          },
          interview_id: {
            type: "string",
            description: "The ID of the interview to cancel",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_upcoming_interviews",
      description: "Get a list of all upcoming interviews",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_requirements",
      description: "Get requirements for internships",
      parameters: {
        type: "object",
        properties: {
          position: {
            type: "string",
            description: "The position to get requirements for",
          },
        },
      },
    },
  },
];

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
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: state.messages,
        // Important: NO tools parameter here to prevent further tool calls
      });

      const responseMessage = response.choices[0].message;

      return {
        messages: [responseMessage],
        result: responseMessage,
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
  if (mcpTransport) {
    await mcpTransport.close();
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

  // Initialize MCP connection and get tools
  const mcpTools = await initializeMCP();
  const mcpToolsForOpenAI = convertMCPToolsToOpenAI(mcpTools);

  // Combine all tools
  allTools = [...localTools, ...mcpToolsForOpenAI];
  allToolImplementations = {
    ...localToolImplementations,
    ...mcpToolImplementations,
  };

  // Compile the workflow
  const app = await workflow.compile();

  // CLI Interface with proper error handling
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('🤖 Internship Assistant with MCP: Type "exit" to quit\n');

  const chat = traceable(
    async () => {
      while (true) {
        const query = await rl.question("You: ");
        if (query.toLowerCase() === "exit") break;

        try {
          console.log("🔍 Processing query:", query);

          // Initialize conversation with proper state structure
          const initialState = {
            messages: [
              {
                role: "system",
                content:
                  "You are a helpful internship assistant. Help users with scheduling, canceling, and checking upcoming interviews, as well as internship requirements. You also have access to MCP tools for recommending candidates and scheduling interviews with external systems. Be concise and helpful. When scheduling interviews, use the schedule_interview_local tool for local storage.",
              },
              {
                role: "user",
                content: query,
              },
            ],
            result: null,
          };

          console.log("🚀 Invoking workflow...");
          // Run the workflow
          const result = await app.invoke(initialState);
          console.log("✅ Workflow completed");

          // Get the final response
          const assistantMessages = result.messages.filter(
            (msg) => msg.role === "assistant" && !msg.tool_calls
          );
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
      rl.close();
    },
    { name: "chat_session", run_type: "chain" }
  );

  // Handle cleanup on exit
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  // Start the chat
  await chat().catch(console.error);
}

// Start the application
main().catch(async (error) => {
  console.error("❌ Application failed to start:", error);
  await cleanup();
  process.exit(1);
});
