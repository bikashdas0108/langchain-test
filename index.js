// index.js
import { OpenAI } from "openai";
import { StateGraph } from "@langchain/langgraph";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// mock database
const mockInterviewsDB = {
  interviews: [
    {
      id: "int_sample1",
      company: "TechCorp",
      date: "2023-12-15",
      time: "10:00 AM",
      position: "Software Developer Intern",
      status: "scheduled",
    },
    {
      id: "int_sample2",
      company: "DataSystems",
      date: "2023-12-18",
      time: "2:30 PM",
      position: "Data Analyst Intern",
      status: "scheduled",
    },
  ],
};

// Helper functions with better error handling
function extractInterviewDetails(query) {
  try {
    const dateMatch = query.match(
      /(\d{1,2}\/\d{1,2}\/\d{4})|(\w+ \d{1,2},? \d{4})/
    );
    const timeMatch = query.match(/(\d{1,2}:\d{2} [AP]M)|(\d{1,2}[AP]M)/);
    const companyMatch =
      query.match(/with ([\w\s]+?)(?: on| at| for|$)/i) ||
      query.match(/at ([\w\s]+?)(?: on| at| for|$)/i) ||
      query.match(/for ([\w\s]+?)(?: on| at| for|$)/i);
    const positionMatch = query.match(/for ([\w\s]+? intern)/i);

    return {
      date: dateMatch?.[0] || "tomorrow",
      time: timeMatch?.[0] || "10:00 AM",
      company: companyMatch?.[1]?.trim() || "a company",
      position: positionMatch?.[1] || "intern position",
    };
  } catch (error) {
    console.error("Error extracting details:", error);
    return {
      date: "tomorrow",
      time: "10:00 AM",
      company: "a company",
      position: "intern position",
    };
  }
}

function extractInterviewId(query) {
  try {
    const idMatch =
      query.match(/int_[a-z0-9]+/i) ||
      query.match(/(?:interview|meeting) (?:ID|id) (\w+)/i);
    return idMatch?.[0];
  } catch (error) {
    console.error("Error extracting ID:", error);
    return null;
  }
}

async function classifyQuery(query) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: `Classify this internship query into exactly one of:
        - schedule_interview
        - cancel_interview  
        - upcoming_interviews
        - requirements
        - general_question
        
        Query: "${query}"
        
        Respond ONLY with the exact category name.`,
        },
      ],
      temperature: 0,
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error("Classification error:", error);
    return "general_question";
  }
}

// Define nodes
async function routeQuery({ userQuery }) {
  const category = await classifyQuery(userQuery);
  return { category };
}

async function scheduleInterview({ userQuery }) {
  const details = extractInterviewDetails(userQuery);
  const newInterview = {
    id: `int_${Math.random().toString(36).slice(2, 9)}`,
    ...details,
    status: "scheduled",
    createdAt: new Date().toISOString(),
  };
  mockInterviewsDB.interviews.push(newInterview);
  return {
    response: `✅ Scheduled your ${details.position} interview with ${details.company} on ${details.date} at ${details.time}.\nInterview ID: ${newInterview.id}`,
  };
}

async function cancelInterview({ userQuery }) {
  const interviewId =
    extractInterviewId(userQuery) ||
    mockInterviewsDB.interviews.find((i) =>
      i.company.toLowerCase().includes(userQuery.toLowerCase())
    )?.id;

  if (!interviewId) {
    const upcoming = mockInterviewsDB.interviews
      .filter((i) => i.status === "scheduled")
      .map((i) => `- ${i.company} (ID: ${i.id})`)
      .join("\n");
    return {
      response: `Please specify which interview to cancel. Your scheduled interviews:\n${
        upcoming || "No upcoming interviews found."
      }`,
    };
  }

  const interview = mockInterviewsDB.interviews.find(
    (i) => i.id === interviewId
  );
  if (interview) {
    interview.status = "cancelled";
    return {
      response: `❌ Cancelled your ${interview.position} interview with ${interview.company} scheduled for ${interview.date}.`,
    };
  }
  return {
    response: "Interview not found. Please check the ID and try again.",
  };
}

