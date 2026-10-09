import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, renameSync } from "node:fs";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  getCodexConfigPath,
  getCodexJournalPath,
  getCodexProfilePath,
} from "../config.js";
import { stopRunningDaemon } from "../daemon.js";
import { writeCodexModelsCatalog } from "../stella/models.js";

const MANAGED_TAG = "# Managed by codex-stella-web";
const MANAGED_BLOCK_START = "# BEGIN Managed by codex-stella-web";
const MANAGED_BLOCK_END = "# END Managed by codex-stella-web";
const ORIGINAL_PREFIX = "# [codex-stella-web original] ";
const STELLA_PROFILE_NAME = "stella";

/** Top-level keys managed by this integration. */
const MANAGED_TOP_KEYS = new Set(["openai_base_url", "model_catalog_json", "model"]);

export interface CodexJournal {
  originalContent: string;
  installedAt: string;
  configPath: string;
  captured?: {
    model?: string;
    openai_base_url?: string;
    model_provider?: string;
    model_catalog_json?: string;
  };
}

export function isCodexInstalled(): boolean {
  return existsSync(getCodexConfigPath());
}

export function isIntegrationActive(): boolean {
  const configPath = getCodexConfigPath();
  if (!existsSync(configPath)) return false;
  const content = readFileSync(configPath, "utf-8");
  return (
    content.includes(MANAGED_BLOCK_START) &&
    content.includes("[model_providers.stella]") &&
    content.includes(`base_url = "http://`)
  );
}

export function isStellaDefaultProvider(): boolean {
  const configPath = getCodexConfigPath();
  if (!existsSync(configPath)) return false;
  const value = captureTopLevel(readFileSync(configPath, "utf-8"), "model_provider");
  if (!value) return false;
  const unquoted = value.replace(/^"|"$/g, "");
  return unquoted === "stella";
}

export function describeCodexIntegration(): string {
  if (!isIntegrationActive()) return "Inactive";
  if (isStellaDefaultProvider()) {
    return "Active as default (official Codex GPT quota is routed through Stella)";
  }
  return "Stella provider registered (optional). Official Codex GPT quota remains default. Switch with: codex --profile stella";
}

function writeStellaProfile(): string {
  const profilePath = getCodexProfilePath(STELLA_PROFILE_NAME);
  if (existsSync(profilePath)) {
    const existing = readFileSync(profilePath, "utf-8");
    if (!existing.includes(MANAGED_BLOCK_START) && !existing.includes(MANAGED_TAG)) {
      atomicWriteFile(`${profilePath}.pre-codex-stella-web.bak`, existing, 0o600);
    }
  }
  const profileContent = [
    MANAGED_BLOCK_START,
    `model = "stella-auto"`,
    `model_provider = "stella"`,
    MANAGED_BLOCK_END,
    "",
  ].join("\n");
  atomicWriteFile(profilePath, profileContent, 0o600);
  return profilePath;
}

function removeStellaProfile(): boolean {
  const profilePath = getCodexProfilePath(STELLA_PROFILE_NAME);
  if (!existsSync(profilePath)) return false;
  try {
    const content = readFileSync(profilePath, "utf-8");
    if (!content.includes(MANAGED_BLOCK_START) && !content.includes(MANAGED_TAG)) {
      return false;
    }
    unlinkSync(profilePath);
    return true;
  } catch {
    return false;
  }
}

function atomicWriteFile(path: string, content: string, mode = 0o600): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf-8", mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // ignore
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    // ignore
  }
}

function isTableHeader(line: string): boolean {
  const s = line.trim();
  return s.startsWith("[") && s.endsWith("]");
}

function parseAssignment(line: string): { key: string; value: string } | null {
  const s = line.trim();
  if (!s || s.startsWith("#")) return null;
  const eq = s.indexOf("=");
  if (eq === -1) return null;
  return { key: s.slice(0, eq).trim(), value: s.slice(eq + 1).trim() };
}

