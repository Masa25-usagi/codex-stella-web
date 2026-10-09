import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridgeServer } from "../src/bridge/server.js";
import { StellaClient } from "../src/stella/client.js";

const dataDir = join(tmpdir(), `csw-server-${process.pid}`);
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

test("server health check and model catalog", async () => {
  const mockClient = new StellaClient();
  mockClient.fetchAiModels = async () => [
    { id: "stella-gpt-4o", name: "GPT-4o on Stella" },
  ];

  const server = await startBridgeServer({
    port: 17855,
    host: "127.0.0.1",
    client: mockClient,
  });

  try {
    // 1. Test /health
    const healthRes = await fetch("http://127.0.0.1:17855/health");
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as any;
    assert.equal(healthJson.status, "ok");
    assert.equal(healthJson.service, "codex-stella-web");

    // 2. Test /v1/models
    const modelsRes = await fetch("http://127.0.0.1:17855/v1/models");
    assert.equal(modelsRes.status, 200);
    const modelsJson = (await modelsRes.json()) as any;
    assert.equal(modelsJson.object, "list");
    assert(modelsJson.data.some((m: any) => m.id === "stella-gpt-4o"));
    assert(modelsJson.data.some((m: any) => m.id === "stella-auto"));
    assert(modelsJson.data.some((m: any) => m.id === "gpt-5.6-terra"));
    assert.equal(modelsJson.models, undefined);
  } finally {
    server.close();
  }
});

test("server handles chat completions non-streaming", async () => {
  const mockClient = new StellaClient();
  mockClient.askOneTurn = async () => "Mocked response from Stella AI";

  const server = await startBridgeServer({
    port: 17856,
    host: "127.0.0.1",
    client: mockClient,
  });

  try {
    const res = await fetch("http://127.0.0.1:17856/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "stella-auto",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      }),
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.object, "chat.completion");
    assert.equal(json.choices[0].message.content, "Mocked response from Stella AI");
    assert.equal(json.choices[0].finish_reason, "stop");
  } finally {
    server.close();
  }
});

test("server handles chat completions streaming", async () => {
  const mockClient = new StellaClient();
  mockClient.askOneTurn = async (content, modelId, searchType, onChunk) => {
    onChunk?.({ type: "text", text: "Hello " });
    onChunk?.({ type: "text", text: "World!" });
    return "Hello World!";
  };

  const server = await startBridgeServer({
    port: 17857,
    host: "127.0.0.1",
    client: mockClient,
  });

  try {
    const res = await fetch("http://127.0.0.1:17857/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "stella-auto",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      }),
    });

    assert.equal(res.status, 200);
    assert(res.headers.get("content-type")?.includes("text/event-stream"));

    const bodyText = await res.text();
    assert(bodyText.includes("data:"));
    assert(bodyText.includes("Hello "));
    assert(bodyText.includes("World!"));
    assert(bodyText.includes("[DONE]"));
  } finally {
    server.close();
  }
});

test("server handles Codex /v1/responses streaming", async () => {
  const mockClient = new StellaClient();
  mockClient.askOneTurn = async (content, modelId, searchType, onChunk) => {
    onChunk?.({ type: "thinking", thinking: "Pondering..." });
    onChunk?.({ type: "text", text: "Done thinking." });
    return "Done thinking.";
  };

  const server = await startBridgeServer({
    port: 17858,
    host: "127.0.0.1",
    client: mockClient,
  });

  try {
    const res = await fetch("http://127.0.0.1:17858/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "stella-deep-inference",
        input: [{ type: "message", role: "user", content: "Solve riddle" }],
      }),
    });

    assert.equal(res.status, 200);
    const bodyText = await res.text();
    assert(bodyText.includes("event: response.created"));
    assert(bodyText.includes("event: response.reasoning_text.delta"));
    assert(bodyText.includes("Pondering..."));
    assert(bodyText.includes("event: response.output_text.delta"));
    assert(bodyText.includes("Done thinking."));
    assert(bodyText.includes('"type":"response.output_text.delta"'));
    assert(bodyText.includes("event: response.completed"));
  } finally {
    server.close();
  }
});

