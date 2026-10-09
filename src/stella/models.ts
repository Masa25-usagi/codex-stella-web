import { existsSync, writeFileSync, renameSync } from "node:fs";
import { getCodexModelsCatalogPath } from "../config.js";
import type { StellaAiModel, StellaSearchType } from "./types.js";
import type { StellaClient } from "./client.js";

export interface ResolvedModel {
  stellaModelId?: string; // ULID required by Stella AI API
  searchType: StellaSearchType;
  displayName: string;
}

export interface CodexModelEntry {
  slug: string;
  display_name: string;
  description: string;
  reasoning_effort_presets?: Array<{ effort: string; description: string }>;
  default_reasoning_level: string;
  supported_reasoning_levels: Array<{ effort: string; description: string }>;
  shell_type: string;
  visibility: "list" | "hidden";
  supported_in_api: boolean;
  priority: number;
  availability_nux: null | unknown;
  upgrade: null | unknown;
  support_verbosity: boolean;
  default_verbosity: string;
  apply_patch_tool_type: string;
  truncation_policy: { mode: string; limit: number };
  experimental_supported_tools: string[];
  context_window: number;
  max_context_window: number;
  input_modalities: string[];
  base_instructions: string;
}

export interface CodexModelsResponse {
  models: CodexModelEntry[];
}

const DEFAULT_BASE_INSTRUCTIONS =
  "You are Codex, a coding agent. Follow the developer instructions and use tools to solve the user's task.";

/**
 * Family metadata for 2026 models on Stella AI
 */
export const FAMILY_METADATA: Record<
  string,
  {
    context_window: number;
    max_context_window: number;
    reasoning_effort_presets?: Array<{ effort: string; description: string }>;
    input_modalities: string[];
  }
> = {
  "gpt-6-sol": {
    context_window: 400_000,
    max_context_window: 400_000,
    reasoning_effort_presets: [
      { effort: "low", description: "Fast reasoning" },
      { effort: "medium", description: "Standard reasoning" },
      { effort: "high", description: "Deep inference" },
      { effort: "xhigh", description: "Maximum reasoning effort" },
    ],
    input_modalities: ["text", "image"],
  },
  "gpt-6-luna": {
    context_window: 128_000,
    max_context_window: 128_000,
    input_modalities: ["text", "image"],
  },
  "claude-sonnet-5.5": {
    context_window: 1_000_000,
    max_context_window: 1_000_000,
    reasoning_effort_presets: [
      { effort: "low", description: "Fast execution" },
      { effort: "medium", description: "Balanced thinking" },
      { effort: "high", description: "Extended thinking" },
      { effort: "xhigh", description: "Deep thinking mode" },
    ],
    input_modalities: ["text", "image"],
  },
  "claude-sonnet-5-5": {
    context_window: 1_000_000,
    max_context_window: 1_000_000,
    reasoning_effort_presets: [
      { effort: "low", description: "Fast execution" },
      { effort: "medium", description: "Balanced thinking" },
      { effort: "high", description: "Extended thinking" },
      { effort: "xhigh", description: "Deep thinking mode" },
    ],
    input_modalities: ["text", "image"],
  },
  "claude-haiku-4.5": {
    context_window: 200_000,
    max_context_window: 200_000,
    input_modalities: ["text", "image"],
  },
  "grok-4.7": {
    context_window: 256_000,
    max_context_window: 256_000,
    reasoning_effort_presets: [
      { effort: "low", description: "Standard Grok" },
      { effort: "medium", description: "Enhanced reasoning" },
      { effort: "high", description: "Deep reasoning" },
      { effort: "xhigh", description: "Extra high reasoning effort" },
    ],
    input_modalities: ["text", "image"],
  },
  "gemini-3.8-flash": {
    context_window: 1_048_576,
    max_context_window: 1_048_576,
    input_modalities: ["text", "image"],
  },
  "gemini-3.5-flash-lite": {
    context_window: 1_048_576,
    max_context_window: 1_048_576,
    input_modalities: ["text"],
  },
  auto: {
    context_window: 272_000,
    max_context_window: 272_000,
    reasoning_effort_presets: [
      { effort: "low", description: "Fast" },
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Deep inference" },
      { effort: "xhigh", description: "Maximum effort" },
    ],
    input_modalities: ["text", "image"],
  },
  // Legacy aliases
  "gpt-5.6-terra": {
    context_window: 400_000,
    max_context_window: 400_000,
    reasoning_effort_presets: [
      { effort: "low", description: "Fast reasoning" },
      { effort: "medium", description: "Standard reasoning" },
      { effort: "high", description: "Deep inference" },
      { effort: "xhigh", description: "Maximum reasoning effort" },
    ],
    input_modalities: ["text", "image"],
  },
  "gpt-5.6-luna": {
    context_window: 128_000,
    max_context_window: 128_000,
    input_modalities: ["text", "image"],
  },
  "claude-sonnet-5": {
    context_window: 1_000_000,
    max_context_window: 1_000_000,
    reasoning_effort_presets: [
      { effort: "low", description: "Fast execution" },
      { effort: "medium", description: "Balanced thinking" },
      { effort: "high", description: "Extended thinking" },
      { effort: "xhigh", description: "Deep thinking mode" },
    ],
    input_modalities: ["text", "image"],
  },
  "grok-4.6": {
    context_window: 256_000,
    max_context_window: 256_000,
    reasoning_effort_presets: [
      { effort: "low", description: "Standard Grok" },
      { effort: "medium", description: "Enhanced reasoning" },
      { effort: "high", description: "Deep reasoning" },
      { effort: "xhigh", description: "Extra high reasoning effort" },
    ],
    input_modalities: ["text", "image"],
  },
};

