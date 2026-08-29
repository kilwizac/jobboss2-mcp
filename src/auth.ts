import { z } from "zod";

import { createApiError, JobBoss2CancelledError, JobBoss2NetworkError } from "./errors.js";
import { readResponseBody, type JsonObject, type JsonValue } from "./json.js";

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TokenProvider {
  getAccessToken(signal?: AbortSignal): Promise<string>;
  invalidate(accessToken: string): boolean;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().default(3600),
  token_type: z.string().optional(),
});

type CachedToken = Readonly<{
  accessToken: string;
  refreshAt: number;
}>;

type PendingToken = {
  abortController: AbortController;
  promise: Promise<CachedToken>;
  waiters: number;
};

function isRecord(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redact(value: string, secrets: readonly string[]): string {
  return [...new Set(secrets)]
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, secret) =>
        secret.length > 0 ? redacted.replaceAll(secret, "[redacted]") : redacted,
      value,
    );
}

function sanitizeTokenError(value: JsonValue, secrets: readonly string[]): JsonObject {
  if (!isRecord(value)) return { detail: "The token endpoint rejected the request" };

  const sanitized: JsonObject = {};
  for (const key of ["detail", "instance", "status", "title", "type"]) {
    const candidate = value[key];
    if (
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean" ||
      candidate === null
    ) {
      sanitized[key] = typeof candidate === "string" ? redact(candidate, secrets) : candidate;
    }
  }

  return Object.keys(sanitized).length > 0
    ? sanitized
    : { detail: "The token endpoint rejected the request" };
}

function withCancellation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new JobBoss2CancelledError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new JobBoss2CancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class StaticTokenProvider implements TokenProvider {
  readonly #accessToken: string;

  constructor(accessToken: string) {
    this.#accessToken = accessToken;
  }

  getAccessToken(signal?: AbortSignal): Promise<string> {
    return signal?.aborted
      ? Promise.reject(new JobBoss2CancelledError())
      : Promise.resolve(this.#accessToken);
  }

  invalidate(_accessToken: string): boolean {
    return false;
  }
}

export type ClientCredentialsTokenProviderOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  fetcher?: Fetcher;
  now?: () => number;
  timeoutMs: number;
  tokenUrl: URL;
}>;

export class ClientCredentialsTokenProvider implements TokenProvider {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetcher: Fetcher;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #tokenUrl: URL;
  #cachedToken: CachedToken | undefined;
  #pendingToken: PendingToken | undefined;

  constructor(options: ClientCredentialsTokenProviderOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs;
    this.#tokenUrl = options.tokenUrl;
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new JobBoss2CancelledError();
    if (this.#cachedToken && this.#now() < this.#cachedToken.refreshAt) {
      return this.#cachedToken.accessToken;
    }

    let pendingToken = this.#pendingToken;
    if (!pendingToken) {
      const abortController = new AbortController();
      const promise = this.#requestToken(abortController.signal).then((token) => {
        this.#cachedToken = token;
        return token;
      });
      pendingToken = { abortController, promise, waiters: 0 };
      this.#pendingToken = pendingToken;
      const clearPending = (): void => {
        if (this.#pendingToken === pendingToken) this.#pendingToken = undefined;
      };
      void promise.then(clearPending, clearPending);
    }

    pendingToken.waiters += 1;
    try {
      return (await withCancellation(pendingToken.promise, signal)).accessToken;
    } finally {
      pendingToken.waiters -= 1;
      if (pendingToken.waiters === 0 && signal?.aborted && this.#pendingToken === pendingToken) {
        this.#pendingToken = undefined;
        pendingToken.abortController.abort();
      }
    }
  }

  invalidate(accessToken: string): boolean {
    if (this.#cachedToken?.accessToken === accessToken) this.#cachedToken = undefined;
    return true;
  }

  async #requestToken(signal: AbortSignal): Promise<CachedToken> {
    const body = new URLSearchParams({
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      grant_type: "client_credentials",
      scope: "openid",
    });

    let response: Response;
    try {
      response = await this.#fetcher(this.#tokenUrl, {
        body,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
      });
    } catch (error) {
      throw new JobBoss2NetworkError("Could not obtain a JobBOSS2 access token", {
        cause: error,
      });
    }

    let responseBody: JsonValue;
    try {
      responseBody = await readResponseBody(response);
    } catch (error) {
      throw new JobBoss2NetworkError("Could not read the JobBOSS2 token response", {
        cause: error,
      });
    }
    if (!response.ok) {
      throw createApiError(
        response.status,
        "POST",
        this.#tokenUrl.pathname,
        sanitizeTokenError(responseBody, [this.#clientId, this.#clientSecret]),
      );
    }

    const token = tokenResponseSchema.safeParse(responseBody);
    if (!token.success) {
      throw new JobBoss2NetworkError("The JobBOSS2 token endpoint returned an invalid response");
    }

    const lifetimeMs = token.data.expires_in * 1000;
    const refreshSkewMs = Math.min(60_000, Math.max(1_000, lifetimeMs * 0.1));
    return {
      accessToken: token.data.access_token,
      refreshAt: this.#now() + lifetimeMs - refreshSkewMs,
    };
  }
}
