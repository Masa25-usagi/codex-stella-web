import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  describeCodexIntegration,
  findDuplicateTopLevelKeys,
  installCodexIntegration,
  isIntegrationActive,
  isStellaDefaultProvider,
  uninstallCodexIntegration,
} from "../src/codex/integration.js";
import { getCodexProfilePath } from "../src/config.js";
import { stopRunningDaemon } from "../src/daemon.js";

function withTempEnv(fn: (dir: string, configPath: string) => void) {
  const dir = join(tmpdir(), `codex-stella-it-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prevConfig = process.env.CODEX_CONFIG_PATH;
  const prevDir = process.env.CODEX_STELLA_WEB_DIR;
  process.env.CODEX_CONFIG_PATH = join(dir, "config.toml");
  process.env.CODEX_STELLA_WEB_DIR = dir;
  try {
    fn(dir, process.env.CODEX_CONFIG_PATH);
  } finally {
    if (prevConfig === undefined) delete process.env.CODEX_CONFIG_PATH;
    else process.env.CODEX_CONFIG_PATH = prevConfig;
    if (prevDir === undefined) delete process.env.CODEX_STELLA_WEB_DIR;
    else process.env.CODEX_STELLA_WEB_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Codex integration install configures the Stella model picker", () => {
  withTempEnv((_dir, configPath) => {
    const originalToml = `model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n\n[projects]\ntrust_level = "trusted"\n`;
    writeFileSync(configPath, originalToml, "utf-8");

    const installRes = installCodexIntegration(17842, "127.0.0.1");
    assert.equal(installRes.success, true);

    const updated = readFileSync(configPath, "utf-8");
    assert.equal(findDuplicateTopLevelKeys(updated).length, 0);
    assert.match(updated, /# \[codex-stella-web original\] model = "gpt-6-astra"/);
    assert.match(updated, /^openai_base_url = .+ # Managed by codex-stella-web$/m);
    assert.match(updated, /^model = "stella-auto" # Managed by codex-stella-web$/m);
    assert.match(updated, /^model_catalog_json = .+ # Managed by codex-stella-web$/m);
    assert(updated.includes("[model_providers.stella]"));
    assert(updated.includes('wire_api = "responses"'));
    assert(updated.includes("[mcp_servers.stella]"));
    assert(isIntegrationActive());
    assert.equal(isStellaDefaultProvider(), false);
    assert.match(describeCodexIntegration(), /optional/i);

    const profilePath = getCodexProfilePath("stella");
    assert.equal(existsSync(profilePath), true);
    const profile = readFileSync(profilePath, "utf-8");
    assert.match(profile, /^model = "stella-auto"$/m);
    assert.match(profile, /^model_provider = "stella"$/m);

    const uninstallRes = uninstallCodexIntegration();
    assert.equal(uninstallRes.success, true);
    const restored = readFileSync(configPath, "utf-8");
    assert.match(restored, /^model = "gpt-6-astra"$/m);
    assert.doesNotMatch(restored, /Managed by codex-stella-web/);
    assert.doesNotMatch(restored, /codex-stella-web original/);
    assert.match(restored, /\[projects\]/);
    assert.equal(isIntegrationActive(), false);
    assert.equal(existsSync(profilePath), false);
  });
});

test("setup migrates a hijacked default provider back to official GPT quota", () => {
  withTempEnv((_dir, configPath) => {
    writeFileSync(
      configPath,
      [
        `# [codex-stella-web original] model = "gpt-6-astra"`,
        `model = "stella-auto" # Managed by codex-stella-web`,
        `model_provider = "stella" # Managed by codex-stella-web`,
        `model_reasoning_effort = "xhigh"`,
        ``,
        `[projects]`,
        `trust_level = "trusted"`,
        ``,
        `# BEGIN Managed by codex-stella-web`,
        `[model_providers.stella]`,
        `name = "Stella AI"`,
        `base_url = "http://127.0.0.1:17842/v1"`,
        `wire_api = "responses"`,
        `requires_openai_auth = false`,
        `# END Managed by codex-stella-web`,
        ``,
      ].join("\n"),
      "utf-8"
    );

    assert.equal(installCodexIntegration(17842, "127.0.0.1").success, true);
    const updated = readFileSync(configPath, "utf-8");
    assert.match(updated, /# \[codex-stella-web original\] model = "gpt-6-astra"/);
    assert.match(updated, /^model = "stella-auto" # Managed by codex-stella-web$/m);
    assert.equal([...updated.matchAll(/\[model_providers\.stella\]/g)].length, 1);
    assert.equal(isStellaDefaultProvider(), false);
    assert.equal(isIntegrationActive(), true);
  });
});

