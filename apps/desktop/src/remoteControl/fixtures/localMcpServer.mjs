import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "fixture", version: "1.2.3" },
  { capabilities: { tools: { listChanged: true } } },
);
let changed = false;
const tool = (name) => ({ name, inputSchema: { type: "object" }, description: name });
server.setRequestHandler(ListToolsRequestSchema, async (request) =>
  request.params?.cursor
    ? { tools: [tool("hang"), tool("large"), tool("crash"), ...(changed ? [tool("added")] : [])] }
    : { tools: [tool("echo"), tool("change")], nextCursor: "second" },
);
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const name = request.params.name;
  if (request.params._meta?.progressToken !== undefined) {
    await server.notification({
      method: "notifications/progress",
      params: {
        progressToken: request.params._meta.progressToken,
        progress: 1,
        total: 2,
        message: "started",
      },
    });
  }
  if (name === "hang") {
    await new Promise((resolve) => {
      extra.signal.addEventListener("abort", resolve, { once: true });
      if (extra.signal.aborted) resolve();
    });
  }
  if (name === "crash") {
    console.error("fixture crashed deliberately");
    process.exit(1);
  }
  if (name === "change") {
    changed = true;
    await server.notification({ method: "notifications/tools/list_changed" });
  }
  if (name === "large") return { content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] };
  return {
    content: [{ type: "text", text: "ok" }],
    structuredContent: request.params.arguments ?? {},
    isError: request.params.arguments?.isError === true,
  };
});
await server.connect(new StdioServerTransport());
