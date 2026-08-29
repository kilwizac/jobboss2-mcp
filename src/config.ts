import { z } from "zod";

import { catalog } from "./catalog.js";
import { ConfigurationError } from "./errors.js";

const DEFAULT_TOKEN_URL =
  "https://api-user.integrations.ecimanufacturing.com/oauth2/api-user/token";

const optionalSecretSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const booleanSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const timeoutSchema = z
  .string()
  .regex(/^\d+$/, "must be an integer")
  .transform(Number)
  .pipe(z.number().int().min(100).max(300_000))
  .default(30_000);

const environmentSchema = z.object({
  JOBBOSS2_ACCESS_TOKEN: optionalSecretSchema,
  JOBBOSS2_ALLOW_WRITES: booleanSchema,
  JOBBOSS2_BASE_URL: z.string().min(1).default(catalog.api.serverUrl),
  JOBBOSS2_CLIENT_ID: optionalSecretSchema,
  JOBBOSS2_CLIENT_SECRET: optionalSecretSchema,
  JOBBOSS2_ENABLE_UNDOCUMENTED: booleanSchema,
  JOBBOSS2_REQUEST_TIMEOUT_MS: timeoutSchema,
  JOBBOSS2_TOKEN_URL: z.string().min(1).default(DEFAULT_TOKEN_URL),
});

export type AuthConfig =
  | { kind: "access_token"; accessToken: string }
  | { kind: "client_credentials"; clientId: string; clientSecret: string; tokenUrl: URL };

export type JobBoss2Config = Readonly<{
  allowWrites: boolean;
  auth: AuthConfig;
  baseUrl: URL;
  enableUndocumented: boolean;
  requestTimeoutMs: number;
}>;

export type JobBoss2Environment = Readonly<Record<string, string | undefined>>;

function parseUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be a valid URL`);
  }

  const isLoopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new ConfigurationError(`${name} must use HTTPS unless it targets localhost`);
  }
  if (url.username || url.password) {
    throw new ConfigurationError(`${name} must not contain credentials`);
  }
  if (url.search || url.hash) {
    throw new ConfigurationError(`${name} must not contain a query string or fragment`);
  }

  return url;
}

export function loadConfig(environment: JobBoss2Environment = process.env): JobBoss2Config {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigurationError(z.prettifyError(parsed.error));
  }

  const values = parsed.data;
  const hasClientId = values.JOBBOSS2_CLIENT_ID !== undefined;
  const hasClientSecret = values.JOBBOSS2_CLIENT_SECRET !== undefined;

  if (values.JOBBOSS2_ACCESS_TOKEN && (hasClientId || hasClientSecret)) {
    throw new ConfigurationError(
      "Set JOBBOSS2_ACCESS_TOKEN or JOBBOSS2_CLIENT_ID and JOBBOSS2_CLIENT_SECRET, not both",
    );
  }

  let auth: AuthConfig;
  if (values.JOBBOSS2_ACCESS_TOKEN) {
    auth = { kind: "access_token", accessToken: values.JOBBOSS2_ACCESS_TOKEN };
  } else if (values.JOBBOSS2_CLIENT_ID && values.JOBBOSS2_CLIENT_SECRET) {
    auth = {
      kind: "client_credentials",
      clientId: values.JOBBOSS2_CLIENT_ID,
      clientSecret: values.JOBBOSS2_CLIENT_SECRET,
      tokenUrl: parseUrl(values.JOBBOSS2_TOKEN_URL, "JOBBOSS2_TOKEN_URL"),
    };
  } else if (hasClientId || hasClientSecret) {
    throw new ConfigurationError(
      "JOBBOSS2_CLIENT_ID and JOBBOSS2_CLIENT_SECRET must be set together",
    );
  } else {
    throw new ConfigurationError(
      "Set JOBBOSS2_ACCESS_TOKEN or JOBBOSS2_CLIENT_ID and JOBBOSS2_CLIENT_SECRET",
    );
  }

  const baseUrl = parseUrl(values.JOBBOSS2_BASE_URL, "JOBBOSS2_BASE_URL");
  if (baseUrl.pathname !== "/") {
    throw new ConfigurationError("JOBBOSS2_BASE_URL must not contain a path");
  }

  return {
    allowWrites: values.JOBBOSS2_ALLOW_WRITES,
    auth,
    baseUrl,
    enableUndocumented: values.JOBBOSS2_ENABLE_UNDOCUMENTED,
    requestTimeoutMs: values.JOBBOSS2_REQUEST_TIMEOUT_MS,
  };
}
