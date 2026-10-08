// Runtime configuration. A single file is used for dev and prod builds; the API is
// always reached through a relative '/api' path (proxied in dev, same-origin in prod).
export const environment = {
  apiBaseUrl: '/api',
  /** Where the MCP server is reachable (the reverse proxy forwards it to the trama-mcp container). */
  mcpPath: '/mcp',
};
