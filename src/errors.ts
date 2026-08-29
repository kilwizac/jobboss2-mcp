import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { JsonValue } from "./json.js";

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

export class JobBoss2InputError extends Error {
  override readonly name = "JobBoss2InputError";
}

export class JobBoss2NetworkError extends Error {
  override readonly name = "JobBoss2NetworkError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class JobBoss2CancelledError extends Error {
  override readonly name = "JobBoss2CancelledError";

  constructor() {
    super("The JobBOSS2 request was cancelled");
  }
}

export class JobBoss2ApiError extends Error {
  override readonly name = "JobBoss2ApiError";
  readonly method: string;
  readonly path: string;
  readonly response: JsonValue;
  readonly status: number;

  constructor(message: string, status: number, method: string, path: string, response: JsonValue) {
    super(message);
    this.status = status;
    this.method = method;
    this.path = path;
    this.response = response;
  }
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findApiMessage(value: JsonValue): string | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value["Error"] ?? value["error"];
  const source = nested && isRecord(nested) ? nested : value;

  for (const key of ["Detail", "detail", "Title", "title", "message"]) {
    const candidate = source[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }

  return undefined;
}

export function createApiError(
  status: number,
  method: string,
  path: string,
  response: JsonValue,
): JobBoss2ApiError {
  const detail = findApiMessage(response);
  const message = detail
    ? `JobBOSS2 returned HTTP ${status}: ${detail}`
    : `JobBOSS2 returned HTTP ${status}`;
  return new JobBoss2ApiError(message, status, method, path, response);
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof JobBoss2ApiError) {
    return {
      type: "api_error",
      message: error.message,
      status: error.status,
      method: error.method,
      path: error.path,
      response: error.response,
    };
  }

  if (error instanceof JobBoss2InputError) {
    return { type: "invalid_input", message: error.message };
  }

  if (error instanceof JobBoss2NetworkError) {
    return { type: "network_error", message: error.message };
  }

  console.error(error);
  return { type: "internal_error", message: "The JobBOSS2 MCP server failed unexpectedly." };
}

export function toToolError(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: errorPayload(error) }, null, 2) }],
    isError: true,
  };
}
