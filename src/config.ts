import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_PORT = 17842;
export const DEFAULT_HOST = "127.0.0.1";

export const STELLA_WEB_URL = "https://stella-ai.net";
export const STELLA_API_BASE = "https://api.stella-ai.net";

export const FIREBASE_CONFIG = {
  apiKey: process.env.STELLA_FIREBASE_API_KEY || "",
  authDomain: process.env.STELLA_FIREBASE_AUTH_DOMAIN || "",
  projectId: process.env.STELLA_FIREBASE_PROJECT_ID || "",
  storageBucket: process.env.STELLA_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: process.env.STELLA_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: process.env.STELLA_FIREBASE_APP_ID || "",
  secureTokenUrl: process.env.STELLA_FIREBASE_SECURE_TOKEN_URL || "https://securetoken.googleapis.com/v1/token",
};

export function getDataDir(): string {
  const dir = process.env.CODEX_STELLA_WEB_DIR || join(homedir(), ".codex-stella-web");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getSessionPath(): string {
  return join(getDataDir(), "session.json");
}

export function getBrowserProfileDir(): string {
  const dir = join(getDataDir(), "browser-profile");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getCodexHome(): string {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  const configPath = process.env.CODEX_CONFIG_PATH;
  if (configPath) return dirname(configPath);
  return join(homedir(), ".codex");
}

export function getCodexConfigPath(): string {
  return process.env.CODEX_CONFIG_PATH || join(getCodexHome(), "config.toml");
}

export function getCodexProfilePath(profileName: string): string {
  return join(getCodexHome(), `${profileName}.config.toml`);
}

export function getCodexJournalPath(): string {
  return join(getDataDir(), "codex-journal.json");
}

export function getDaemonPidPath(): string {
  return join(getDataDir(), "daemon.pid");
}

export function getCodexModelsCatalogPath(): string {
  return join(getDataDir(), "codex-models.json");
}

export function findChromeExecutable(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];

  for (const c of candidates) {
    if (c && existsSync(c)) {
      return c;
    }
  }

  // Check Playwright installed cache
  const playwrightDir = join(homedir(), "Library", "Caches", "ms-playwright");
  if (existsSync(playwrightDir)) {
    try {
      const entries = readdirSync(playwrightDir) as string[];
      for (const entry of entries) {
        if (entry.startsWith("chromium-")) {
          const macPath = join(
            playwrightDir,
            entry,
            "chrome-mac",
            "Chromium.app",
            "Contents",
            "MacOS",
            "Chromium"
          );
          if (existsSync(macPath)) return macPath;
          const linuxPath = join(playwrightDir, entry, "chrome-linux", "chrome");
          if (existsSync(linuxPath)) return linuxPath;
        }
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}
