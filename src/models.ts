import type { LanguageModel } from "ai";

/** Turns the model name on an LLM task into something the AI SDK can call. */
export type ModelResolver = (modelId: string) => LanguageModel | Promise<LanguageModel>;

/** A provider, or a registry from `createProviderRegistry()`. */
export interface ModelSource {
  languageModel(modelId: string): LanguageModel;
}

export type ModelsOption = ModelResolver | ModelSource;

const PROVIDER_PACKAGES: Record<string, string> = {
  anthropic: "@ai-sdk/anthropic",
  openai: "@ai-sdk/openai",
  google: "@ai-sdk/google",
  mistral: "@ai-sdk/mistral",
};

/**
 * Split `"provider/model"` (or `"provider:model"`) into its parts, inferring
 * the provider from the model's name when there is no prefix.
 */
export function inferProvider(model: string): { provider: string; modelId: string } {
  const sep = model.search(/[/:]/);
  if (sep > 0) {
    const provider = model.slice(0, sep);
    if (provider in PROVIDER_PACKAGES || /^[a-z][a-z0-9-]*$/.test(provider)) {
      return { provider, modelId: model.slice(sep + 1) };
    }
  }
  const lower = model.toLowerCase();
  if (lower.startsWith("claude")) return { provider: "anthropic", modelId: model };
  if (/^(gpt|o[1-9]|chatgpt|text-)/.test(lower)) return { provider: "openai", modelId: model };
  if (lower.startsWith("gemini")) return { provider: "google", modelId: model };
  if (/^(mistral|codestral|ministral|pixtral|magistral)/.test(lower)) {
    return { provider: "mistral", modelId: model };
  }
  return { provider: "anthropic", modelId: model };
}

/**
 * The default: pick the `@ai-sdk/*` package for the model's provider, load
 * it if it is installed, and ask it for the model. API keys come from the
 * provider's own environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...).
 */
export function defaultModelResolver(): ModelResolver {
  const cache = new Map<string, Promise<LanguageModel>>();
  return (model) => {
    let pending = cache.get(model);
    if (!pending) {
      pending = loadModel(model);
      cache.set(model, pending);
      pending.catch(() => cache.delete(model));
    }
    return pending;
  };
}

async function loadModel(model: string): Promise<LanguageModel> {
  const { provider, modelId } = inferProvider(model);
  const pkg = PROVIDER_PACKAGES[provider] ?? `@ai-sdk/${provider}`;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pkg)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `No provider for model '${model}': install ${pkg} (npm install ${pkg}), ` +
        "or pass `models` to the worker to resolve models yourself",
      { cause: err },
    );
  }

  const instance = findProvider(mod, provider);
  if (!instance) {
    throw new Error(`${pkg} exports no provider instance; pass \`models\` to the worker`);
  }
  return instance(modelId);
}

type ProviderFn = ((modelId: string) => LanguageModel) & { languageModel?: unknown };

// Each package exports a default instance named for the provider
// (`anthropic`, `openai`, ...); fall back to any callable with `languageModel`.
function findProvider(mod: Record<string, unknown>, provider: string): ProviderFn | undefined {
  const named = mod[provider];
  if (typeof named === "function") return named as ProviderFn;
  for (const value of Object.values(mod)) {
    if (typeof value === "function" && "languageModel" in value) return value as ProviderFn;
  }
  return undefined;
}

export function toResolver(models: ModelsOption | undefined): ModelResolver {
  if (models === undefined) return defaultModelResolver();
  if (typeof models === "function") return models;
  return (id) => models.languageModel(id);
}
