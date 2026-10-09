import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StellaClient } from "../src/stella/client.js";

test("askOneTurn reads assistant text from contents[] snapshots", async () => {
  const dir = join(tmpdir(), `csw-stream-${Date.now()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "session.json"),
    JSON.stringify({
      idToken: "test-id",
      refreshToken: "test-refresh",
      expiresAt: Date.now() + 60 * 60_000,
    }),
    { encoding: "utf-8", mode: 0o600 }
  );
  const prevDir = process.env.CODEX_STELLA_WEB_DIR;
  process.env.CODEX_STELLA_WEB_DIR = dir;

  const ndjson = [
    JSON.stringify({
      role: "user",
      contents: [{ type: "text", text: "Reply with exactly: STELLA_OK" }],
    }),
    JSON.stringify({
      role: "assistant",
      contents: [{ type: "text", text: "STELLA_OK" }],
    }),
    JSON.stringify({
      role: "system",
      metadata: { is_finished: true },
      contents: [],
    }),
  ].join("\n");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.endsWith("/v1/chats")) {
      return new Response(JSON.stringify({ chat: { id: "chat-1" } }), { status: 200 });
    }
    if (url.includes("/messages")) {
      return new Response(ndjson, { status: 200 });
    }
    if (url.includes("/deletes")) {
      return new Response("{}", { status: 200 });
    }
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;

  try {
    const client = new StellaClient();
    const texts: string[] = [];
    const result = await client.askOneTurn("Reply with exactly: STELLA_OK", undefined, "none", (chunk) => {
      if (chunk.type === "text" && chunk.text) texts.push(chunk.text);
    });
    assert.equal(result, "STELLA_OK");
    assert.equal(texts.join(""), "STELLA_OK");
  } finally {
    globalThis.fetch = originalFetch;
    if (prevDir === undefined) delete process.env.CODEX_STELLA_WEB_DIR;
    else process.env.CODEX_STELLA_WEB_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
