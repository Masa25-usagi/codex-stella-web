import { DEFAULT_HOST, DEFAULT_PORT } from "./config.js";
import { clearSession, loadSession, saveSession } from "./stella/auth.js";
import { runInteractiveLogin } from "./stella/browser-login.js";
import { StellaClient } from "./stella/client.js";
import { startBridgeServer } from "./bridge/server.js";
import { runStdioMcp } from "./bridge/mcp-server.js";
import { existsSync, readFileSync } from "node:fs";
import { getCodexConfigPath } from "./config.js";
import {
  describeCodexIntegration,
  findDuplicateTopLevelKeys,
  installCodexIntegration,
  uninstallCodexIntegration,
} from "./codex/integration.js";
import { runDoctor } from "./doctor.js";
import { assertLoopbackHost, classifyDaemon, stopRunningDaemon } from "./daemon.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  switch (command) {
    case "login": {
      const headless = args.includes("--headless");
      try {
        console.log("=== Stella AI Authentication ===");
        await runInteractiveLogin({ headless });
        console.log("Authentication successful. You can now start the daemon with `codex-stella-web serve`.");
      } catch (err) {
        console.error("Login failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
      break;
    }

    case "token": {
      const idToken = args[1];
      const refreshToken = args[2];
      const email = args[3];
      if (!idToken || !refreshToken) {
        console.error("Usage: codex-stella-web token <idToken> <refreshToken> [email]");
        process.exit(1);
      }
      saveSession({
        idToken,
        refreshToken,
        expiresAt: Date.now() + 3600 * 1000,
        userEmail: email,
      });
      console.log("Session saved successfully.");
      break;
    }

    case "logout": {
      clearSession();
      console.log("Logged out. Session cleared.");
      break;
    }

    case "serve":
    case "start": {
      let port = DEFAULT_PORT;
      let host = DEFAULT_HOST;

      const portIdx = args.indexOf("--port");
      if (portIdx !== -1 && args[portIdx + 1]) {
        port = parseInt(args[portIdx + 1], 10);
      }

      const hostIdx = args.indexOf("--host");
      if (hostIdx !== -1 && args[hostIdx + 1]) {
        host = args[hostIdx + 1];
      }

      try {
        assertLoopbackHost(host);
        await startBridgeServer({ port, host });
        // Keep process running
      } catch (err) {
        console.error("Failed to start server:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
      break;
    }

    case "test": {
      const prompt = args.slice(1).join(" ") || "Hello! Tell me in 1 sentence what you can do.";
      console.log(`[codex-stella-web] Testing Stella AI with prompt: "${prompt}"\n`);
      const client = new StellaClient();
      try {
        process.stdout.write("Stella: ");
        await client.askOneTurn(
          prompt,
          undefined,
          "none",
          (chunk) => {
            if (chunk.type === "thinking" && chunk.thinking) {
              process.stdout.write(`[Thinking: ${chunk.thinking}]`);
            } else if (chunk.type === "text" && chunk.text) {
              process.stdout.write(chunk.text);
            }
          }
        );
        console.log("\n\n[Test completed successfully]");
      } catch (err) {
        console.error("\nTest failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
      break;
    }

    case "setup": {
      const res = installCodexIntegration();
      if (res.success) {
        console.log(`✅ ${res.message}`);
      } else {
        console.error(`❌ ${res.message}`);
        process.exit(1);
      }
      break;
    }

    case "uninstall": {
      const res = uninstallCodexIntegration();
      if (res.success) {
        console.log(`✅ ${res.message}`);
      } else {
        console.error(`❌ ${res.message}`);
        process.exit(1);
      }
      break;
    }

    case "stop": {
      const res = stopRunningDaemon();
      console.log(res.stopped ? `✅ ${res.message}` : `ℹ️ ${res.message}`);
      if (!res.stopped && res.message.includes("did not exit")) process.exit(1);
      break;
    }

    case "status": {
      console.log("=== codex-stella-web Status ===");
      const session = loadSession();
      if (session) {
        console.log(`Auth: Logged in (${session.userEmail || "User ID: " + session.userId})`);
      } else {
        console.log("Auth: Not logged in (run `codex-stella-web login`)");
      }

      console.log(`Codex integration: ${describeCodexIntegration()}`);
      const configPath = getCodexConfigPath();
      if (existsSync(configPath)) {
        const dups = findDuplicateTopLevelKeys(readFileSync(configPath, "utf-8"));
        if (dups.length) {
          console.log(`❌ Codex config has duplicate top-level keys: ${dups.join(", ")}`);
        }
      }

      const daemon = await classifyDaemon();
      console.log(`Daemon: ${daemon.state.toUpperCase()} — ${daemon.message}`);
      if (daemon.state === "running") {
        console.log(`Endpoint: http://127.0.0.1:17842/v1`);
        console.log(`MCP URL: http://127.0.0.1:17842/mcp`);
      }
      break;
    }

    case "doctor": {
      await runDoctor();
      break;
    }

    case "mcp": {
      const client = new StellaClient();
      await runStdioMcp(client);
      break;
    }

    default: {
      console.log(`
codex-stella-web - Bridge OpenAI Codex CLI, ChatGPT App, and OpenAI clients to Stella AI

Usage:
  codex-stella-web <command> [options]

Commands:
  login                 Open browser to log into Stella AI and save session
  token <id> <refresh>  Set session tokens directly (for headless environments)
  logout                Clear saved session
  serve                 Start local OpenAI/Responses/MCP bridge daemon (default port: ${DEFAULT_PORT})
  stop                  Stop running bridge daemon
  mcp                   Run stdio MCP server for ChatGPT app, Claude Desktop, Cursor
  test [prompt]         Test query to Stella AI with streaming output
  setup                 Register Stella as an optional Codex provider (keeps official GPT quota)
  uninstall             Remove Stella provider/profile and stop daemon
  status                Show current login, daemon, and Codex configuration status
  doctor                Run complete health check and diagnostic

Options:
  --port <port>         Specify port for bridge daemon (default: ${DEFAULT_PORT})
  --host <host>         Specify host for bridge daemon (default: ${DEFAULT_HOST})
  --headless            Run browser in headless mode during login
`);
      break;
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
