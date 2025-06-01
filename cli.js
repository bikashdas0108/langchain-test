#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline";
import OpenAI from "openai";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// OpenAI client setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// MCP client setup
let mcpClient;
let mcpTransport;
let availableTools = [];

// Setup readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Initialize MCP connection
async function initializeMCP() {
  try {
    // Create transport and client first
    mcpTransport = new StdioClientTransport({
      command: "node",
      args: ["server.js"],
    });

    mcpClient = new Client(
      {
        name: "interview-cli",
        version: "0.1.0",
      },
      {
        capabilities: {},
      }
    );

    // Connect to the server
    await mcpClient.connect(mcpTransport);
    console.log("✅ Connected to MCP server");

    // List available tools
    const tools = await mcpClient.listTools();

    console.log("📋 Available tools:");
    tools.tools.forEach((tool) => {
      console.log(`  - ${tool.name}: ${tool.description}`);
    });

    return true;
  } catch (error) {
    console.error("❌ Failed to initialize MCP connection:", error);
    return false;
  }
}

// Analyze user prompt with OpenAI
async function analyzePrompt(userPrompt) {
  try {
    const systemPrompt = `You are a tool selector for an interview scheduling system. 
    
Available tools:
- recommend_candidate: Use when user wants to recommend a candidate to a company
- schedule_interview: Use when user wants to schedule an interview
- cancel_interview: Use when user wants to cancel a scheduled interview

Analyze the user's request and return a JSON response with:
{
  "tool": "tool_name",
  "parameters": {
    "param1": "value1",
    "param2": "value2"
  },
  "confidence": 0.8
}

Extract relevant information from the user's prompt and map it to the appropriate tool parameters.

For recommend_candidate, extract:
- candidateId (number)
- companyId (number)
- pocId (number)

For schedule_interview, extract:
- internshipOpportunityId (number)
- internId (number)
- interviewLink (string) 
- interviewerId (number)
- startTime (string in ISO format)
- endTime (string in ISO format)

For cancel_interview, extract:
- interviewId (number)
- cancelledBy (string, e.g. "Intern" or "HC")

If you're not confident about the tool or parameters, set confidence < 0.5.
Always return valid JSON.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
    });

    const response = completion.choices[0]?.message?.content;
    if (!response) {
      throw new Error("No response from OpenAI");
    }

    return JSON.parse(response);
  } catch (error) {
    console.error("❌ Error analyzing prompt:", error);
    return null;
  }
}

// Execute tool via MCP
async function executeTool(toolName, parameters) {
  try {
    console.log(`🔧 Executing tool: ${toolName}`);
    console.log(`📝 Parameters:`, JSON.stringify(parameters, null, 2));

    const result = await mcpClient.callTool({
      name: toolName,
      arguments: parameters,
    });

    return result;
  } catch (error) {
    console.error("❌ Error executing tool:", error);
    return null;
  }
}

// Main CLI loop
async function startCLI() {
  console.log("\n🎯 Interview Scheduler CLI");
  console.log('Type your requests in natural language, or "exit" to quit.\n');

  const askQuestion = () => {
    rl.question("💬 You: ", async (userInput) => {
      if (userInput.toLowerCase() === "exit") {
        console.log("👋 Goodbye!");
        await cleanup();
        process.exit(0);
      }

      if (!userInput.trim()) {
        askQuestion();
        return;
      }

      console.log("🤔 Analyzing your request...");

      // Analyze the prompt
      const analysis = await analyzePrompt(userInput);

      if (!analysis) {
        console.log("❌ Could not understand your request. Please try again.");
        askQuestion();
        return;
      }

      console.log(
        `🎯 Detected action: ${analysis.tool} (confidence: ${analysis.confidence})`
      );

      if (analysis.confidence < 0.5) {
        console.log(
          "⚠️  Low confidence in understanding. Please be more specific."
        );
        askQuestion();
        return;
      }

      // Execute the tool
      const result = await executeTool(analysis.tool, analysis.parameters);

      if (result) {
        console.log("✅ Success!");
        if (result.content && result.content[0]) {
          console.log("\n📋 Result:");
          console.log(result.content[0].text);
        }
      } else {
        console.log("❌ Failed to execute the request.");
      }

      console.log("\n" + "─".repeat(50) + "\n");
      askQuestion();
    });
  };

  askQuestion();
}

// Cleanup function
async function cleanup() {
  console.log("\n🧹 Cleaning up...");
  rl.close();
  if (mcpTransport) {
    await mcpTransport.close();
  }
}

// Main function
async function main() {
  console.log("🚀 Starting Interview Scheduler CLI...");

  // Check for OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY environment variable is required");
    console.error("💡 Create a .env file with: OPENAI_API_KEY=your-key-here");
    process.exit(1);
  }

  // Initialize MCP connection
  const mcpReady = await initializeMCP();

  if (!mcpReady) {
    console.error("❌ Failed to connect to MCP server");
    process.exit(1);
  }

  // Start the CLI
  await startCLI();
}

// Handle cleanup on exit
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(0);
});

main().catch(async (error) => {
  console.error("❌ CLI failed to start:", error);
  await cleanup();
  process.exit(1);
});
