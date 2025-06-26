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

// Helper function to convert object to query string
export const objectToQueryString = (obj) =>
  Object.entries(obj)
    .filter(([key, value]) => {
      if (Array.isArray(value) && key) {
        return value.length > 0;
      }
      return value !== undefined && value !== null;
    })
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${encodeURIComponent(key)}[]=${value
          .map((item) => encodeURIComponent(item))
          .join(",")}`;
      } else {
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      }
    })
    .join("&");

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
    return;
  }

  async handlePostRequest(req, res) {
    const sessionId = req.headers[SESSION_ID_HEADER_NAME.toLowerCase()]; // HTTP headers are lowercase
    let transport;

    try {
      console.log("📨 Received POST request");
      console.log("📋 Headers:", req.headers);
      console.log("📄 Body:", JSON.stringify(req.body, null, 2));
      console.log("🔑 Session ID from header:", sessionId);

      // Set CORS headers
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.header(
        "Access-Control-Allow-Headers",
        "Content-Type, mcp-session-id"
      );

      // reuse existing transport
      if (sessionId && this.transports[sessionId]) {
        console.log("♻️ Reusing existing transport for session:", sessionId);
        transport = this.transports[sessionId];
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // create new transport
      if (!sessionId && this.isInitializeRequest(req.body)) {
        console.log("🆕 Creating new transport for initialize request");
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        await this.server.connect(transport);
        await transport.handleRequest(req, res, req.body);

        // session ID will only be available (if not in Stateless-Mode)
        // after handling the first request
        const newSessionId = transport.sessionId;
        if (newSessionId) {
          this.transports[newSessionId] = transport;
          console.log("💾 Stored transport for session:", newSessionId);
        }

        return;
      }

      console.error(
        "❌ Bad request - missing session ID or not initialize request"
      );
      res
        .status(400)
        .json(
          this.createErrorResponse("Bad Request: invalid session ID or method.")
        );
      return;
    } catch (error) {
      console.error("❌ Error handling MCP request:", error);
      console.error("❌ Stack trace:", error.stack);
      res
        .status(500)
        .json(
          this.createErrorResponse("Internal server error: " + error.message)
        );
      return;
    }
  }

  async cleanup() {
    await this.server.close();
  }

  setupTools() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "get_company_project_list",
            description:
              "Retrieve a list of all available company projects in the system. This provides access to project listings that can be used for filtering candidates or understanding available project opportunities.",
            inputSchema: {
              type: "object",
              properties: {
                perPage: {
                  type: "string",
                  description: "Number of results to return per page",
                  default: "10",
                },
                pageNumber: {
                  type: "string",
                  description: "Page number for pagination (starts from 1)",
                  default: "1",
                },
              },
              additionalProperties: false,
            },
          },
          {
            name: "get_internship_opportunity_list",
            description:
              "Retrieve a list of all available internship opportunities (IOs) in the system. This provides access to internship listings with career field information included.",
            inputSchema: {
              type: "object",
              properties: {
                with_career_field: {
                  type: "string",
                  description:
                    "Include career field information in the response (e.g., '1' to include)",
                  default: "1",
                },
              },
              additionalProperties: false,
            },
          },
          {
            name: "get_candidate_list",
            description:
              "Retrieve a filtered list of candidates based on various criteria including skills, preferred start months, duration, projects, career fields, and more. This provides comprehensive candidate browsing capabilities.",
            inputSchema: {
              type: "object",
              properties: {
                skillIds: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description:
                    "Array of skill IDs to filter candidates by their skills",
                  default: [],
                },
                preferredStartMonths: {
                  type: "array",
                  items: {
                    type: "string",
                    pattern: "^\\d{1,2}\\/\\d{4}(,\\d{1,2}\\/\\d{4})*$",
                  },
                  description:
                    'Array of preferred start months in MM/YYYY format (e.g., ["01/2024", "02/2024"])',
                  default: [],
                },
                durations: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description: "Array of internship durations to filter by",
                  default: [],
                },
                projectIds: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description:
                    "Array of project IDs to filter candidates by their projects",
                  default: [],
                },
                careerFieldIds: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description:
                    "Array of career field IDs to filter candidates by their career interests",
                  default: [],
                },
                internUuids: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description: "Array of specific intern UUIDs to retrieve",
                  default: [],
                },
                onlyFilters: {
                  type: "boolean",
                  description:
                    "Boolean flag to return only filter options without candidate data",
                  default: false,
                },
                perPage: {
                  type: "string",
                  description: "Number of results to return per page",
                  default: "10",
                },
                pageNumber: {
                  type: "string",
                  description: "Page number for pagination (starts from 1)",
                  default: "1",
                },
                irIds: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description:
                    "Array of IR (Internal Recruiter) IDs to filter by",
                  default: [],
                },
                careerSkillName: {
                  type: "string",
                  description: "Search by career skill name",
                },
                wantToLearnCareerFieldSkillName: {
                  type: "string",
                  description: "Search by skills the candidate wants to learn",
                },
                projectsDescription: {
                  type: "string",
                  description: "Search within project descriptions",
                },
                aboutMe: {
                  type: "string",
                  description: 'Search within candidate "about me" sections',
                },
                countryIds: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description:
                    "Array of country IDs to filter candidates by location",
                  default: [],
                },
                universityName: {
                  type: "string",
                  description: "Search by university name",
                },
                pastExperience: {
                  type: "string",
                  description: "Search within past experience descriptions",
                },
                portfolio: {
                  type: "string",
                  description: "Search within portfolio information",
                },
              },
              additionalProperties: false,
            },
          },
          {
            name: "get_career_field_list",
            description:
              "Retrieve a list of all available career fields in the system. This can be used to get career field IDs and names for filtering candidates or understanding available career options.",
            inputSchema: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  description:
                    'Type of career fields to retrieve (e.g., "global")',
                  default: "global",
                },
              },
              additionalProperties: false,
            },
          },
          {
            name: "shortlist_intern",
            description:
              "Add an intern to the shortlist for a host company. This allows companies to save promising candidates for future reference and consideration.",
            inputSchema: {
              type: "object",
              properties: {
                internId: {
                  type: "string",
                  description:
                    "The unique identifier of the intern to be shortlisted",
                },
              },
              required: ["internId"],
              additionalProperties: false,
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        const { name, arguments: args } = request.params;
        console.log("Received request for tool with argument:", name, args);

        switch (name) {
          case "get_candidate_list":
            return await this.getCandidateList(args);
          case "get_career_field_list":
            return await this.getCareerFieldList(args);
          case "get_internship_opportunity_list":
            return await this.getIoList(args);
          case "get_company_project_list":
            return await this.getCompanyProjectList(args);
          case "shortlist_intern":
            return await this.shortListIntern(args);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      }
    );
  }

  async getCandidateList(args) {
    try {
      const candidateQuery = {};

      // Helper functions to conditionally add fields
      const addIfTruthy = (key, value) => {
        if (value) candidateQuery[key] = value;
      };

      const addIfArray = (key, value) => {
        if (Array.isArray(value) && value.length > 0) {
          candidateQuery[key] = value;
        }
      };

      // Add query params conditionally
      addIfArray("skill_ids", args.skillIds);
      addIfArray("preferred_start_months", args.preferredStartMonths);
      addIfArray("durations", args.durations);
      addIfArray("project_ids", args.projectIds);
      addIfArray("career_field_ids", args.careerFieldIds);
      addIfArray("intern_uuids", args.internUuids);
      addIfArray("ir_ids", args.irIds);
      addIfArray("country_ids", args.countryIds);

      addIfTruthy("onlyFilters", args.onlyFilters);
      addIfTruthy("per_page", args.perPage || "10");
      addIfTruthy("page_number", args.pageNumber || "1");

      addIfTruthy("career_skill_name", args.careerSkillName);
      addIfTruthy(
        "want_to_learn_career_field_skill_name",
        args.wantToLearnCareerFieldSkillName
      );
      addIfTruthy("projects_description", args.projectsDescription);
      addIfTruthy("about_me", args.aboutMe);
      addIfTruthy("university_name", args.universityName);
      addIfTruthy("past_experience", args.pastExperience);
      addIfTruthy("portfolio", args.portfolio);

      const queryString = objectToQueryString(candidateQuery);
      const updatedUrl = `/host-company/browse/candidates?${queryString}`;

      const candidates = await makeApiCall(updatedUrl, "GET");

      const totalCandidates = candidates.data?.length || 0;
      const pagination = candidates.pagination || {};

      const updatedCandidates = {
        count: candidates.data?.payload?.count,
        list: candidates.data?.payload?.list?.map((item) => ({
          full_name: item.full_name,
          phone_number: item.phone_number,
          application: {
            application_id: item.application?.application_id,
            application_status: item.application?.application_status,
            duration: item.application?.duration,
            career_field_selected: item.application?.career_field_selected,
            hours_per_week: item.application?.hours_per_week,
            preferred_internship_start_date:
              item.application?.preferred_internship_start_date,
          },
        })),
      };
      return {
        content: [
          {
            type: "text",
            text: `Found ${totalCandidates} candidates matching your criteria:

