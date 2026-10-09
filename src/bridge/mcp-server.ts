import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StellaClient } from "../stella/client.js";
import { resolveStellaModel, KNOWN_DEFAULT_MODELS } from "../stella/models.js";

export const MCP_SERVER_INFO = {
  name: "codex-stella-web",
  version: "1.0.0",
};

export const MCP_TOOLS = [
  {
    name: "ask_stella",
    description:
      "Send a question, coding task, or reasoning prompt to Stella AI. Stella AI will process it using top-tier models (GPT-5.6 Terra/Luna, Claude Sonnet 5, Grok 4.6, Gemini 3.8 Flash, or Deep Inference) under your Stella AI subscription without per-token API fees.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The prompt, instruction, or code to send to Stella AI.",
        },
        model: {
          type: "string",
          description:
            "Target model: 'stella-auto' (default), 'stella-deep-inference' (reasoning mode), 'gpt-6-sol', 'gpt-6-luna', 'claude-sonnet-5.5', 'claude-haiku-4.5', 'grok-4.7', 'gemini-3.8-flash', or 'gemini-3.5-flash-lite'.",
          default: "stella-auto",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "stella_deep_research",
    description:
      "Execute deep research and extended reasoning through Stella AI's deep inference mode.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Topic, question, or problem to research in depth.",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "list_stella_models",
    description: "List all AI models available on your Stella AI account.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export async function handleMcpRpc(
  client: StellaClient,
  request: any
): Promise<any> {
  const { id, method, params } = request;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: MCP_SERVER_INFO,
      },
    };
  }

  if (method === "notifications/initialized") {
    // Notification: no response required
    return null;
  }

  if (method === "ping") {
    return {
      jsonrpc: "2.0",
      id,
      result: {},
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: MCP_TOOLS,
      },
    };
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === "list_stella_models") {
      let models = [];
      try {
        models = await client.fetchAiModels();
      } catch {
        models = KNOWN_DEFAULT_MODELS;
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(models, null, 2),
            },
          ],
        },
      };
    }

    if (name === "ask_stella") {
      const prompt = args.prompt;
      const model = args.model || "stella-auto";
      let availableModels: any[] = [];
      try {
        availableModels = await client.fetchAiModels();
      } catch {
        // ignore
      }
      const resolved = resolveStellaModel(model, availableModels);

      try {
        const response = await client.askOneTurn(
          prompt,
          resolved.stellaModelId,
          resolved.searchType
        );
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: response,
              },
            ],
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error calling Stella AI: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          },
        };
      }
    }

    if (name === "stella_deep_research") {
      const topic = args.topic;
      let availableModels: any[] = [];
      try {
        availableModels = await client.fetchAiModels();
      } catch {
        // ignore
      }
      const resolved = resolveStellaModel("stella-deep-inference", availableModels);

      try {
        const response = await client.askOneTurn(
          `以下の課題について、徹底的に深く推論・調査し、結論と実装方針をまとめてください:\n\n${topic}`,
          resolved.stellaModelId,
          "deep_inference"
        );
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: response,
              },
            ],
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error in deep research: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          },
        };
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Unknown tool: ${name}`,
      },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  };
}

/**
 * Handle HTTP MCP connections (Streamable HTTP / SSE) for ChatGPT.app and ChatGPT Web
 */
export async function handleHttpMcp(
  req: IncomingMessage,
  res: ServerResponse,
  client: StellaClient,
  bodyJson?: any
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // 1. GET /mcp or GET /sse -> Streamable HTTP / Server-Sent Events handshake
  if (req.method === "GET") {
    const accept = req.headers["accept"] || "";
    if (accept.includes("text/event-stream") || pathname === "/sse") {
      const sessionId = randomUUID();
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // Send endpoint event for client POST targets
      res.write(`event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`);
      return;
    }

    // Status / info JSON
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(
      JSON.stringify({
        status: "ok",
        protocol: "mcp",
        server: MCP_SERVER_INFO,
        tools: MCP_TOOLS.map((t) => t.name),
      })
    );
    return;
  }

  // 2. POST /mcp or POST /message -> JSON-RPC Request
  if (req.method === "POST") {
    if (!bodyJson) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing JSON-RPC payload" }));
      return;
    }

    const result = await handleMcpRpc(client, bodyJson);
    if (!result) {
      // Notification
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

/**
 * Run standard stdio MCP server for CLI tools, Claude Desktop, or ChatGPT app local connectors
 */
export async function runStdioMcp(client: StellaClient): Promise<void> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const req = JSON.parse(trimmed);
      const res = await handleMcpRpc(client, req);
      if (res) {
        process.stdout.write(JSON.stringify(res) + "\n");
      }
    } catch (err) {
      process.stderr.write(
        `[codex-stella-web mcp] malformed JSON-RPC: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }
}
