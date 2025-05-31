import { OpenAI } from "openai";
import { StateGraph, interrupt } from "@langchain/langgraph";
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

// State schema with memory
const stateSchema = {
  messages: {
    value: (prev, newMsgs) => [...prev, ...newMsgs],
    default: () => [],
  },
  result: {
    value: null,
  },
  // Add memory context
  context: {
    value: (prev, newContext) => ({ ...prev, ...newContext }),
    default: () => ({}),
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

// Tool implementations with human-in-the-loop for cancellation
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
    async (params, state) => {
      // Get current scheduled interviews
      const scheduledInterviews = mockDB.interviews.filter(
        (i) => i.status === "scheduled"
      );

      // Handle confirmation response
      if (state?.context?.awaitingConfirmation) {
        const lastUserMessage =
          state.messages
            ?.filter((msg) => msg.role === "user")
            .pop()
            ?.content?.toLowerCase()
            ?.trim() || "";

        if (lastUserMessage === "yes") {
          // Actually remove the interview from mockDB
          const interviewId = state.context.pendingCancellation?.id;
          if (!interviewId) {
            return {
              result: "Error: No interview specified for cancellation",
              context: {
                awaitingConfirmation: false,
                pendingCancellation: null,
              },
            };
          }

          mockDB.interviews = mockDB.interviews.filter(
            (interview) => interview.id !== interviewId
          );

          return {
            result: `Successfully cancelled your interview with ${state.context.pendingCancellation.company}.`,
            context: {
              awaitingConfirmation: false,
              pendingCancellation: null,
            },
          };
        } else if (lastUserMessage === "no") {
          return {
            result: "Cancellation aborted. The interview remains scheduled.",
            context: {
              awaitingConfirmation: false,
              pendingCancellation: null,
            },
          };
        } else {
          return {
            result:
              "Please respond with either 'yes' or 'no' to confirm cancellation:",
            context: state.context,
          };
        }
      }

      // Find the interview to cancel
      const interviewToCancel = params.company
        ? scheduledInterviews.find((i) =>
            i.company
              .toLowerCase()
              .includes(params.company?.toLowerCase() || "")
          )
        : scheduledInterviews.find((i) => i.id === params.interview_id);

      if (!interviewToCancel) {
        const interviewsList = scheduledInterviews
          .map((i) => `- ${i.company} (${i.date}) [ID: ${i.id}]`)
          .join("\n");
        return {
          result: interviewsList
            ? `No matching interview found. Your scheduled interviews:\n${interviewsList}`
            : "You have no upcoming interviews to cancel.",
        };
      }

      return {
        result: `Please confirm cancellation of your ${interviewToCancel.company} interview on ${interviewToCancel.date} by responding "yes".`,
        context: {
          pendingCancellation: interviewToCancel,
          awaitingConfirmation: true,
        },
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

// Create workflow with memory support
const workflow = new StateGraph({ channels: stateSchema });

// Modified generate_response node to include context
workflow.addNode(
  "generate_response",
  traceable(
    async (state) => {
      // Include context in the messages
      const messagesWithContext = [
        {
          role: "system",
          content: `You are a helpful internship assistant. Help users with scheduling, canceling, and checking upcoming interviews, as well as internship requirements. Be concise and helpful.
          
          Current context:
          ${JSON.stringify(state.context, null, 2)}`,
        },
        ...state.messages,
      ];

      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: messagesWithContext,
        tools,
        tool_choice: "auto",
      });

      const responseMessage = response.choices[0].message;

      return {
        messages: [responseMessage],
        result: responseMessage,
        // Preserve existing context
        context: state.context,
      };
    },
    { name: "generate_response_llm", run_type: "llm" }
  )
);

// Modified execute_tools node to handle human approval
workflow.addNode(
  "execute_tools",
  traceable(
    async (state) => {
      const lastMessage = state.messages[state.messages.length - 1];
      const toolCalls = lastMessage.tool_calls || [];
      const toolOutputs = [];
      let updatedContext = { ...state.context };

      // Check if we're processing a human response to cancellation confirmation
      if (state.context?.pendingCancellation) {
        const userMessages = state.messages?.filter(
          (msg) => msg.role === "user"
        );
        const lastUserMessage = userMessages[userMessages.length - 1];

        if (lastUserMessage) {
          const userResponse = lastUserMessage.content.toLowerCase().trim();

          // Find the original tool call that requested confirmation
          const originalToolCall = state.messages
            .slice()
            .reverse()
            .find(
              (msg) =>
                msg.tool_calls?.[0]?.function?.name === "cancel_interview"
            );

          if (userResponse === "yes") {
            updatedContext.cancellationApproved = true;
            const cancellationResult =
              await toolImplementations.cancel_interview(
                {
                  company: state.context.pendingCancellation.company,
                  interview_id: state.context.pendingCancellation.id,
                },
                { context: updatedContext }
              );

            toolOutputs.push({
              tool_call_id:
                originalToolCall?.tool_calls?.[0]?.id || "cancel_" + Date.now(),
              role: "tool",
              name: "cancel_interview",
              content: JSON.stringify(cancellationResult.result),
            });

            updatedContext.pendingCancellation = undefined;
            return {
              messages: toolOutputs,
              context: updatedContext,
            };
          } else if (userResponse === "no") {
            toolOutputs.push({
              tool_call_id:
                originalToolCall?.tool_calls?.[0]?.id || "cancel_" + Date.now(),
              role: "tool",
              name: "cancel_interview",
              content: JSON.stringify(
                "Cancellation aborted as per user request."
              ),
            });

            updatedContext.pendingCancellation = undefined;
            return {
              messages: toolOutputs,
              context: updatedContext,
            };
          }
        }
      }

      // Normal tool execution
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const toolParams = JSON.parse(toolCall.function.arguments);

        if (toolImplementations[toolName]) {
          const output = await toolImplementations[toolName](toolParams, {
            context: updatedContext,
          });
          toolOutputs.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: toolName,
            content: JSON.stringify(output.result),
          });

          // Update context based on tool usage
          if (output.context) {
            updatedContext = { ...updatedContext, ...output.context };
          }

          if (toolName === "schedule_interview") {
            updatedContext.lastScheduled = {
              company: toolParams.company,
              date: toolParams.date,
              time: toolParams.time,
              position: toolParams.position,
            };
          }
        }
      }

      return {
        messages: toolOutputs,
        context: updatedContext,
      };
    },
    { name: "execute_tools_node", run_type: "tool" }
  )
);