/**
 * Known default models (Stella AI 2026 lineup) for offline fallback or unauthenticated mode
 */
export const KNOWN_DEFAULT_MODELS: StellaAiModel[] = [
  {
    id: "stella-auto",
    name: "Stella Auto (Smart Route)",
    model: "stella-auto",
    model_type: "text",
    description: "Automatically routes to the best available model on Stella AI.",
    is_default: true,
  },
  {
    id: "stella-deep-inference",
    name: "Stella Deep Inference (Reasoning)",
    model: "stella-deep-inference",
    model_type: "text",
    description: "Stella AI with deep reasoning / extended thinking enabled.",
  },
  {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    model: "gpt-6-sol",
    model_type: "text",
    description: "OpenAI's flagship balanced reasoning & coding model (400k context).",
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    model: "gpt-6-luna",
    model_type: "text",
    description: "OpenAI's fast high-throughput model (128k context).",
  },
  {
    id: "claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    model: "claude-sonnet-5-5",
    model_type: "text",
    description: "Anthropic's flagship 1M context model with extended thinking.",
  },
  {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    model: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    model_type: "text",
    description: "Anthropic's high-speed 200k context model.",
  },
  {
    id: "grok-4.7",
    name: "Grok 4.7",
    model: "grok-4.7",
    model_type: "text",
    description: "xAI's native reasoning model with deep chain-of-thought (256k context).",
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    model: "gemini-3.8-flash",
    model_type: "text",
    description: "Google's latest 1M context coding & multimodal model.",
  },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash-Lite",
    model: "gemini-3.5-flash-lite",
    model_type: "text",
    description: "Google's lightweight 1M context model.",
  },
];

/**
 * Fuzzy request aliases mapping common names to modern 2026 Stella models.
 * More specific patterns must come first. Generic "claude" is intentionally absent
 * so Haiku is never selected for a Sonnet request.
 */
const REQUEST_ALIASES: Array<{ pattern: RegExp; family: string; searchType?: StellaSearchType }> = [
  { pattern: /deep[-_]?inference|reasoning|think/i, family: "auto", searchType: "deep_inference" },
  { pattern: /gpt[-_]?6[-_]?astra|o1|o3[-_]?mini|(^|[^a-z0-9])o3([^a-z0-9]|$)|deepseek[-_]?r1/i, family: "gpt-6-sol", searchType: "deep_inference" },

  { pattern: /claude[-_]?sonnet[-_]?5[-_.]?5|sonnet[-_]?5[-_.]?5|claude[-_]?sonnet[-_]?5|sonnet[-_]?5|claude[-_]?3[-_.]?7|claude[-_]?3[-_.]?5[-_]?sonnet/i, family: "claude-sonnet-5.5" },
  { pattern: /claude[-_]?haiku|haiku[-_]?4/i, family: "claude-haiku-4.5" },

  { pattern: /gpt[-_]?6[-_.]?luna|gpt[-_]?5[-_.]?6[-_]?luna|gpt[-_]?4o[-_]?mini|gpt[-_]?5[-_]?mini/i, family: "gpt-6-luna" },
  { pattern: /gpt[-_]?6[-_.]?sol|gpt[-_]?5[-_.]?6[-_]?terra|gpt[-_]?6|gpt[-_]?5[-_.]?6|gpt[-_]?4[-_.]?5|gpt[-_]?4o/i, family: "gpt-6-sol" },

  { pattern: /grok[-_]?4[-_.]?7|grok[-_]?4[-_.]?6|grok[-_]?4|grok[-_]?3|grok/i, family: "grok-4.7" },

  { pattern: /gemini[-_]?3[-_.]?5|flash[-_]?lite|gemini[-_]?lite/i, family: "gemini-3.5-flash-lite" },
  { pattern: /gemini[-_]?3[-_.]?8|gemini[-_]?2[-_.]?0[-_]?flash|gemini[-_]?flash|gemini/i, family: "gemini-3.8-flash" },

  { pattern: /auto|smart/i, family: "auto" },
];

