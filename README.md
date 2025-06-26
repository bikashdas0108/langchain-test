# MCP Server (`server.js`) Documentation

This README focuses exclusively on the MCP server implementation found in `server.js`.

---

## Overview

The MCP server provides a session-based API for tool-augmented workflows, such as recommending internship candidates. It is built using Express and the Model Context Protocol SDK, and exposes endpoints for session management, tool invocation, and (optionally) real-time notifications.

---

## Endpoints

### 1. `POST /mcp`

- **Purpose:** Handles session initialization and all JSON-RPC requests (e.g., listing tools, calling tools).
- **How it works:**
  - **Session Initialization:**
    - The client sends a POST request with an `initialize` method in the body (no session ID header).
    - The server creates a new session, responds with a `mcp-session-id` header, and sets up a transport for the session.
  - **Subsequent Requests:**
    - The client includes the `mcp-session-id` header for all further requests (e.g., tool calls).
    - The server routes the request to the correct session/transport.

### 2. `GET /mcp`

- **Purpose:** Establishes a Server-Sent Events (SSE) stream for real-time notifications or streaming data.
- **How it works:**
  - The client sends a GET request with the `mcp-session-id` header.
  - The server checks the session and, if valid, establishes an SSE stream for that session.
  - The server can then push notifications or streaming messages to the client.
- **Note:** The current client implementation does not use this feature, but the server supports it for future extensibility.

---

## Session Management

- Each session is identified by a unique `mcp-session-id` (UUID), generated during initialization.
- The server maintains a mapping of session IDs to transport objects, ensuring stateful, isolated communication for each client.
- All tool calls and streaming requests are routed based on the session ID.

---

## Tool Handling

- Tools are defined in the `setupTools()` method.
- Example tool: `recommend_candidate` (requires `candidateId`, `companyId`, and `pocId`).
- Tool calls are handled via the `CallToolRequestSchema` handler, which processes arguments, makes API calls, and returns results or errors.

---

## Running the MCP Server

1. **Install dependencies:**

   ```bash
   npm install
   # or
   yarn install
   ```

2. **Set environment variables (optional):**

   - To override the API base URL:
     ```
     API_BASE_URL=http://localhost:4000
     ```

3. **Start the server:**
   ```bash
   node server.js
   ```
   You should see output like:
   ```
   Interview Scheduler MCP server running on HTTP port 3000
   Health check: http://localhost:3000/health
   MCP endpoint: http://localhost:3000/mcp
   ```

---

## FAQ

- **Why is a session ID needed?**

  - The session ID allows the server to maintain stateful, secure, and isolated communication for each client. It enables resource management, protocol compliance, and error handling.

- **What are the use cases for `GET /mcp` and `POST /mcp`?**

  - `POST /mcp` is used for session initialization and all tool-related requests.
  - `GET /mcp` is used to establish an SSE stream for real-time notifications (not currently used by the client, but supported by the server).

- **How does the server handle multiple clients?**
  - Each client gets a unique session and transport, ensuring their requests and streaming data are isolated from others.

---

## Extending the Server

- To add more tools, define them in `setupTools()` and implement their logic in the corresponding handler.
- To support more notification types, extend the SSE logic in `streamMessages()`.

---

## License

MIT
