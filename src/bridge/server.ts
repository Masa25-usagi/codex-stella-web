import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { writeFileSync, chmodSync } from "node:fs";
import { DEFAULT_HOST, DEFAULT_PORT, getDaemonPidPath } from "../config.js";
import { StellaClient } from "../stella/client.js";
import { toOpenAiModelCatalog } from "../stella/models.js";
import { assertLoopbackHost, removePidFileIfOwned } from "../daemon.js";
import { handleChatCompletions } from "./chat-completions-bridge.js";
import { handleResponsesRequest } from "./responses-bridge.js";
import { handleHttpMcp } from "./mcp-server.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  client?: StellaClient;
}

const SERVER_START_TIME = new Date().toISOString();

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export function startBridgeServer(options: ServerOptions = {}): Promise<Server> {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const client = options.client ?? new StellaClient();

  try {
    assertLoopbackHost(host);
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Enable CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const path = url.pathname;

      try {
        // Health check
        if (path === "/" || path === "/health" || path === "/v1" || path === "/v1/") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              service: "codex-stella-web",
              version: "1.0.0",
              pid: process.pid,
              startedAt: SERVER_START_TIME,
              uptimeSeconds: Math.floor(process.uptime()),
              endpoint: `http://${host}:${port}`,
              mcp: `http://${host}:${port}/mcp`,
            })
          );
          return;
        }

        // MCP Handshake (GET /mcp, GET /sse)
        if (req.method === "GET" && (path === "/mcp" || path === "/sse")) {
          await handleHttpMcp(req, res, client);
          return;
        }

        if (path === "/v1/models" || path === "/models") {
          let models: any[] = [];
          try {
            models = await client.fetchAiModels();
          } catch {
            // Use defaults if fetch fails
          }

          const openAiCatalog = toOpenAiModelCatalog(models);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(openAiCatalog));
          return;
        }

        // Single model lookup: /v1/models/:modelId
        if (req.method === "GET" && (path.startsWith("/v1/models/") || path.startsWith("/models/"))) {
          const modelId = path.split("/").pop() || "stella-auto";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: modelId,
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: "stella-ai",
            })
          );
          return;
        }

        // Read request body for POST requests
        if (req.method === "POST") {
          let bodyString = "";
          try {
            bodyString = await readBody(req);
          } catch (readErr) {
            console.error(`[codex-stella-web] Error reading body on ${path}:`, readErr);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message: "Failed to read request body",
                  type: "invalid_request_error",
                  param: null,
                  code: "read_error",
                },
              })
            );
            return;
          }

          let bodyJson: any = {};
          const trimmed = bodyString.trim();
          if (trimmed) {
            try {
              bodyJson = JSON.parse(trimmed);
            } catch (err) {
              console.warn(
                `[codex-stella-web] Warning: non-JSON body on POST ${path}:`,
                err instanceof Error ? err.message : String(err),
                `Preview: "${trimmed.slice(0, 100)}"`
              );

              // If endpoint is MCP, it might be an empty notification or plain probe
              if (path === "/mcp" || path === "/message") {
                bodyJson = {};
              } else {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    error: {
                      message: "Invalid JSON in request body",
                      type: "invalid_request_error",
                      param: null,
                      code: "invalid_json",
                    },
                  })
                );
                return;
              }
            }
          }

          // MCP JSON-RPC (POST /mcp or POST /message)
          if (path === "/mcp" || path === "/message") {
            await handleHttpMcp(req, res, client, bodyJson);
            return;
          }

          const abortController = new AbortController();
          res.on("close", () => {
            if (!res.writableEnded) abortController.abort();
          });

          // Chat completions
          if (path === "/v1/chat/completions" || path === "/chat/completions") {
            await handleChatCompletions(bodyJson, client, res, abortController.signal);
            return;
          }

          // Codex Responses API
          if (path === "/v1/responses" || path === "/responses") {
            await handleResponsesRequest(bodyJson, client, res, abortController.signal);
            return;
          }

          // Embeddings endpoint stub (used by Codex App for background indexing/search)
          if (path === "/v1/embeddings" || path === "/embeddings") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                object: "list",
                data: [
                  {
                    object: "embedding",
                    index: 0,
                    embedding: new Array(1536).fill(0.0),
                  },
                ],
                model: "text-embedding-3-small",
                usage: { prompt_tokens: 0, total_tokens: 0 },
              })
            );
            return;
          }

          // Telemetry endpoint stub
          if (path === "/v1/telemetry" || path === "/telemetry") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }

          // Codex search endpoint stub
          if (path === "/v1/alpha/search" || path === "/alpha/search") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ results: [] }));
            return;
          }
        }

        // Route not found
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Not found: ${path}` }));
      } catch (err) {
        console.error(`[codex-stella-web] Request error on ${path}:`, err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(
          JSON.stringify({
            error: {
              message: err instanceof Error ? err.message : String(err),
              type: "stella_bridge_error",
            },
          })
        );
      }
    });

    server.on("error", (err) => {
      reject(err);
    });

    server.listen(port, host, () => {
      console.log(`[codex-stella-web] Daemon listening on http://${host}:${port}`);
      console.log(`[codex-stella-web] OpenAI base URL: http://${host}:${port}/v1`);

      try {
        const pidPath = getDaemonPidPath();
        writeFileSync(
          pidPath,
          JSON.stringify({
            pid: process.pid,
            port,
            host,
            startedAt: SERVER_START_TIME,
          }),
          { encoding: "utf-8", mode: 0o600 }
        );
        try {
          chmodSync(pidPath, 0o600);
        } catch {
          // ignore
        }
      } catch {
        // Best effort
      }

      resolve(server);
    });

    server.on("close", () => {
      removePidFileIfOwned(process.pid);
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      try {
        let buffer = Buffer.concat(chunks);
        const encoding = (req.headers["content-encoding"] || "").toLowerCase();
        if (encoding === "gzip") {
          buffer = gunzipSync(buffer);
        } else if (encoding === "deflate") {
          buffer = inflateSync(buffer);
        } else if (encoding === "br") {
          buffer = brotliDecompressSync(buffer);
        }
        let str = buffer.toString("utf-8");
        // Strip UTF-8 BOM if present
        if (str.charCodeAt(0) === 0xfeff) {
          str = str.slice(1);
        }
        resolve(str);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
