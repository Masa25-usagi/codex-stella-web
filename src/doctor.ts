import { existsSync, readFileSync } from "node:fs";
import { findChromeExecutable, getCodexConfigPath, getDataDir } from "./config.js";
import { loadSession, refreshIdToken } from "./stella/auth.js";
import { StellaClient } from "./stella/client.js";
import { describeCodexIntegration, findDuplicateTopLevelKeys, isIntegrationActive } from "./codex/integration.js";
import { classifyDaemon } from "./daemon.js";

export async function runDoctor(): Promise<boolean> {
  console.log("=== codex-stella-web Doctor Diagnostic ===\n");
  let allHealthy = true;

  // 1. Node runtime
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  if (major >= 18) {
    console.log(`✅ Node.js: ${nodeVersion} (compatible)`);
  } else {
    console.log(`❌ Node.js: ${nodeVersion} (requires v18+)`);
    allHealthy = false;
  }

  // 2. Chrome / Browser
  const chrome = findChromeExecutable();
  if (chrome) {
    console.log(`✅ Browser executable: ${chrome}`);
  } else {
    console.log(`⚠️ Browser executable: Not found. (Headless browser login may fail if needed)`);
  }

  // 3. Storage directory
  const dataDir = getDataDir();
  console.log(`✅ Data directory: ${dataDir}`);

  // 4. Stella AI Authentication
  const session = loadSession();
  if (session) {
    console.log(`✅ Stella AI Session found`);
    if (session.userEmail) {
      console.log(`   Account: ${session.userEmail}`);
    }
    const expiresInMin = Math.round((session.expiresAt - Date.now()) / 60000);
    console.log(`   ID Token: present (valid for ~${expiresInMin} min)`);

    // Test token refresh
    try {
      await refreshIdToken(session.refreshToken);
      console.log(`✅ Token Refresh: Google SecureToken API verified`);
    } catch (err) {
      console.log(`⚠️ Token Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      allHealthy = false;
    }

    // 5. Test Stella AI API
    try {
      const client = new StellaClient();
      const models = await client.fetchAiModels();
      console.log(`✅ Stella AI API: Connected (${models.length} models available)`);
      for (const m of models.slice(0, 5)) {
        console.log(`   - ${m.name || m.id}`);
      }
      if (models.length > 5) {
        console.log(`   ... and ${models.length - 5} more`);
      }
    } catch (err) {
      console.log(`❌ Stella AI API connection error: ${err instanceof Error ? err.message : String(err)}`);
      allHealthy = false;
    }
  } else {
    console.log(`❌ Stella AI Session: Not authenticated`);
    console.log(`   Run \`codex-stella-web login\` to log in.`);
    allHealthy = false;
  }

  const codexPath = getCodexConfigPath();
  if (existsSync(codexPath)) {
    const dups = findDuplicateTopLevelKeys(readFileSync(codexPath, "utf-8"));
    if (dups.length) {
      console.log(`❌ Codex config: duplicate top-level keys (${dups.join(", ")}) in ${codexPath}`);
      allHealthy = false;
    }
  }
  const active = isIntegrationActive();
  if (active) {
    console.log(`✅ Codex Integration: ${describeCodexIntegration()}`);
  } else {
    console.log(`ℹ️ Codex Integration: Inactive (run \`codex-stella-web setup\` to register Stella as an optional provider)`);
  }

  const daemon = await classifyDaemon();
  if (daemon.state === "running") {
    console.log(`✅ Bridge Daemon: ${daemon.message}`);
  } else if (daemon.state === "stopped") {
    console.log(`ℹ️ Bridge Daemon: ${daemon.message}`);
  } else {
    console.log(`❌ Bridge Daemon: ${daemon.message}`);
    allHealthy = false;
  }

  console.log("\n==========================================");
  if (allHealthy) {
    console.log("Status: ALL SYSTEMS HEALTHY");
  } else {
    console.log("Status: ATTENTION REQUIRED (see items marked with ❌)");
  }

  return allHealthy;
}
