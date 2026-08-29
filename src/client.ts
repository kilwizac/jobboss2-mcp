import { z } from "zod";

import type { Fetcher, TokenProvider } from "./auth.js";
import type { CatalogOperation } from "./catalog.js";
import {
  createApiError,
  JobBoss2CancelledError,
  JobBoss2InputError,
  JobBoss2NetworkError,
} from "./errors.js";
import { jsonValueSchema, readResponseBody, type JsonValue } from "./json.js";
import { SERVER_VERSION } from "./version.js";

export const apiResultSchema = z.object({
  data: jsonValueSchema,
  status: z.number().int(),
});

export type ApiResult = z.infer<typeof apiResultSchema>;
export type PathValue = string | number;
export type QueryValue = string | number | boolean;

export type JobBoss2Request = Readonly<{
  body?: JsonValue;
  operation: CatalogOperation;
  pathParameters?: Readonly<Record<string, PathValue>>;
  query?: Readonly<Record<string, QueryValue | undefined>>;
  signal?: AbortSignal;
}>;

export type JobBoss2ClientOptions = Readonly<{
  baseUrl: URL;
  fetcher?: Fetcher;
  timeoutMs: number;
  tokenProvider: TokenProvider;
}>;

function fillPath(
  operation: CatalogOperation,
  parameters: Readonly<Record<string, PathValue>>,
): string {
  const expected = new Set(operation.pathParameters);
  const supplied = Object.keys(parameters);
  const missing = operation.pathParameters.filter((name) => parameters[name] === undefined);
  const extra = supplied.filter((name) => !expected.has(name));

  if (missing.length > 0) {
    throw new JobBoss2InputError(`Missing path parameters: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    throw new JobBoss2InputError(`Unknown path parameters: ${extra.join(", ")}`);
  }

  return operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = parameters[name];
    const serialized = value === undefined ? "" : String(value);
    if (serialized.length === 0) {
      throw new JobBoss2InputError(`Path parameter ${name} cannot be empty`);
    }
    if (serialized === "." || serialized === "..") {
      throw new JobBoss2InputError(`Path parameter ${name} cannot be a dot segment`);
    }
    return encodeURIComponent(serialized);
  });
}

function appendQuery(url: URL, query: Readonly<Record<string, QueryValue | undefined>>): void {
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    url.searchParams.set(name, String(value));
  }
}

export class JobBoss2Client {
  readonly #baseUrl: URL;
  readonly #fetcher: Fetcher;
  readonly #timeoutMs: number;
  readonly #tokenProvider: TokenProvider;

  constructor(options: JobBoss2ClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#fetcher = options.fetcher ?? fetch;
    this.#timeoutMs = options.timeoutMs;
    this.#tokenProvider = options.tokenProvider;
  }

  async request(request: JobBoss2Request): Promise<ApiResult> {
    if (request.signal?.aborted) throw new JobBoss2CancelledError();
    const parameters = request.pathParameters ?? {};
    const path = fillPath(request.operation, parameters);
    const url = new URL(path, this.#baseUrl);
    appendQuery(url, request.query ?? {});

    const firstToken = await this.#tokenProvider.getAccessToken(request.signal);
    const firstResponse = await this.#send(url, request, firstToken);
    if (firstResponse.status !== 401) {
      return this.#handleResponse(firstResponse, request.operation.method, path, request.signal);
    }

    const canRefresh = this.#tokenProvider.invalidate(firstToken);
    if (request.operation.method !== "GET" || !canRefresh) {
      return this.#handleResponse(firstResponse, request.operation.method, path, request.signal);
    }

    if (firstResponse.body) await firstResponse.body.cancel().catch(() => undefined);
    if (request.signal?.aborted) throw new JobBoss2CancelledError();
    const refreshedToken = await this.#tokenProvider.getAccessToken(request.signal);
    const retriedResponse = await this.#send(url, request, refreshedToken);
    return this.#handleResponse(retriedResponse, request.operation.method, path, request.signal);
  }

  async #send(url: URL, request: JobBoss2Request, accessToken: string): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": `jobboss2-mcp/${SERVER_VERSION}`,
    };

    let body: string | undefined;
    if (request.body !== undefined) {
      headers["content-type"] = request.operation.requestContentType ?? "application/json";
      body = JSON.stringify(request.body);
    }

    try {
      const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
      const init: RequestInit = {
        headers,
        method: request.operation.method,
        redirect: "error",
        signal: request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal,
      };
      if (body !== undefined) init.body = body;
      return await this.#fetcher(url, init);
    } catch (error) {
      if (request.signal?.aborted) throw new JobBoss2CancelledError();
      throw new JobBoss2NetworkError(
        `JobBOSS2 request failed for ${request.operation.method} ${request.operation.path}`,
        { cause: error },
      );
    }
  }

  async #handleResponse(
    response: Response,
    method: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<ApiResult> {
    let data: JsonValue;
    try {
      data = await readResponseBody(response);
    } catch (error) {
      if (signal?.aborted) throw new JobBoss2CancelledError();
      throw new JobBoss2NetworkError(`Could not read the JobBOSS2 response for ${method} ${path}`, {
        cause: error,
      });
    }
    if (!response.ok) throw createApiError(response.status, method, path, data);
    return apiResultSchema.parse({ data, status: response.status });
  }
}