function isImageModel(m: StellaAiModel): boolean {
  const type = (m.model_type || m.type || "").toLowerCase();
  if (type === "image") return true;
  const text = `${m.model || ""} ${m.name || ""}`.toLowerCase();
  return text.includes("midjourney") || text.includes("image");
}

function familyMatches(m: StellaAiModel, family: string): boolean {
  const text = `${m.model || ""} ${m.name || ""}`.toLowerCase();
  switch (family) {
    case "gpt-6-sol":
    case "gpt-5.6-terra":
      return text.includes("sol") || text.includes("terra") || (text.includes("5.6") && !text.includes("luna"));
    case "gpt-6-luna":
    case "gpt-5.6-luna":
      return text.includes("luna");
    case "claude-sonnet-5.5":
    case "claude-sonnet-5-5":
    case "claude-sonnet-5":
      return text.includes("sonnet") && !text.includes("haiku");
    case "claude-haiku-4.5":
      return text.includes("haiku");
    case "grok-4.7":
    case "grok-4.6":
      return text.includes("grok");
    case "gemini-3.8-flash":
      return (text.includes("3.8") || text.includes("flash")) && !text.includes("lite");
    case "gemini-3.5-flash-lite":
      return text.includes("lite");
    case "auto":
      return text.includes("auto") || m.is_default === true;
    default:
      return false;
  }
}

export function friendlySlugForModel(m: StellaAiModel): string | undefined {
  if (isImageModel(m)) return undefined;
  const text = `${m.model || ""} ${m.name || ""}`.toLowerCase();
  if (text.includes("sol")) return "gpt-6-sol";
  if (text.includes("terra")) return "gpt-6-sol";
  if (text.includes("luna")) return "gpt-6-luna";
  if (text.includes("sonnet")) return "claude-sonnet-5.5";
  if (text.includes("haiku")) return "claude-haiku-4.5";
  if (text.includes("grok")) return "grok-4.7";
  if (text.includes("lite")) return "gemini-3.5-flash-lite";
  if (text.includes("3.8") || text.includes("gemini")) return "gemini-3.8-flash";
  const raw = m.model || "";
  if (!raw || raw.startsWith("global.") || /^[0-9a-hjkmnp-z]{26}$/i.test(raw)) {
    return undefined;
  }
  const slug = normalizeSlug(raw);
  if (!slug || slug.startsWith("global-")) return undefined;
  return slug;
}

function normalizeSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function resolveStellaModel(
  requested: string = "stella-auto",
  availableModels: StellaAiModel[] = [],
  reasoningEffort?: string
): ResolvedModel {
  const norm = normalizeSlug(requested);

  let searchType: StellaSearchType = "none";
  if (
    norm.includes("deep") ||
    norm.includes("think") ||
    norm.includes("reason") ||
    norm.includes("astra") ||
    /(^|-)(o1|o3)(-|$)/.test(norm) ||
    norm.includes("xhigh") ||
    reasoningEffort === "high" ||
    reasoningEffort === "xhigh" ||
    reasoningEffort === "max"
  ) {
    searchType = "deep_inference";
  }

  const textModels = availableModels.filter((m) => !isImageModel(m));

  for (const m of textModels) {
    const modelSlug = m.model ? normalizeSlug(m.model) : "";
    const nameSlug = normalizeSlug(m.name);
    const idSlug = normalizeSlug(m.id);
    const friendly = friendlySlugForModel(m);

    if (
      norm === idSlug ||
      (modelSlug && norm === modelSlug) ||
      (nameSlug && norm === nameSlug) ||
      (modelSlug && norm === `stella-${modelSlug}`) ||
      (nameSlug && norm === `stella-${nameSlug}`) ||
      (friendly && (norm === normalizeSlug(friendly) || norm === `stella-${normalizeSlug(friendly)}`))
    ) {
      if (modelSlug.startsWith("global-") && friendly && norm !== idSlug) {
        // Do not treat raw provider slugs as a successful picker match unless the user
        // passed the exact ULID. Fall through to family aliases.
        continue;
      }
      return {
        stellaModelId: m.id,
        searchType,
        displayName: m.name,
      };
    }
  }

  for (const alias of REQUEST_ALIASES) {
    if (alias.pattern.test(requested) || alias.pattern.test(norm)) {
      if (alias.searchType) {
        searchType = alias.searchType;
      }
      const match = textModels.find((m) => familyMatches(m, alias.family));
      if (match) {
        return {
          stellaModelId: match.id,
          searchType,
          displayName: match.name,
        };
      }
      return {
        stellaModelId: undefined,
        searchType,
        displayName: requested || alias.family,
      };
    }
  }

  const defaultModel = textModels.find((m) => m.is_default);
  if (defaultModel) {
    return {
      stellaModelId: defaultModel.id,
      searchType,
      displayName: defaultModel.name,
    };
  }

  return {
    stellaModelId: undefined,
    searchType,
    displayName: requested || "Stella Auto",
  };
}

const FRIENDLY_DEFAULT_IDS = [
  "stella-auto",
  "stella-deep-inference",
  "gpt-6-sol",
  "gpt-6-luna",
  "claude-sonnet-5.5",
  "claude-sonnet-5-5",
  "claude-haiku-4.5",
  "grok-4.7",
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  // Legacy aliases for backward compatibility
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "claude-sonnet-5",
  "grok-4.6",
];

export function toOpenAiModelCatalog(
  models: StellaAiModel[] = []
): { object: "list"; data: Array<{ id: string; object: "model"; created: number; owned_by: string }> } {
  const ids: string[] = [];
  const add = (id?: string) => {
    if (!id) return;
    if (id.startsWith("global.")) return;
    if (/^[0-9a-hjkmnp-z]{26}$/i.test(id)) return;
    if (!ids.includes(id)) ids.push(id);
  };

  for (const id of FRIENDLY_DEFAULT_IDS) add(id);
  for (const m of KNOWN_DEFAULT_MODELS) add(m.model || m.id);
  for (const m of models) {
    if (isImageModel(m)) continue;
    add(friendlySlugForModel(m));
    if (m.model && !m.model.startsWith("global.")) add(m.model);
    if (m.id && !m.id.startsWith("global.") && m.id.length < 40) add(m.id);
  }

  return {
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model" as const,
      created: 1770000000,
      owned_by: "stella-ai",
    })),
  };
}

/**
 * Generate full Codex ModelsResponse schema for Codex CLI & Desktop App model picker
 */