async function showInterviews() {
  const upcoming = mockInterviewsDB.interviews
    .filter((i) => i.status === "scheduled")
    .map(
      (i) =>
        `🏢 ${i.company}\n   📅 ${i.date} at ${i.time}\n   📝 ${i.position}\n   🔑 ID: ${i.id}`
    )
    .join("\n\n");
  return {
    response: upcoming
      ? `📅 Your Upcoming Interviews:\n\n${upcoming}`
      : "You have no upcoming interviews scheduled.",
  };
}

async function getRequirements({ userQuery }) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: `The user asked about internship requirements: "${userQuery}"
        Provide a concise, helpful response with:
        - Common requirements (resume, transcripts, etc.)
        - Application tips
        - Skills to highlight
        - Any specific advice for the query
        
        Keep it professional and under 5 bullet points.`,
        },
      ],
      temperature: 0.3,
    });
    return {
      response: response.choices[0].message.content,
    };
  } catch (error) {
    console.error("Requirements error:", error);
    return {
      response:
        "Common internship requirements include a resume, cover letter, and academic transcripts. Specific requirements vary by company.",
    };
  }
}

async function answerGeneralQuestion({ userQuery }) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: `Answer this internship-related question in a helpful, professional manner:
        "${userQuery}"
        
        Keep the response concise (2-3 sentences). If unsure, suggest where to find more information.`,
        },
      ],
      temperature: 0.3,
    });
    return {
      response: response.choices[0].message.content,
    };
  } catch (error) {
    console.error("General question error:", error);
    return {
      response:
        "I can help with general internship questions. Could you please rephrase or provide more details?",
    };
  }
}

// Create graph with proper configuration
const workflow = new StateGraph({
  channels: {
    userQuery: { value: null },
    response: { value: null },
    category: { value: null },
  },
});

// Add all nodes first
workflow.addNode("route_query", routeQuery);
workflow.addNode("schedule_interview", scheduleInterview);
workflow.addNode("cancel_interview", cancelInterview);
workflow.addNode("upcoming_interviews", showInterviews);
workflow.addNode("requirements", getRequirements);
workflow.addNode("general_question", answerGeneralQuestion);
workflow.addNode("end_node", (state) => state); // Proper end node that just passes through state

// Add edges after all nodes are defined
workflow.addEdge("schedule_interview", "end_node");
workflow.addEdge("cancel_interview", "end_node");
workflow.addEdge("upcoming_interviews", "end_node");
workflow.addEdge("requirements", "end_node");
workflow.addEdge("general_question", "end_node");

// Conditional routing
workflow.addConditionalEdges("route_query", (state) => state.category, {
  schedule_interview: "schedule_interview",
  cancel_interview: "cancel_interview",
  upcoming_interviews: "upcoming_interviews",
  requirements: "requirements",
  general_question: "general_question",
  default: "end_node", // Fallback
});

// Set entry point
workflow.setEntryPoint("route_query");

// Set finish point
workflow.setFinishPoint("end_node");

// Compile the workflow
const app = await workflow.compile();

// Create interactive interface
const rl = readline.createInterface({ input, output });

async function handleUserInput() {
  while (true) {
    const userQuery = await rl.question("\n🧑‍💻 You: ");

    if (userQuery.toLowerCase() === "exit") {
      console.log("🤖 Agent: Goodbye! Have a great day!");
      break;
    }

    try {
      const result = await app.invoke({ userQuery });
      console.log(`🤖 Agent: ${result.response}`);
    } catch (error) {
      console.error(
        "🤖 Agent: Sorry, I encountered an error. Please try again."
      );
    }
  }

  rl.close();
}

console.log('🤖 Internship Expert Agent initialized. Type "exit" to quit.\n');
handleUserInput().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
