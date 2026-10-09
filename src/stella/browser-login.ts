import { chromium } from "playwright-core";
import { findChromeExecutable, getBrowserProfileDir, STELLA_WEB_URL } from "../config.js";
import { saveSession } from "./auth.js";
import type { StellaSession } from "./types.js";

export interface LoginOptions {
  headless?: boolean;
  timeoutMs?: number;
}

export async function runInteractiveLogin(options: LoginOptions = {}): Promise<StellaSession> {
  const chromePath = findChromeExecutable();
  const profileDir = getBrowserProfileDir();
  const headless = options.headless ?? false;
  const timeoutMs = options.timeoutMs ?? 300_000; // 5 minutes

  console.log(`[codex-stella-web] Launching browser for Stella AI login...`);
  if (chromePath) {
    console.log(`[codex-stella-web] Using browser executable: ${chromePath}`);
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
    viewport: { width: 1200, height: 800 },
  });

  const page = context.pages()[0] || (await context.newPage());

  let capturedSession: StellaSession | null = null;

  // 1. Intercept network responses from Firebase Auth
  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (
        url.includes("identitytoolkit.googleapis.com") ||
        url.includes("securetoken.googleapis.com")
      ) {
        const json = await response.json();
        if (json.idToken && json.refreshToken) {
          const expiresInSec = parseInt(json.expiresIn, 10) || 3600;
          capturedSession = {
            idToken: json.idToken,
            refreshToken: json.refreshToken,
            expiresAt: Date.now() + expiresInSec * 1000,
            userEmail: json.email,
            userId: json.localId,
          };
        }
      }
    } catch {
      // Ignore network parse errors
    }
  });

  // 2. Intercept outgoing requests to Stella API with Bearer token
  page.on("request", (request) => {
    try {
      const url = request.url();
      if (url.includes("api.stella-ai.net")) {
        const auth = request.headers()["authorization"];
        if (auth && auth.startsWith("Bearer ") && !capturedSession) {
          const token = auth.substring(7);
          capturedSession = {
            idToken: token,
            refreshToken: "", // Will be filled from IndexedDB
            expiresAt: Date.now() + 3600 * 1000,
          };
        }
      }
    } catch {
      // Ignore
    }
  });

  console.log(`[codex-stella-web] Opening ${STELLA_WEB_URL}...`);
  console.log(`[codex-stella-web] Please log in to your Stella AI account in the opened window.`);
  await page.goto(`${STELLA_WEB_URL}/home`, { waitUntil: "domcontentloaded" });

  const startTime = Date.now();

  // Poll for IndexedDB tokens or captured session
  while (Date.now() - startTime < timeoutMs) {
    // Try reading IndexedDB firebaseLocalStorageDb
    try {
      const idbToken = await page.evaluate(async () => {
        return new Promise<any>((resolve) => {
          try {
            const g = globalThis as any;
            const idb = g.indexedDB || g.window?.indexedDB;
            if (!idb) return resolve(null);
            const req = idb.open("firebaseLocalStorageDb");
            req.onsuccess = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains("firebaseLocalStorage")) {
                return resolve(null);
              }
              const tx = db.transaction("firebaseLocalStorage", "readonly");
              const store = tx.objectStore("firebaseLocalStorage");
              const getAll = store.getAll();
              getAll.onsuccess = () => {
                const records = getAll.result || [];
                for (const r of records) {
                  const val = r?.value;
                  if (val?.stsTokenManager?.accessToken && val?.stsTokenManager?.refreshToken) {
                    return resolve({
                      idToken: val.stsTokenManager.accessToken,
                      refreshToken: val.stsTokenManager.refreshToken,
                      expiresAt: val.stsTokenManager.expirationTime,
                      userEmail: val.email,
                      userId: val.uid,
                    });
                  }
                }
                resolve(null);
              };
              getAll.onerror = () => resolve(null);
            };
            req.onerror = () => resolve(null);
          } catch {
            resolve(null);
          }
        });
      });

      if (idbToken && idbToken.idToken && idbToken.refreshToken) {
        capturedSession = idbToken;
        break;
      }
    } catch {
      // Page might be navigating
    }

    if (capturedSession && capturedSession.refreshToken) {
      break;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!capturedSession) {
    await context.close();
    throw new Error("Login timed out or no credentials captured. Please try again.");
  }

  saveSession(capturedSession);
  console.log(`[codex-stella-web] Successfully authenticated!`);
  if (capturedSession.userEmail) {
    console.log(`[codex-stella-web] Logged in as: ${capturedSession.userEmail}`);
  }

  await context.close();
  return capturedSession;
}