export function liveModelsToCodexCatalog(liveModels: StellaAiModel[] = []): CodexModelsResponse {
  const sourceList = liveModels.length > 0 ? liveModels : KNOWN_DEFAULT_MODELS;
  const textModels = sourceList.filter((m) => !isImageModel(m));
  const models: CodexModelEntry[] = [];
  let priority = 1;

  const push = (
    slug: string,
    display: string,
    description: string,
    familyKey: string
  ) => {
    const meta = FAMILY_METADATA[familyKey] || FAMILY_METADATA["auto"];
    models.push({
      slug,
      display_name: display,
      description,
      reasoning_effort_presets: meta.reasoning_effort_presets,
      default_reasoning_level: meta.reasoning_effort_presets?.[0]?.effort || "none",
      supported_reasoning_levels: meta.reasoning_effort_presets || [],
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: priority++,
      availability_nux: null,
      upgrade: null,
      support_verbosity: true,
      default_verbosity: "low",
      apply_patch_tool_type: "freeform",
      truncation_policy: { mode: "tokens", limit: 10_000 },
      experimental_supported_tools: [],
      context_window: meta.context_window,
      max_context_window: meta.max_context_window,
      input_modalities: meta.input_modalities,
      base_instructions: DEFAULT_BASE_INSTRUCTIONS,
    });
  };

  // 1. Featured smart presets at the top
  push(
    "stella-auto",
    "Stella Auto (Smart Route)",
    "Automatically routes to the best model on Stella AI for your plan.",
    "auto"
  );
  push(
    "stella-deep-inference",
    "Stella Deep Inference (Reasoning)",
    "Stella AI deep reasoning & extended chain-of-thought mode.",
    "auto"
  );

  const seen = new Set(["stella-auto", "stella-deep-inference"]);

  // 2. Add each model with nice naming and context limits
  const sorted = [...textModels].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  for (const m of sorted) {
    if (m.model === "stella-auto" || m.id === "stella-auto" || m.id === "stella-deep-inference") continue;

    const baseSlug = friendlySlugForModel(m);
    if (!baseSlug) continue;
    const stellaSlug = baseSlug.startsWith("stella-") ? baseSlug : `stella-${baseSlug}`;

    let familyKey = "auto";
    const lower = `${m.model || ""} ${m.name || ""}`.toLowerCase();
    if (lower.includes("sol") || lower.includes("terra")) familyKey = "gpt-6-sol";
    else if (lower.includes("luna")) familyKey = "gpt-6-luna";
    else if (lower.includes("sonnet")) familyKey = "claude-sonnet-5.5";
    else if (lower.includes("haiku")) familyKey = "claude-haiku-4.5";
    else if (lower.includes("grok")) familyKey = "grok-4.7";
    else if (lower.includes("lite")) familyKey = "gemini-3.5-flash-lite";
    else if (lower.includes("3.8") || lower.includes("flash")) familyKey = "gemini-3.8-flash";

    if (!seen.has(stellaSlug)) {
      seen.add(stellaSlug);
      push(stellaSlug, `Stella ${m.name}`, m.description || `Stella AI ${m.name}`, familyKey);
    }

    if (!seen.has(baseSlug)) {
      seen.add(baseSlug);
      push(baseSlug, m.name, m.description || m.name, familyKey);
    }
  }

  // 3. Keep standard fallback slugs mapped to modern models
  if (!seen.has("gpt-6-sol")) push("gpt-6-sol", "GPT-6 Sol", "OpenAI Flagship 400k model via Stella", "gpt-6-sol");
  if (!seen.has("gpt-6-luna")) push("gpt-6-luna", "GPT-6 Luna", "OpenAI Fast 128k model via Stella", "gpt-6-luna");
  if (!seen.has("claude-sonnet-5.5")) push("claude-sonnet-5.5", "Claude Sonnet 5.5", "Anthropic 1M context model via Stella", "claude-sonnet-5.5");
  if (!seen.has("claude-haiku-4.5")) push("claude-haiku-4.5", "Claude Haiku 4.5", "Anthropic high-speed model via Stella", "claude-haiku-4.5");
  if (!seen.has("grok-4.7")) push("grok-4.7", "Grok 4.7", "xAI reasoning model via Stella", "grok-4.7");
  if (!seen.has("gemini-3.8-flash")) push("gemini-3.8-flash", "Gemini 3.8 Flash", "Google 1M coding model via Stella", "gemini-3.8-flash");
  if (!seen.has("gemini-3.5-flash-lite")) push("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", "Google lightweight 1M model via Stella", "gemini-3.5-flash-lite");

  return { models };
}

export function generateCodexModelsCatalog(): CodexModelsResponse {
  return liveModelsToCodexCatalog(KNOWN_DEFAULT_MODELS);
}

export async function syncCodexModelsCatalog(client?: StellaClient): Promise<string> {
  let live: StellaAiModel[] = [];
  if (client) {
    try {
      live = await client.fetchAiModels();
    } catch (err) {
      // If offline/unauthenticated, fall back to known 2026 models
    }
  }
  const catalog = liveModelsToCodexCatalog(live.length > 0 ? live : KNOWN_DEFAULT_MODELS);
  const filePath = getCodexModelsCatalogPath();
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(catalog, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
  return filePath;
}

export function writeCodexModelsCatalog(targetPath?: string): string {
  const filePath = targetPath || getCodexModelsCatalogPath();
  const catalog = liveModelsToCodexCatalog(KNOWN_DEFAULT_MODELS);
  writeFileSync(filePath, JSON.stringify(catalog, null, 2), "utf-8");
  return filePath;
}
