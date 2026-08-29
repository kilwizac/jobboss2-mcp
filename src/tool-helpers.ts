import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ApiResult, QueryValue } from "./client.js";
import { JobBoss2InputError } from "./errors.js";
import { jsonValueSchema, type JsonObject } from "./json.js";

const fieldNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_]+$/, "must contain only letters, numbers, or underscores");

const sortExpressionSchema = z
  .string()
  .min(1)
  .regex(/^[+-]?[A-Za-z0-9_]+$/, "must be a field name with an optional + or - prefix");

const filterKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_]+(?:\[(?:eq|ne|gte|lte|gt|lt|in|notin|null)\])?$/i,
    "must be a field name with a supported JobBOSS2 filter operator",
  );

const filterScalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const filterValueSchema = z.union([filterScalarSchema, z.array(filterScalarSchema).min(1)]);

export const listOptionsSchema = z.object({
  fields: z.array(fieldNameSchema).min(1).optional(),
  filters: z.record(filterKeySchema, filterValueSchema).optional(),
  skip: z.number().int().nonnegative().optional(),
  sort: z.array(sortExpressionSchema).min(1).optional(),
  take: z.number().int().min(1).max(200).optional(),
});

export const fieldsSchema = z.array(fieldNameSchema).min(1).optional();
export const pathParametersSchema = z.record(
  z.string().min(1),
  z.union([z.string().min(1), z.number().finite()]),
);
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export const catalogResultSchema = z.object({ result: jsonObjectSchema });
export const queryParametersSchema = z.record(z.string().min(1), filterScalarSchema);

export type ListOptions = z.infer<typeof listOptionsSchema>;

const RESERVED_LIST_PARAMETERS = new Set(["fields", "skip", "sort", "take"]);

export function buildListQuery(options: ListOptions): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  if (options.fields) query["fields"] = options.fields.join(",");
  if (options.sort) query["sort"] = options.sort.join(",");
  if (options.skip !== undefined) query["skip"] = options.skip;
  if (options.take !== undefined) query["take"] = options.take;

  for (const [key, value] of Object.entries(options.filters ?? {})) {
    const normalizedKey = key.toLowerCase();
    if (RESERVED_LIST_PARAMETERS.has(normalizedKey)) {
      throw new JobBoss2InputError(
        `Filter ${key} would override the ${normalizedKey} list option; use ${key}[eq] to filter a field with that name`,
      );
    }
    if (normalizedKey === "reviseddate[null]") {
      throw new JobBoss2InputError("JobBOSS2 does not support the null operator for revisedDate");
    }
    if (Array.isArray(value) && !/\[(?:in|notin)\]$/i.test(key)) {
      throw new JobBoss2InputError(`Filter ${key} accepts an array only with in or notin`);
    }
    if (
      Array.isArray(value) &&
      value.some((item) => typeof item === "string" && item.includes("|"))
    ) {
      throw new JobBoss2InputError(`Filter ${key} array values cannot contain a pipe character`);
    }
    if (/\[null\]$/i.test(key) && typeof value !== "boolean") {
      throw new JobBoss2InputError(`Filter ${key} requires a boolean value`);
    }
    query[key] = Array.isArray(value) ? value.join("|") : value;
  }

  return query;
}

export function buildFieldsQuery(fields: readonly string[] | undefined): Record<string, string> {
  return fields ? { fields: fields.join(",") } : {};
}

export function toApiToolResult(result: ApiResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

export function toCatalogToolResult(result: JsonObject): CallToolResult {
  const output = { result };
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}