export function findDuplicateTopLevelKeys(content: string): string[] {
  const seen = new Map<string, number>();
  for (const line of content.split("\n")) {
    if (isTableHeader(line)) break;
    const parsed = parseAssignment(line);
    if (!parsed) continue;
    seen.set(parsed.key, (seen.get(parsed.key) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

function splitTopAndRest(content: string): { top: string[]; rest: string[] } {
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => isTableHeader(l));
  if (idx === -1) return { top: lines, rest: [] };
  return { top: lines.slice(0, idx), rest: lines.slice(idx) };
}

function captureTopLevel(content: string, key: string): string | undefined {
  for (const line of content.split("\n")) {
    if (isTableHeader(line)) break;
    const parsed = parseAssignment(line);
    if (parsed?.key === key) return parsed.value;
  }
  return undefined;
}

export function stripManagedSections(content: string): string {
  const blockRegex = new RegExp(
    `\\n?${escapeRegExp(MANAGED_BLOCK_START)}[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}\\n?`,
    "g"
  );
  let cleaned = content.replace(blockRegex, "\n");
  cleaned = cleaned
    .split("\n")
    .filter((l) => !l.includes(MANAGED_TAG))
    .join("\n");
  return cleaned.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n*$/, "\n");
}

function restoreOriginalComments(content: string): string {
  const lines = content.split("\n");
  const restored: string[] = [];
  const restoredKeys = new Set<string>();
  for (const line of lines) {
    if (line.startsWith(ORIGINAL_PREFIX)) {
      const original = line.slice(ORIGINAL_PREFIX.length);
      const parsed = parseAssignment(original);
      if (parsed && !restoredKeys.has(parsed.key)) {
        restored.push(original);
        restoredKeys.add(parsed.key);
      }
      continue;
    }
    restored.push(line);
  }
  return restored.join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildManagedTables(port: number, host: string, includeMcp = true): string {
  const targetUrl = `http://${host}:${port}/v1`;
  const mcpUrl = `http://${host}:${port}/mcp`;
  const lines = [
    MANAGED_BLOCK_START,
    `[model_providers.stella]`,
    `name = "Stella AI"`,
    `base_url = "${targetUrl}"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
  ];
  if (includeMcp) {
    lines.push(``, `[mcp_servers.stella]`, `url = "${mcpUrl}"`);
  }
  lines.push(MANAGED_BLOCK_END);
  return lines.join("\n");
}

export function installCodexIntegration(
  port = DEFAULT_PORT,
  host = DEFAULT_HOST
): { success: boolean; message: string } {
  const configPath = getCodexConfigPath();
  const journalPath = getCodexJournalPath();

  if (!existsSync(configPath)) {
    return {
      success: false,
      message: `Codex config file not found at ${configPath}. Please run Codex once to create it.`,
    };
  }

  const originalContent = readFileSync(configPath, "utf-8");
  const stripped = restoreOriginalComments(stripManagedSections(originalContent));
  const captured = {
    model: captureTopLevel(stripped, "model"),
    openai_base_url: captureTopLevel(stripped, "openai_base_url"),
    model_provider: captureTopLevel(stripped, "model_provider"),
    model_catalog_json: captureTopLevel(stripped, "model_catalog_json"),
  };

  const journal: CodexJournal = {
    originalContent,
    installedAt: new Date().toISOString(),
    configPath,
    captured,
  };
  if (existsSync(journalPath)) {
    try {
      const prev = JSON.parse(readFileSync(journalPath, "utf-8")) as CodexJournal;
      if (prev.configPath === configPath && prev.originalContent) {
        journal.originalContent = prev.originalContent;
        if (prev.installedAt) journal.installedAt = prev.installedAt;
        if (prev.captured?.model && !journal.captured?.model) {
          journal.captured = { ...journal.captured, model: prev.captured.model };
        }
      }
    } catch {
      // ignore malformed previous journal
    }
  }
  atomicWriteFile(journalPath, JSON.stringify(journal, null, 2), 0o600);
  const targetUrl = `http://${host}:${port}/v1`;
  const modelsCatalogPath = writeCodexModelsCatalog();
  const { top, rest } = splitTopAndRest(stripped);

  const preservedTop: string[] = [];
  const originals: string[] = [];
  for (const line of top) {
    if (line.startsWith(ORIGINAL_PREFIX)) continue;
    const parsed = parseAssignment(line);
    if (parsed && MANAGED_TOP_KEYS.has(parsed.key)) {
      originals.push(`${ORIGINAL_PREFIX}${parsed.key} = ${parsed.value}`);
      continue;
    }
    preservedTop.push(line);
  }

  const managedTop = [
    `openai_base_url = "${targetUrl}" ${MANAGED_TAG}`,
    `model = "stella-auto" ${MANAGED_TAG}`,
    `model_catalog_json = "${modelsCatalogPath}" ${MANAGED_TAG}`,
  ];

  while (preservedTop.length && preservedTop[0] === "") preservedTop.shift();
  const topJoined = [...originals, ...managedTop, ...preservedTop].join("\n").replace(/\n{3,}/g, "\n\n");
  const restJoined = rest.join("\n").replace(/^\n+/, "").replace(/\n*$/, "\n");
  const tables = buildManagedTables(port, host, true);
  const newContent = `${topJoined.replace(/\n*$/, "\n")}\n${restJoined.replace(/\n*$/, "\n")}\n${tables}\n`;

  const dups = findDuplicateTopLevelKeys(newContent);
  if (dups.length) {
    return {
      success: false,
      message: `Refusing to write config with duplicate top-level keys: ${dups.join(", ")}`,
    };
  }

  atomicWriteFile(configPath, newContent, 0o600);
  const profilePath = writeStellaProfile();
  return {
    success: true,
    message: `Stella AI models installed in Codex model picker at ${targetUrl}. Model catalog: ${modelsCatalogPath}. Original config backed up. Run \`codex-stella-web uninstall\` to restore.`,
  };
}

export function uninstallCodexIntegration(): { success: boolean; message: string } {
  const configPath = getCodexConfigPath();
  const journalPath = getCodexJournalPath();

  const stopRes = stopRunningDaemon();
  const removedProfile = removeStellaProfile();

  if (!existsSync(configPath)) {
    return {
      success: false,
      message: `Codex config not found at ${configPath}. ${removedProfile ? "Removed managed Stella profile. " : ""}${stopRes.message}`,
    };
  }

  const current = readFileSync(configPath, "utf-8");
  let journal: CodexJournal | null = null;
  if (existsSync(journalPath)) {
    try {
      journal = JSON.parse(readFileSync(journalPath, "utf-8")) as CodexJournal;
      if (journal.configPath && journal.configPath !== configPath) {
        journal = null;
      }
    } catch {
      journal = null;
    }
  }

  let cleaned = restoreOriginalComments(stripManagedSections(current));
  if (!parseAssignment(cleaned.split("\n").find((l) => parseAssignment(l)?.key === "model") || "")) {
    const fallbackModel = journal?.captured?.model;
    if (fallbackModel) {
      cleaned = `model = ${fallbackModel}\n${cleaned}`;
    }
  }

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n*$/, "\n");
  atomicWriteFile(configPath, cleaned, 0o600);
  removeStellaProfile();

  if (existsSync(journalPath)) {
    try {
      unlinkSync(journalPath);
    } catch {
      // ignore
    }
  }

  return {
    success: true,
    message: `Removed codex-stella-web configuration from Codex config. Official Codex GPT quota is unchanged. ${stopRes.message}`,
  };
}

export { stopRunningDaemon };
