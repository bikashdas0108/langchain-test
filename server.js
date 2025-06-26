import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";

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

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
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
              description: "Array of IR (Internal Recruiter) IDs to filter by",
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
              description: 'Type of career fields to retrieve (e.g., "global")',
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
        parameters: {
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

async function getCandidateList(args) {
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
${JSON.stringify(candidates, null, 2)}`,
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


async function getCareerFieldList(args) {
  try {
    const careerField = await makeApiCall(
      `/common-services/career-field/get-list`,
      "GET",
      {}
    );
    // Format the response for better readability
    const careerFieldCount = careerField.data?.payload?.length || 0;

    return {
      content: [
        {
          type: "text",
          text: `Found ${careerFieldCount} career fields:

**Query Parameters:**
- Type: ${args.type || "global"}

**Results:**
${JSON.stringify(careerField.data?.payload, null, 2)}`,
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

async function getIoList(args) {
  try {
    const ioList = await makeApiCall(
      `/host-company/browse-intern/get-io-list?with_career_field=1`,
      "GET",
      {}
    );
    // Format the response for better readability
    const ioCount = ioList.data?.payload?.length || 0;

    return {
      content: [
        {
          type: "text",
          text: `Found ${ioCount} Internship Opportunities (IOs):

**Query Parameters:**
- Type: ${args.type || "global"}

**Results:**
${JSON.stringify(ioList.data?.payload, null, 2)}`,
        },
      ],
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to retrieve io list: ${error.message}`
    );
  }
}

async function shortListIntern(args) {
  const body = {
    intern_id: Number(args.internId),
  };

  try {
    const careerField = await makeApiCall(
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
      `Failed to retrieve career field list: ${error.message}`
    );
  }
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_candidate_list":
      return await getCandidateList(args);
    case "get_io_list":
      return await getIoList(args);
    case "get_career_field_list":
      return await getCareerFieldList(args);
    case "shortlist_intern":
      return await shortListIntern(args);
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Intern list MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
