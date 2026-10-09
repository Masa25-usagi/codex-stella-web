import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, renameSync } from "node:fs";
import { FIREBASE_CONFIG, getSessionPath } from "../config.js";
import type { StellaSession } from "./types.js";

export function loadSession(): StellaSession | null {
  const path = getSessionPath();
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.idToken === "string" && typeof parsed.refreshToken === "string") {
      return parsed as StellaSession;
    }
  } catch (err) {
    console.error("[codex-stella-web] Failed to parse session file:", err);
  }
  return null;
}

export function saveSession(session: StellaSession): void {
  const path = getSessionPath();
  const tmp = `${path}.tmp`;
  const data = JSON.stringify(session, null, 2);
  writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // ignore
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore
  }
}

export function clearSession(): void {
  const path = getSessionPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

let activeRefreshPromise: Promise<StellaSession> | null = null;

/**
 * Refresh Firebase ID token using Google SecureToken API with single-flight deduplication
 */
export async function refreshIdToken(refreshToken: string): Promise<StellaSession> {
  if (activeRefreshPromise) {
    return activeRefreshPromise;
  }

  activeRefreshPromise = (async () => {
    try {
      const url = `${FIREBASE_CONFIG.secureTokenUrl}?key=${FIREBASE_CONFIG.apiKey}`;

      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to refresh token (${res.status}): ${text}`);
      }

      const json = (await res.json()) as {
        access_token: string;
        expires_in: string; // e.g. "3600"
        refresh_token: string;
        id_token: string;
        user_id: string;
        project_id: string;
      };

      const expiresInSec = parseInt(json.expires_in, 10) || 3600;
      const newSession: StellaSession = {
        idToken: json.id_token,
        refreshToken: json.refresh_token,
        expiresAt: Date.now() + expiresInSec * 1000,
        userId: json.user_id,
      };

      // Preserve email if already known
      const current = loadSession();
      if (current?.userEmail) {
        newSession.userEmail = current.userEmail;
      }

      saveSession(newSession);
      return newSession;
    } finally {
      activeRefreshPromise = null;
    }
  })();

  return activeRefreshPromise;
}

/**
 * Get a valid, non-expired ID token. Refreshes if expired or close to expiring (within 5 minutes).
 */
export async function getValidIdToken(): Promise<string> {
  const session = loadSession();
  if (!session) {
    throw new Error(
      "No active session found. Please run `codex-stella-web login` to authenticate with Stella AI."
    );
  }

  const BUFFER_MS = 5 * 60 * 1000; // 5 minutes buffer
  if (Date.now() + BUFFER_MS < session.expiresAt) {
    return session.idToken;
  }

  // Token is expired or expiring soon, refresh it
  try {
    const refreshed = await refreshIdToken(session.refreshToken);
    return refreshed.idToken;
  } catch (err) {
    throw new Error(
      `Session expired and refresh failed. Please run \`codex-stella-web login\` again. (${err instanceof Error ? err.message : String(err)})`
    );
  }
}
