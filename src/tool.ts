import { asSchema, type FlexibleSchema, type JSONSchema7, jsonSchema } from "ai";
import type { NornsWorker } from "./worker.js";

/**
 * What a tool's `execute` is told about the call, besides its input.
 *
 * `signal` aborts when the worker gives up on the call: the socket dropped
 * (Norns re-dispatches the task) or a drain hit its deadline. A long tool
 * should pass it to whatever it waits on.
 */
export interface ToolContext {
  taskId: string;
  runId: number | undefined;
  agentId: number | undefined;
  /**
   * Set when Norns considers the call side-effecting. Same run, same step,
   * same tool call, same key, however many times it is dispatched; hand it
   * to a provider that dedupes (most payment APIs take one) and the effect
   * survives this worker dying mid-call too.
   */
  idempotencyKey: string | undefined;
  signal: AbortSignal;
  worker: NornsWorker;
}

/** A Zod schema, any Standard Schema, an `ai` `Schema`, or raw JSON Schema. */
export type ToolInputSchema = FlexibleSchema | JSONSchema7;

/** The argument type `execute` receives for a given `input` schema. */
export type InferToolInput<S> = S extends FlexibleSchema<infer T> ? T : Record<string, unknown>;

export interface ToolOptions<S extends ToolInputSchema = ToolInputSchema> {
  /** What the model calls it by. */
  name: string;
  /** What the model reads to decide when to call it. */
  description: string;
  /**
   * The input shape. A Zod object schema gives a typed, validated `execute`;
   * leave it out for a tool that takes nothing.
   */
  input?: S;
  /**
   * Mark a tool whose call must not happen twice. Norns then names each call
   * with an idempotency key, and a re-dispatched call is answered from the
   * result this worker kept rather than run again.
   */
  sideEffect?: boolean;
  /**
   * The handler. Return a string, or anything JSON-serialisable (it is
   * stringified for the model). Throwing reports an error result; the model
   * sees the message.
   */
  execute: (input: InferToolInput<S>, context: ToolContext) => unknown | Promise<unknown>;
}

export type ValidationResult<T> = { success: true; value: T } | { success: false; error: Error };

/** A tool ready to register with a worker: what `tool()` returns. */
export interface ToolDefinition<I = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema7;
  readonly sideEffect: boolean;
  /** Validates and coerces an input against the schema, when there is one. */
  readonly validate: ((value: unknown) => Promise<ValidationResult<I>>) | undefined;
  // Method syntax on purpose: it is bivariant, so a `ToolDefinition<{ q: string }>`
  // fits a `ToolDefinition[]` without the caller casting.
  execute(input: I, context: ToolContext): Promise<unknown>;
}

const EMPTY_SCHEMA: JSONSchema7 = { type: "object", properties: {} };

/**
 * Define a tool.
 *
 *     const searchDocs = tool({
 *       name: "search_docs",
 *       description: "Search product documentation.",
 *       input: z.object({ query: z.string() }),
 *       execute: async ({ query }) => db.search(query),
 *     });
 */
export function tool<S extends ToolInputSchema>(
  options: ToolOptions<S>,
): ToolDefinition<InferToolInput<S>> {
  type I = InferToolInput<S>;
  const name = options.name?.trim();
  if (!name) throw new Error("tool(): name is required");
  if (!options.description?.trim()) throw new Error(`tool('${name}'): description is required`);
  if (typeof options.execute !== "function") {
    throw new Error(`tool('${name}'): execute must be a function`);
  }

  let inputSchema: JSONSchema7 = EMPTY_SCHEMA;
  let validate: ToolDefinition<I>["validate"];

  if (options.input !== undefined) {
    const schema = asSchema(toFlexible(options.input));
    const json = schema.jsonSchema;
    if (isPromiseLike(json)) {
      throw new Error(`tool('${name}'): input schema must resolve synchronously`);
    }
    inputSchema = stripMeta(json);
    if (schema.validate) {
      const run = schema.validate;
      validate = async (value) => {
        const result = await run(value);
        return result.success
          ? { success: true, value: result.value as I }
          : { success: false, error: result.error };
      };
    }
  }

  const execute = options.execute;
  return Object.freeze({
    name,
    description: options.description.trim(),
    inputSchema,
    sideEffect: options.sideEffect ?? false,
    validate,
    execute: async (input: I, context: ToolContext) => execute(input, context),
  });
}

/** The wire form Norns reads at join. */
export function toolRegistration(t: ToolDefinition): {
  name: string;
  description: string;
  input_schema: JSONSchema7;
  side_effect: boolean;
} {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    side_effect: t.sideEffect,
  };
}

/** Turn a tool's output into the string the model reads. */
export function stringifyToolOutput(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function toFlexible(input: ToolInputSchema): FlexibleSchema {
  if (isRawJsonSchema(input)) return jsonSchema(input);
  return input as FlexibleSchema;
}

// A plain object is JSON Schema; anything that knows how to validate
// itself (Zod, Standard Schema, an `ai` Schema) is not.
function isRawJsonSchema(value: unknown): value is JSONSchema7 {
  if (typeof value !== "object" || value === null) return false;
  if ("~standard" in value || "_zod" in value || "_def" in value || "jsonSchema" in value) {
    return false;
  }
  return true;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  );
}

function stripMeta(schema: JSONSchema7): JSONSchema7 {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}