test("repeated setup is idempotent and does not duplicate keys", () => {
  withTempEnv((_dir, configPath) => {
    writeFileSync(
      configPath,
      `model = "gpt-6-astra"\n\n[projects."/tmp"]\ntrust_level = "trusted"\n`,
      "utf-8"
    );
    assert.equal(installCodexIntegration().success, true);
    const first = readFileSync(configPath, "utf-8");
    assert.equal(installCodexIntegration().success, true);
    const second = readFileSync(configPath, "utf-8");
    assert.equal(first, second);
    assert.equal(findDuplicateTopLevelKeys(second).length, 0);
    assert.equal([...second.matchAll(/\[model_providers\.stella\]/g)].length, 1);
  });
});

test("fallback uninstall keeps later unrelated edits when journal is missing", () => {
  withTempEnv((dir, configPath) => {
    writeFileSync(configPath, `model = "gpt-6-astra"\n\n[features]\njs_repl = false\n`, "utf-8");
    assert.equal(installCodexIntegration().success, true);
    let updated = readFileSync(configPath, "utf-8");
    updated += `\n[projects."/later-edit"]\ntrust_level = "trusted"\n`;
    writeFileSync(configPath, updated, "utf-8");
    const journal = join(dir, "codex-journal.json");
    if (existsSync(journal)) rmSync(journal, { force: true });

    const uninstallRes = uninstallCodexIntegration();
    assert.equal(uninstallRes.success, true);
    const restored = readFileSync(configPath, "utf-8");
    assert.match(restored, /model = "gpt-6-astra"/);
    assert.match(restored, /\[projects\."\/later-edit"\]/);
    assert.match(restored, /\[features\]/);
    assert.doesNotMatch(restored, /Managed by codex-stella-web/);
    assert.doesNotMatch(restored, /\[model_providers\.stella\]/);
  });
});

test("uninstall removes managed profile even when config.toml is missing", () => {
  withTempEnv((_dir, configPath) => {
    writeFileSync(configPath, `model = "gpt-6-astra"\n`, "utf-8");
    assert.equal(installCodexIntegration().success, true);
    const profilePath = getCodexProfilePath("stella");
    assert.equal(existsSync(profilePath), true);
    rmSync(configPath, { force: true });
    const uninstallRes = uninstallCodexIntegration();
    assert.equal(uninstallRes.success, false);
    assert.equal(existsSync(profilePath), false);
    assert.match(uninstallRes.message, /Removed managed Stella profile/i);
  });
});

test("setup backs up an unmanaged stella profile before replacing it", () => {
  withTempEnv((_dir, configPath) => {
    writeFileSync(configPath, `model = "gpt-6-astra"\n`, "utf-8");
    const profilePath = getCodexProfilePath("stella");
    writeFileSync(profilePath, `model = "user-owned"\nmodel_provider = "openai"\n`, "utf-8");
    assert.equal(installCodexIntegration().success, true);
    const backup = `${profilePath}.pre-codex-stella-web.bak`;
    assert.equal(existsSync(backup), true);
    assert.match(readFileSync(backup, "utf-8"), /user-owned/);
    assert.match(readFileSync(profilePath, "utf-8"), /^model = "stella-auto"$/m);
  });
});

test("malformed pid file is reported and does not kill unrelated PIDs", () => {
  withTempEnv((dir) => {
    const pidPath = join(dir, "daemon.pid");
    writeFileSync(pidPath, "not-json", "utf-8");
    const res = stopRunningDaemon();
    assert.equal(res.stopped, false);
    assert.match(res.message, /malformed/i);
    assert.equal(existsSync(pidPath), false);
  });
});

test("stale pid file for a dead PID is cleared without claiming a stop", () => {
  withTempEnv((dir) => {
    const pidPath = join(dir, "daemon.pid");
    writeFileSync(pidPath, JSON.stringify({ pid: 999999, port: 17842, host: "127.0.0.1" }), {
      encoding: "utf-8",
      mode: 0o600,
    });
    chmodSync(pidPath, 0o600);
    const res = stopRunningDaemon();
    assert.equal(res.stopped, false);
    assert.equal(res.pid, 999999);
    assert.match(res.message, /dead PID|stale/i);
    assert.equal(existsSync(pidPath), false);
  });
});
