import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonSchema, tool } from "../src/index.js";
import { stringifyToolOutput, toolRegistration } from "../src/tool.js";

describe("tool()", () => {
  it("derives JSON Schema from a Zod schema and types the handler", async () => {
    const search = tool({
      name: "search",
      description: "Search the web.",
      input: z.object({
        query: z.string().describe("What to look for"),
        limit: z.number().int().optional(),
      }),
      execute: ({ query, limit }) => `${query}:${limit ?? 10}`,
    });

    expect(search.name).toBe("search");
    expect(search.description).toBe("Search the web.");
    expect(search.sideEffect).toBe(false);
    expect(search.inputSchema).toMatchObject({
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for" },
        limit: { type: "integer" },
      },
      required: ["query"],
    });
    expect(search.inputSchema).not.toHaveProperty("$schema");
    expect(await search.execute({ query: "x" }, {} as never)).toBe("x:10");
  });

  it("validates input against the schema", async () => {
    const t = tool({
      name: "t",
      description: "d",
      input: z.object({ n: z.number() }),
      execute: ({ n }) => n,
    });
    const ok = await t.validate?.({ n: 1 });
    expect(ok).toEqual({ success: true, value: { n: 1 } });
    const bad = await t.validate?.({ n: "one" });
    expect(bad?.success).toBe(false);
  });

  it("accepts raw JSON Schema", () => {
    const t = tool({
      name: "raw",
      description: "d",
      input: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      execute: (input) => input.a,
    });
    expect(t.inputSchema).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    expect(t.validate).toBeUndefined();
  });

  it("accepts an ai Schema for typed JSON Schema", () => {
    const t = tool({
      name: "typed",
      description: "d",
      input: jsonSchema<{ a: string }>({ type: "object", properties: { a: { type: "string" } } }),
      execute: (input) => input.a.toUpperCase(),
    });
    expect(t.inputSchema.properties).toEqual({ a: { type: "string" } });
  });

  it("defaults to an empty object schema with no input", () => {
    const t = tool({ name: "ping", description: "d", execute: () => "pong" });
    expect(t.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("produces the wire registration", () => {
    const t = tool({
      name: "charge",
      description: "Take money.",
      sideEffect: true,
      input: z.object({ amount: z.number() }),
      execute: () => "ok",
    });
    expect(toolRegistration(t)).toEqual({
      name: "charge",
      description: "Take money.",
      input_schema: t.inputSchema,
      side_effect: true,
    });
  });

  it("rejects a missing name or description", () => {
    expect(() => tool({ name: "", description: "d", execute: () => "" })).toThrow(/name/);
    expect(() => tool({ name: "x", description: " ", execute: () => "" })).toThrow(/description/);
  });
});

describe("stringifyToolOutput", () => {
  it("passes strings through and encodes everything else", () => {
    expect(stringifyToolOutput("hi")).toBe("hi");
    expect(stringifyToolOutput({ a: 1 })).toBe('{"a":1}');
    expect(stringifyToolOutput(42)).toBe("42");
    expect(stringifyToolOutput(undefined)).toBe("");
    expect(stringifyToolOutput(null)).toBe("");
  });
});