// Set entry point and edges
workflow.setEntryPoint("generate_response");
workflow.addConditionalEdges(
  "generate_response",
  (state) => (state.result?.tool_calls ? "execute_tools" : "__end__"),
  {
    execute_tools: "execute_tools",
    __end__: "__end__",
  }
);
workflow.addEdge("execute_tools", "generate_response");

// Compile the workflow
const app = await workflow.compile();

// Enhanced CLI Interface with conversation history
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('🤖 Internship Assistant: Type "exit" to quit\n');

const chat = traceable(
  async () => {
    // Initialize conversation history and context
    let conversationHistory = [];
    let globalContext = {};

    while (true) {
      const query = await rl.question("You: ");
      if (query.toLowerCase() === "exit") break;

      try {
        // Build messages including history
        const messages = [
          {
            role: "system",
            content:
              "You are a helpful internship assistant. Help users with scheduling, canceling, and checking upcoming interviews, as well as internship requirements. Be concise and helpful.",
          },
          ...conversationHistory,
          {
            role: "user",
            content: query,
          },
        ];

        // Initialize state with history and context
        const initialState = {
          messages,
          result: null,
          context: globalContext,
        };

        // Run the workflow
        const result = await app.invoke(initialState);

        // Get the final response
        const finalResponse =
          result.messages
            ?.filter((msg) => msg.role === "assistant" && !msg.tool_calls)
            .pop()?.content || "I couldn't process that request.";

        console.log(`🤖: ${finalResponse}`);

        // Update conversation history and context
        conversationHistory = [
          ...conversationHistory,
          { role: "user", content: query },
          { role: "assistant", content: finalResponse },
        ];

        // Limit history to prevent excessive memory usage
        if (conversationHistory.length > 10) {
          conversationHistory = conversationHistory.slice(-10);
        }

        // Update global context
        globalContext = result.context || {};
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
