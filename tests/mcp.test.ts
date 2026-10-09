import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMcpRpc, MCP_TOOLS } from "../src/bridge/mcp-server.js";
import { startBridgeServer } from "../src/bridge/server.js";
import { StellaClient } from "../src/stella/client.js";

const dataDir = join(tmpdir(), `csw-mcp-${process.pid}`);
let prevDataDir: string | undefined;
before(() => {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  prevDataDir = process.env.CODEX_STELLA_WEB_DIR;
  process.env.CODEX_STELLA_WEB_DIR = dataDir;
});
after(() => {
  if (prevDataDir === undefined) delete process.env.CODEX_STELLA_WEB_DIR;
  else process.env.CODEX_STELLA_WEB_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

test("MCP handleMcpRpc initialize and tools/list", async () => {
  const mockClient = new StellaClient();

  // 1. Initialize
  const initRes = await handleMcpRpc(mockClient, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ChatGPT.app", version: "1.0.0" },
    },
  });

  assert.equal(initRes.jsonrpc, "2.0");
  assert.equal(initRes.id, 1);
  assert.equal(initRes.result.serverInfo.name, "codex-stella-web");
  assert.equal(initRes.result.protocolVersion, "2024-11-05");

  // 2. Tools list
  const listRes = await handleMcpRpc(mockClient, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });

  assert.equal(listRes.id, 2);
  assert(Array.isArray(listRes.result.tools));
  const toolNames = listRes.result.tools.map((t: any) => t.name);
  assert(toolNames.includes("ask_stella"));
  assert(toolNames.includes("stella_deep_research"));
  assert(toolNames.includes("list_stella_models"));
});

test("MCP handleMcpRpc tools/call ask_stella", async () => {
  const mockClient = new StellaClient();
  mockClient.askOneTurn = async (prompt, modelId) => {
    return `Stella responded to: ${prompt}`;
  };

  const callRes = await handleMcpRpc(mockClient, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "ask_stella",
      arguments: {
        prompt: "Write a quick hello",
        model: "stella-gpt-4o",
      },
    },
  });

  assert.equal(callRes.id, 3);
  assert.equal(callRes.result.content[0].type, "text");
  assert.equal(callRes.result.content[0].text, "Stella responded to: Write a quick hello");
  assert.equal(callRes.isError, undefined);
});

test("MCP tools/call puts isError inside result", async () => {
  const mockClient = new StellaClient();
  mockClient.askOneTurn = async () => {
    throw new Error("upstream failed");
  };
  const callRes = await handleMcpRpc(mockClient, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "ask_stella", arguments: { prompt: "x" } },
  });
  assert.equal(callRes.id, 4);
  assert.equal(callRes.isError, undefined);
  assert.equal(callRes.result.isError, true);
  assert.match(callRes.result.content[0].text, /upstream failed/);
});

test("HTTP /mcp and /sse endpoints for ChatGPT.app", async () => {
  const mockClient = new StellaClient();
  const server = await startBridgeServer({
    port: 17859,
    host: "127.0.0.1",
    client: mockClient,
  });

  try {
    // 1. GET /mcp status
    const getRes = await fetch("http://127.0.0.1:17859/mcp");
    assert.equal(getRes.status, 200);
    const getJson = (await getRes.json()) as any;
    assert.equal(getJson.protocol, "mcp");
    assert(getJson.tools.includes("ask_stella"));

    // 2. GET /sse handshake
    const sseRes = await fetch("http://127.0.0.1:17859/sse", {
      headers: { Accept: "text/event-stream" },
    });
    assert.equal(sseRes.status, 200);
    assert(sseRes.headers.get("content-type")?.includes("text/event-stream"));

    // 3. POST /mcp JSON-RPC
    const postRes = await fetch("http://127.0.0.1:17859/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/list",
      }),
    });
    assert.equal(postRes.status, 200);
    const postJson = (await postRes.json()) as any;
    assert.equal(postJson.id, 10);
    assert(postJson.result.tools.some((t: any) => t.name === "ask_stella"));
  } finally {
    server.close();
  }
});