**Query Parameters:**
- Skill IDs: ${args.skillIds?.join(", ") || "None"}
- Preferred Start Months: ${args.preferredStartMonths?.join(", ") || "None"}
- Durations: ${args.durations?.join(", ") || "None"}
- Project IDs: ${args.projectIds?.join(", ") || "None"}
- Career Field IDs: ${args.careerFieldIds?.join(", ") || "None"}
- Page: ${args.pageNumber || "1"}
- Results per page: ${args.perPage || "10"}
- Only Filters: ${args.onlyFilters || false}

**Search Terms:**
- Career Skill Name: ${args.careerSkillName || "None"}
- Want to Learn: ${args.wantToLearnCareerFieldSkillName || "None"}
- Projects Description: ${args.projectsDescription || "None"}
- About Me: ${args.aboutMe || "None"}
- University Name: ${args.universityName || "None"}
- Past Experience: ${args.pastExperience || "None"}
- Portfolio: ${args.portfolio || "None"}

**Pagination Info:**
- Current Page: ${pagination.current_page || args.pageNumber || "1"}
- Total Pages: ${pagination.total_pages || "N/A"}
- Total Records: ${pagination.total_records || "N/A"}

**Results:**
${JSON.stringify(updatedCandidates, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to retrieve candidate list: ${error.message}`
      );
    }
  }

  async getCareerFieldList(args) {
    try {
      const careerField = await makeApiCall(
        `/common-services/career-field/get-list`,
        "GET",
        {}
      );
      // Format the response for better readability
      const careerFieldCount = careerField.data?.payload?.length || 0;
      const updatedCFs = careerField.data?.payload?.map((item) => ({
        career_field_id: item.career_field_id,
        career_field_name: item.career_field_name,
      }));
      return {
        content: [
          {
            type: "text",
            text: `Found ${careerFieldCount} career fields:

**Query Parameters:**
- Type: ${args.type || "global"}

**Results:**
${JSON.stringify(updatedCFs, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to retrieve career field list: ${error.message}`
      );
    }
  }

  async getIoList(args) {
    try {
      const ioList = await makeApiCall(
        `/host-company/browse-intern/get-io-list?with_career_field=1`,
        "GET",
        {}
      );
      // Format the response for better readability
      const ioListCount = ioList.data?.payload?.length || 0;
      const updatedIoList = ioList.data?.payload?.map((item) => ({
        internship_opportunity_id: item.internship_opportunity_id,
        internship_opportunity_name: item.internship_opportunity_name,
        is_active: item.is_active,
        career_field_id: item.career_field_id,
      }));
      return {
        content: [
          {
            type: "text",
            text: `Found ${ioListCount} internship opportunities:

**Query Parameters:**
- Type: ${args.type || "global"}

**Results:**
${JSON.stringify(updatedIoList, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to retrieve internship opportunities list: ${error.message}`
      );
    }
  }

  async getCompanyProjectList(args) {
    console.log("🚀 ~ MCPServer ~ getCompanyProjectList ~ args:", args);
    try {
      // Build query parameters
      const queryParams = new URLSearchParams();

      if (args.perPage) {
        queryParams.append("perPage", args.perPage);
      }

      if (args.pageNumber) {
        queryParams.append("pageNumber", args.pageNumber);
      }

      // Construct the URL with query parameters
      const queryString = queryParams.toString();
      const url = queryString
        ? `/common-services/company-project/list?${queryString}`
        : `/common-services/company-project/list`;

      const projectList = await makeApiCall(url, "GET", {});

      // Format the response for better readability
      const projectListCount = projectList.data?.payload?.length || 0;
      const updatedProjectList = projectList.data?.payload?.map((item) => ({
        project_id: item.project_id,
        project_name: item.project_name,
      }));

      // Build query parameters display
      const queryParamsDisplay = [];
      queryParamsDisplay.push(`Type: ${args.type || "global"}`);

      if (args.perPage) {
        queryParamsDisplay.push(`Per Page: ${args.perPage}`);
      }

      if (args.pageNumber) {
        queryParamsDisplay.push(`Page Number: ${args.pageNumber}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${projectListCount} projects:

**Query Parameters:**
${queryParamsDisplay.map((param) => `- ${param}`).join("\n")}

**Results:**
${JSON.stringify(updatedProjectList, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to retrieve project list: ${error.message}`
      );
    }
  }

  async shortListIntern(args) {
    const body = {
      intern_id: Number(args.internId),
    };

    try {
      const result = await makeApiCall(
        `/host-company/browse-intern/save-shortlist-intern`,
        "POST",
        body
      );

      return {
        content: [
          {
            type: "text",
            text: `Successfully shortlisted intern with ID: ${args.internId}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to shortlist intern: ${error.message}`
      );
    }
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
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());
app.options("/mcp", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
  res.sendStatus(200);
});
app.use("/mcp", (req, res, next) => {
  console.log("🔍 MCP Request Details:");
  console.log("   Method:", req.method);
  console.log("   Headers:", JSON.stringify(req.headers, null, 2));
  console.log("   Body:", JSON.stringify(req.body, null, 2));
  console.log("   Query:", req.query);
  next();
});

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