test("server handles gzip compressed POST requests and empty bodies", async () => {
  const { gzipSync } = await import("node:zlib");
  const mockClient = new StellaClient();
  mockClient.askOneTurn = async () => "Gzip received ok";

  const server = await startBridgeServer({
    port: 17860,
    host: "127.0.0.1",
    client: mockClient,
  });

  try {
    // 1. Test gzip compressed chat completions
    const payload = JSON.stringify({
      model: "stella-auto",
      messages: [{ role: "user", content: "Hello from compressed request!" }],
      stream: false,
    });
    const compressed = gzipSync(Buffer.from(payload, "utf-8"));

    const gzipRes = await fetch("http://127.0.0.1:17860/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: compressed,
    });

    assert.equal(gzipRes.status, 200);
    const gzipJson = (await gzipRes.json()) as any;
    assert.equal(gzipJson.choices[0].message.content, "Gzip received ok");

    // 2. Test single model lookup GET /v1/models/:modelId
    const modelRes = await fetch("http://127.0.0.1:17860/v1/models/stella-auto");
    assert.equal(modelRes.status, 200);
    const modelJson = (await modelRes.json()) as any;
    assert.equal(modelJson.id, "stella-auto");

    // 3. Test embeddings endpoint POST /v1/embeddings
    const embRes = await fetch("http://127.0.0.1:17860/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "sample text" }),
    });
    assert.equal(embRes.status, 200);
    const embJson = (await embRes.json()) as any;
    assert.equal(embJson.object, "list");
    assert.equal(embJson.data[0].embedding.length, 1536);

    // 4. Test empty body POST /mcp does not return 400 Invalid JSON
    const mcpEmptyRes = await fetch("http://127.0.0.1:17860/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "   \r\n  ",
    });
    assert.notEqual(mcpEmptyRes.status, 400);
  } finally {
    server.close();
  }
});

test("GET /v1/models excludes image models and raw provider slugs", async () => {
  const mockClient = new StellaClient();
  mockClient.fetchAiModels = async () => [
    { id: "ulid-sonnet", name: "Claude Sonnet 5", model: "global.anthropic.claude-sonnet-5", model_type: "text" },
    { id: "ulid-mj", name: "Midjourney v7", model: "midjourney-v7", model_type: "image" },
  ];
  const server = await startBridgeServer({ port: 17861, host: "127.0.0.1", client: mockClient });
  try {
    const modelsJson = (await (await fetch("http://127.0.0.1:17861/v1/models")).json()) as any;
    assert(modelsJson.data.some((m: any) => m.id === "claude-sonnet-5"));
    assert(!modelsJson.data.some((m: any) => String(m.id).startsWith("global.")));
    assert(!modelsJson.data.some((m: any) => String(m.id).includes("midjourney")));
  } finally {
    server.close();
  }
});

test("invalid JSON POST returns OpenAI-shaped error", async () => {
  const server = await startBridgeServer({
    port: 17862,
    host: "127.0.0.1",
    client: new StellaClient(),
  });
  try {
    const res = await fetch("http://127.0.0.1:17862/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    assert.equal(res.status, 400);
    const json = (await res.json()) as any;
    assert.equal(json.error.type, "invalid_request_error");
    assert.match(json.error.message, /Invalid JSON/);
  } finally {
    server.close();
  }
});

test("responses SSE includes type in every data object and tool call items", async () => {
  const mockClient = new StellaClient();
  mockClient.askOneTurn = async (_c, _m, _s, onChunk) => {
    onChunk?.({
      type: "text",
      text: 'hello\n<tool_call>\n{"name":"read_file","arguments":{"path":"a.ts"}}\n</tool_call>',
    });
    return 'hello\n<tool_call>\n{"name":"read_file","arguments":{"path":"a.ts"}}\n</tool_call>';
  };
  const server = await startBridgeServer({ port: 17863, host: "127.0.0.1", client: mockClient });
  try {
    const res = await fetch("http://127.0.0.1:17863/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "stella-auto",
        instructions: "Use tools.",
        input: "read a.ts",
        tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    const dataLines = body
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    assert(dataLines.length > 0);
    for (const obj of dataLines) {
      assert.equal(typeof obj.type, "string");
    }
    assert(body.includes("event: response.output_text.delta"));
    assert(body.includes('"type":"function_call"'));
    assert(body.includes("read_file"));
    assert(body.includes("event: response.completed"));
    assert(!body.includes("<tool_call>"));
  } finally {
    server.close();
  }
});

test("refuses non-loopback host", async () => {
  await assert.rejects(
    () => startBridgeServer({ port: 17864, host: "0.0.0.0", client: new StellaClient() }),
    /loopback/i
  );
});
