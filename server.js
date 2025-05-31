import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";

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
      {
        name: "schedule_interview",
        description: "Schedule an interview between candidate and company",
        inputSchema: {
          type: "object",
          properties: {
            internshipOpportunityId: {
              type: "number",
              description: "ID of the job description",
            },
            internId: {
              type: "number",
              description: "ID of the candidate",
            },
            interviewLink: {
              type: "string",
              description: "Interview link for the interview",
            },
            interviewerId: {
              type: "string",
              description: "Interviewer id who is conducting the interview",
            },
            startTime: {
              type: "string",
              description: "Interview start date and time (ISO format)",
            },
            endTime: {
              type: "string",
              description: "Interview end date and time (ISO format)",
            },
          },
          required: [
            "internshipOpportunityId",
            "internId",
            "interviewLink",
            "interviewerId",
            "startTime",
            "endTime",
          ],
        },
      },
    ],
  };
});

// Handle recommend candidate tool
async function handleRecommendCandidate(args) {
  try {
    const recommendationData = {
      flow_type: "COMPANY_INTERN",
      comment: "Recommendation from MCP server",
      email_subject: "Recommendation from MCP server",
      email_body_bottom: "&",
      email_body_top:
        '<style>.ql-align-center {\n         text-align: center !important;\n      }</style><div style="font-size:14px;font-family:\'Open Sans\',\'Helvetica Neue\',Helvetica,Arial,sans-serif;mso-line-height-alt:18px;line-height:1.5;padding-left:0px;padding-right:25px;margin-top:12px"><p>Trust you are doing great.</p><p><br></p><p>My name is Prajwal Bhatia, and I was going through your company\'s account on Virtual Internships.</p><p><br></p><p><strong>*Replace with reasons for recommending the below profiles and how they would be a good fit for the company*</strong></p><p><br></p><p>I have just the right candidates for you:</p><p><br></p><ul><li>Meet <a href="http://localhost:3001/intern-profile/8b3c5212-0bb0-48d0-bc90-713b42abc837" rel="noopener noreferrer" target="_blank" style="color: rgb(0, 115, 230);">Marina Oliveira</a> 👈 <strong>*replace with candidate’s profile summary - ensure it’s aligned with the company*</strong></li></ul><p><br></p><p>I am certain they will be a great fit at your company.</p><p><br></p><p>You may check out their profile using the links above and set up an interview with them if everything seems to be in order.</p><p><br></p><p>In case of any questions, please feel free to reply to this email. I will be on standby.</p><p><br></p><p>Regards,</p><p>Prajwal Bhatia</p></div>',
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
          text: `Successfully recommended candidate "${
            args.candidateName
          }" to company "${args.companyName}". 
                 

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

// Handle schedule interview tool
async function handleScheduleInterview(args) {
  try {
    const interviewData = {
      internship_opportunity_id: args.internshipOpportunityId,
      intern_id: args.internId,
      interview_link: args.interviewLink,
      meeting_passcode: null,
      interviewer_id: args.interviewerId,
      interview_timeslots: {
        start_date_time: args.startTime,
        end_date_time: args.endTime,
        interview_duration: 60,
      },
      is_log_interview: 0,
      is_generate_meeting_link: 0,
    };

    const result = await makeApiCall(
      "/api/v1/internal-service/host-company/interview",
      "POST",
      interviewData
    );

    return {
      content: [
        {
          type: "text",
          text: `Successfully scheduled interview!

API Response: ${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to schedule interview: ${error} ${error.message}`
    );
  }
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "recommend_candidate":
      return await handleRecommendCandidate(args);
    case "schedule_interview":
      return await handleScheduleInterview(args);
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Interview Scheduler MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
