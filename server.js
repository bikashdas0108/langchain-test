import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  InitializeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { randomUUID } from "crypto";

const SESSION_ID_HEADER_NAME = "mcp-session-id";
const JSON_RPC = "2.0";

// API base URL
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:4000";

// Helper function to make API calls
async function makeApiCall(endpoint, method = "GET", data = null) {
  const url = `${API_BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
    },
  };

  if (data && method !== "GET") {
    options.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(
        `API call failed: ${response.status} ${response.statusText}`
      );
    }

    return await response.json();
  } catch (error) {
    console.log("🚀 ~ makeApiCall ~ error:", error);
    throw new Error(
      `Failed to make API call to ${url}: ${error} ${error.message}`
    );
  }
}

// Create the MCP server
const server = new Server(
  {
    name: "interview-scheduler",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

export class MCPServer {
  server;

  // to support multiple simultaneous connections
  transports = {};

  constructor(server) {
    this.server = server;
    this.setupTools();
  }

  async handleGetRequest(req, res) {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !this.transports[sessionId]) {
      res
        .status(400)
        .json(
          this.createErrorResponse("Bad Request: invalid session ID or method.")
        );
      return;
    }

    console.log(`Establishing SSE stream for session ${sessionId}`);
    const transport = this.transports[sessionId];
    await transport.handleRequest(req, res);
    await this.streamMessages(transport);

    return;
  }

  async handlePostRequest(req, res) {
    const sessionId = req.headers[SESSION_ID_HEADER_NAME];
    let transport;

    try {
      // reuse existing transport
      if (sessionId && this.transports[sessionId]) {
        transport = this.transports[sessionId];
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // create new transport
      if (!sessionId && this.isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        await this.server.connect(transport);
        await transport.handleRequest(req, res, req.body);

        // session ID will only be available (if in not Stateless-Mode)
        // after handling the first request
        const sessionId = transport.sessionId;
        if (sessionId) {
          this.transports[sessionId] = transport;
        }

        return;
      }

      res
        .status(400)
        .json(
          this.createErrorResponse("Bad Request: invalid session ID or method.")
        );
      return;
    } catch (error) {
      console.error("Error handling MCP request:", error);
      res.status(500).json(this.createErrorResponse("Internal server error."));
      return;
    }
  }

  async cleanup() {
    await this.server.close();
  }

  setupTools() {
    // Define available tools - only recommend_candidate
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "recommend_candidate",
            description:
              "Recommend a candidate to a company for an internship position",
            inputSchema: {
              type: "object",
              properties: {
                candidateId: {
                  type: "number",
                  description: "Id of the candidate",
                },
                companyId: {
                  type: "number",
                  description: "Id of the company",
                },
                pocId: {
                  type: "number",
                  description: "Id of the company",
                },
              },
              required: ["candidateId", "companyId", "pocId"],
            },
          },
        ],
      };
    });

    // handle tool calls
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        const args = request.params.arguments;
        const toolName = request.params.name;
        console.log("Received request for tool with argument:", toolName, args);

        if (!args) {
          throw new Error("arguments undefined");
        }

        if (!toolName) {
          throw new Error("tool name undefined");
        }

        if (toolName === "recommend_candidate") {
          try {
            const recommendationData = {
              flow_type: "COMPANY_INTERN",
              comment: "Recommendation from MCP server",
              email_subject: "Recommendation from MCP server",
              email_body_bottom: "&",
              email_body_top: `<style>.ql-align-center {
         text-align: center !important;
      }</style><div style="font-size:14px;font-family:'Open Sans','Helvetica Neue',Helvetica,Arial,sans-serif;mso-line-height-alt:18px;line-height:1.5;padding-left:0px;padding-right:25px;margin-top:12px"><p>Trust you are doing great.</p><p><br></p><p>My name is Prajwal Bhatia, and I was going through your company's account on Virtual Internships.</p><p><br></p><p><strong>*Replace with reasons for recommending the below profiles and how they would be a good fit for the company*</strong></p><p><br></p><p>I have just the right candidates for you:</p><p><br></p><ul><li>Meet <a href="http://localhost:3001/intern-profile/8b3c5212-0bb0-48d0-bc90-713b42abc837" rel="noopener noreferrer" target="_blank" style="color: rgb(0, 115, 230);">Marina Oliveira</a> 👈 <strong>*replace with candidate's profile summary - ensure it's aligned with the company*</strong></li></ul><p><br></p><p>I am certain they will be a great fit at your company.</p><p><br></p><p>You may check out their profile using the links above and set up an interview with them if everything seems to be in order.</p><p><br></p><p>In case of any questions, please feel free to reply to this email. I will be on standby.</p><p><br></p><p>Regards,</p><p>Prajwal Bhatia</p></div>`,
              recommendation_data: [
                {
                  intern_id: args.candidateId,
                  career_field_id: 1,
                  batch_id: 149,
                  application_id: 1205,
                  host_companies: [
                    {
                      host_company_id: args.companyId,
                    },
                  ],
                },
              ],
              pocs: [
                {
                  host_company_id: args.companyId,
                  poc_id: args.pocId,
                },
              ],
            };

            const result = await makeApiCall(
              "/api/v1/internal-service/recommendation",
              "POST",
              recommendationData
            );

            return {
              content: [
                {
                  type: "text",
                  text: `Successfully recommended candidate to company. 

API Response: ${JSON.stringify(result, null, 2)}`,
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to create recommendation: ${error.message}`
            );
          }
        }

        throw new Error("Tool not found");
      }
    );
  }

  // send message streaming message every second
  async streamMessages(transport) {
    try {
      // based on LoggingMessageNotificationSchema to trigger setNotificationHandler on client
      const message = {
        method: "notifications/message",
        params: { level: "info", data: "SSE Connection established" },
      };

      this.sendNotification(transport, message);

      let messageCount = 0;

      const interval = setInterval(async () => {
        messageCount++;

        const data = `Message ${messageCount} at ${new Date().toISOString()}`;

        const message = {
          method: "notifications/message",
          params: { level: "info", data: data },
        };

        try {
          this.sendNotification(transport, message);

          if (messageCount === 2) {
            clearInterval(interval);

            const message = {
              method: "notifications/message",
              params: { level: "info", data: "Streaming complete!" },
            };

            this.sendNotification(transport, message);
          }
        } catch (error) {
          console.error("Error sending message:", error);
          clearInterval(interval);
        }
      }, 1000);
    } catch (error) {
      console.error("Error sending message:", error);
    }
  }

  async sendNotification(transport, notification) {
    const rpcNotificaiton = {
      ...notification,
      jsonrpc: JSON_RPC,
    };
    await transport.send(rpcNotificaiton);
  }

  createErrorResponse(message) {
    return {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: message,
      },
      id: randomUUID(),
    };
  }

  isInitializeRequest(body) {
    const isInitial = (data) => {
      const result = InitializeRequestSchema.safeParse(data);
      return result.success;
    };
    if (Array.isArray(body)) {
      return body.some((request) => isInitial(request));
    }
    return isInitial(body);
  }
}

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Create MCP server instance
const mcpServer = new MCPServer(server);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "interview-scheduler-mcp" });
});

// MCP endpoints
app.get("/mcp", async (req, res) => {
  await mcpServer.handleGetRequest(req, res);
});

app.post("/mcp", async (req, res) => {
  await mcpServer.handlePostRequest(req, res);
});

// Start the server
async function main() {
  app.listen(PORT, () => {
    console.error(
      `Interview Scheduler MCP server running on HTTP port ${PORT}`
    );
    console.error(`Health check: http://localhost:${PORT}/health`);
    console.error(`MCP endpoint: http://localhost:${PORT}/mcp`);
  });
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
