import {invokeLogged} from "./apiCore.ts";

/** Connection info returned by `start_mcp_server`: the URL an AI client uses
 *  (already includes the per-launch token in the path) and the token itself. */
export interface McpEndpoint {
    url: string;
    token: string;
}

/** Start the read-only MCP HTTP server on 127.0.0.1:port. Returns the
 *  connection URL (with a per-launch token in the path) for an AI client.
 *  Rejects if the server is already running or the port can't be bound. */
export function startMcpServer(port: number): Promise<McpEndpoint> {
    return invokeLogged<McpEndpoint>("start_mcp_server", {port}, {
        message: "Failed to start MCP server",
    });
}

/** Stop the MCP HTTP server if one is running. Idempotent — safe to call when
 *  no server is running. */
export function stopMcpServer(): Promise<void> {
    return invokeLogged<void>("stop_mcp_server", {}, {
        message: "Failed to stop MCP server",
    });
}
