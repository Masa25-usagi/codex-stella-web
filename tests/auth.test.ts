import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveSession, loadSession, clearSession } from "../src/stella/auth.js";

test("saveSession writes atomically with mode 0600", () => {
  const dir = join(tmpdir(), `codex-stella-auth-${Date.now()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prev = process.env.CODEX_STELLA_WEB_DIR;
  process.env.CODEX_STELLA_WEB_DIR = dir;
  try {
    saveSession({
      idToken: "id-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
      userEmail: "user@example.com",
    });
    const sessionPath = join(dir, "session.json");
    assert.equal(existsSync(sessionPath), true);
    assert.equal(existsSync(`${sessionPath}.tmp`), false);
    const mode = statSync(sessionPath).mode & 0o777;
    assert.equal(mode, 0o600);
    const loaded = loadSession();
    assert.equal(loaded?.userEmail, "user@example.com");
    assert.equal(loaded?.idToken, "id-token");
    clearSession();
    assert.equal(loadSession(), null);
  } finally {
    if (prev === undefined) delete process.env.CODEX_STELLA_WEB_DIR;
    else process.env.CODEX_STELLA_WEB_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
