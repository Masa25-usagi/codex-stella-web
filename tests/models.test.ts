import test from "node:test";
import assert from "node:assert/strict";
import { resolveStellaModel, toOpenAiModelCatalog } from "../src/stella/models.js";

test("resolveStellaModel resolves default auto model", () => {
  const resolved = resolveStellaModel("stella-auto", []);
  assert.equal(resolved.searchType, "none");
});

test("resolveStellaModel resolves deep inference for reasoning models", () => {
  const m1 = resolveStellaModel("stella-deep-inference", []);
  assert.equal(m1.searchType, "deep_inference");

  const m2 = resolveStellaModel("o1-preview", []);
  assert.equal(m2.searchType, "deep_inference");

  const m3 = resolveStellaModel("gpt-6-astra", []);
  assert.equal(m3.searchType, "deep_inference");
});

test("resolveStellaModel resolves modern 2026 models with ULIDs", () => {
  const available = [
    { id: "ulid-haiku", name: "Claude Haiku 4.5", model: "global.anthropic.claude-haiku-4-5-20251001-v1:0", model_type: "text" },
    { id: "ulid-sonnet", name: "Claude Sonnet 5", model: "global.anthropic.claude-sonnet-5", model_type: "text" },
    { id: "ulid-terra", name: "GPT-5.6 Terra", model: "gpt-5.6-terra", model_type: "text" },
    { id: "ulid-luna", name: "GPT-5.6 Luna", model: "gpt-5.6-luna", model_type: "text" },
    { id: "ulid-grok", name: "Grok 4.6", model: "grok-4.6", model_type: "text" },
    { id: "ulid-gemini", name: "Gemini 3.8 Flash", model: "gemini-3.8-flash", model_type: "text" },
    { id: "ulid-midjourney", name: "Midjourney v7", model: "midjourney-v7", model_type: "image" },
  ];

  // 1. Sonnet 5 resolution
  const c1 = resolveStellaModel("claude-sonnet-5", available);
  assert.equal(c1.stellaModelId, "ulid-sonnet");

  const c2 = resolveStellaModel("claude-3-7-sonnet", available);
  assert.equal(c2.stellaModelId, "ulid-sonnet");

  // 2. GPT-5.6 Terra resolution
  const g1 = resolveStellaModel("gpt-5.6-terra", available);
  assert.equal(g1.stellaModelId, "ulid-terra");

  const g2 = resolveStellaModel("gpt-4.5", available);
  assert.equal(g2.stellaModelId, "ulid-terra");

  // 3. Grok 4.6 resolution
  const gr = resolveStellaModel("grok-4.6", available);
  assert.equal(gr.stellaModelId, "ulid-grok");

  // 4. Gemini 3.8 Flash resolution
  const gem = resolveStellaModel("gemini-3.8-flash", available);
  assert.equal(gem.stellaModelId, "ulid-gemini");

  // 5. Reasoning effort triggers deep_inference
  const r1 = resolveStellaModel("claude-sonnet-5", available, "xhigh");
  assert.equal(r1.searchType, "deep_inference");

  // 6. Image models are excluded from text resolution
  const img = resolveStellaModel("midjourney", available);
  assert.notEqual(img.stellaModelId, "ulid-midjourney");
});

test("toOpenAiModelCatalog formats models into OpenAI list schema", () => {
  const catalog = toOpenAiModelCatalog([
    { id: "custom-stella-1", name: "Custom 1" },
    { id: "ulid-sonnet", name: "Claude Sonnet 5", model: "global.anthropic.claude-sonnet-5", model_type: "text" },
    { id: "ulid-mj", name: "Midjourney v7", model: "midjourney-v7", model_type: "image" },
  ]);

  assert.equal(catalog.object, "list");
  assert(Array.isArray(catalog.data));
  assert(catalog.data.some((m) => m.id === "custom-stella-1"));
  assert(catalog.data.some((m) => m.id === "stella-auto"));
  assert(catalog.data.some((m) => m.id === "claude-sonnet-5"));
  assert(catalog.data.some((m) => m.id === "gpt-5.6-terra"));
  assert(!catalog.data.some((m) => String(m.id).startsWith("global.")));
  assert(!catalog.data.some((m) => m.id.includes("midjourney")));
});

test("generateCodexModelsCatalog produces Codex native ModelsResponse with visibility=list", async () => {
  const { generateCodexModelsCatalog } = await import("../src/stella/models.js");
  const catalog = generateCodexModelsCatalog();

  assert(Array.isArray(catalog.models));
  assert(catalog.models.length >= 5);

  const auto = catalog.models.find((m) => m.slug === "stella-auto");
  assert(auto);
  assert.equal(auto.visibility, "list");
  assert.equal(auto.supported_in_api, true);
  assert(auto.base_instructions.length > 0);
  assert(Array.isArray(auto.reasoning_effort_presets));
  assert.equal(auto.default_reasoning_level, "low");
  assert(Array.isArray(auto.supported_reasoning_levels));
  assert.deepEqual(auto.supported_reasoning_levels, auto.reasoning_effort_presets);

  const deep = catalog.models.find((m) => m.slug === "stella-deep-inference");
  assert(deep);
  assert.equal(deep.visibility, "list");
  assert(!catalog.models.some((m) => m.slug.startsWith("global-") || m.slug.includes("anthropic")));
});
