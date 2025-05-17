import { OpenAI } from "openai";
import { StateGraph } from "@langchain/langgraph";
import readline from "readline/promises";
import process from "process";
import { traceable } from "langsmith/traceable";
import dotenv from "dotenv";

dotenv.config();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

// Define tools for the agent
const tools = [
  {
    type: "function",
    function: {
      name: "schedule_interview",
      description: "Schedule a new interview",
      parameters: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "The company name for the interview",
          },
          date: {
            type: "string",
            description: "The date of the interview in YYYY-MM-DD format",
          },
          time: {
            type: "string",
            description: "The time of the interview in HH:MM AM/PM format",
          },
          position: {
            type: "string",
            description: "The position being interviewed for",
          },
        },
        required: ["company", "date", "time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_interview",
      description: "Cancel an existing interview",
      parameters: {
        type: "object",
        properties: {
          interview_id: {
            type: "string",
            description: "The ID of the interview to cancel",
          },
        },
        required: ["interview_id"],
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

// Tool implementations
const toolImplementations = {
  schedule_interview: traceable(
    async (params) => {
      const newInterview = {
        id: `int_${Math.random().toString(36).slice(2, 8)}`,
        company: params.company,
        date: params.date,
        time: params.time,
        position: params.position || "Software Engineer Intern",
        status: "scheduled",
      };

      mockDB.interviews.push(newInterview);

      return {
        result: `Successfully scheduled interview with ${params.company} on ${
          params.date
        } at ${params.time} for ${
          params.position || "Software Engineer Intern"
        }`,
      };
    },
    { name: "schedule_interview", run_type: "tool" }
  ),

  cancel_interview: traceable(
    async (params) => {
      const interview = mockDB.interviews.find(
        (i) => i.id === params.interview_id
      );
      if (interview) {
        mockDB.interviews = mockDB.interviews.filter(
          (i) => i.id !== params.interview_id
        );
        return {
          result: `Cancelled interview with ${interview.company} scheduled for ${interview.date}`,
        };
      }
      return {
        result: "No interview found with that ID",
      };
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

// Create workflow
const workflow = new StateGraph({ channels: stateSchema });

// Add nodes with proper state handling
workflow.addNode("generate_response", async (state) => {
  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: state.messages,
    tools,
    tool_choice: "auto",
  });

  const responseMessage = response.choices[0].message;

  return {
    messages: [responseMessage], // Return new messages to be merged
    result: responseMessage,
  };
});

workflow.addNode("execute_tools", async (state) => {
  const lastMessage = state.messages[state.messages.length - 1];

  const toolCalls = lastMessage.tool_calls || [];
  const toolOutputs = [];

  for (const toolCall of toolCalls) {
    const toolName = toolCall.function.name;
    const toolParams = JSON.parse(toolCall.function.arguments);

    if (toolImplementations[toolName]) {
      const output = await toolImplementations[toolName](toolParams);
      toolOutputs.push({
        tool_call_id: toolCall.id,
        role: "tool",
        name: toolName,
        content: JSON.stringify(output.result),
      });
    }
  }

  return {
    messages: toolOutputs, // Return tool outputs to be merged
  };
});

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
workflow.addEdge("execute_tools", "generate_response");

// Compile the workflow
const app = await workflow.compile();

// CLI Interface with proper error handling
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('🤖 Internship Assistant: Type "exit" to quit\n');

const chat = traceable(
  async () => {
    while (true) {
      const query = await rl.question("You: ");
      if (query.toLowerCase() === "exit") break;

      try {
        // Initialize conversation with proper state structure
        const initialState = {
          messages: [
            {
              role: "system",
              content:
                "You are a helpful internship assistant. Help users with scheduling, canceling, and checking upcoming interviews, as well as internship requirements. Be concise and helpful.",
            },
            {
              role: "user",
              content: query,
            },
          ],
          result: null,
        };

        // Run the workflow
        const result = await app.invoke(initialState);

        // Get the final response
        const finalResponse =
          result.messages
            .filter((msg) => msg.role === "assistant" && !msg.tool_calls)
            .pop()?.content || "I couldn't process that request.";

        console.log(`🤖: ${finalResponse}`);
      } catch (error) {
        console.error("Error:", error.message);
        console.log("🤖: Sorry, I encountered an error");
      }
    }
    rl.close();
  },
  { name: "chat_session", run_type: "chain" }
);

// Start the chat
chat().catch(console.error);
