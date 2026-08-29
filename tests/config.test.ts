import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { ConfigurationError } from "../src/errors.js";

describe("loadConfig", () => {
  it("loads client credentials with safe defaults", () => {
    const config = loadConfig({
      JOBBOSS2_CLIENT_ID: "client-id",
      JOBBOSS2_CLIENT_SECRET: "client-secret",
    });

    expect(config).toMatchObject({
      allowWrites: false,
      auth: {
        kind: "client_credentials",
        clientId: "client-id",
        clientSecret: "client-secret",
      },
      enableUndocumented: false,
      requestTimeoutMs: 30_000,
    });
    expect(config.baseUrl.href).toBe("https://api-jb2.integrations.ecimanufacturing.com/");
    if (config.auth.kind !== "client_credentials") throw new Error("unexpected auth kind");
    expect(config.auth.tokenUrl.href).toBe(
      "https://api-user.integrations.ecimanufacturing.com/oauth2/api-user/token",
    );
  });

  it("loads a static access token and explicit options", () => {
    const config = loadConfig({
      JOBBOSS2_ACCESS_TOKEN: "access-token",
      JOBBOSS2_ALLOW_WRITES: "true",
      JOBBOSS2_BASE_URL: "http://localhost:8787",
      JOBBOSS2_ENABLE_UNDOCUMENTED: "true",
      JOBBOSS2_REQUEST_TIMEOUT_MS: "5000",
    });

    expect(config).toEqual({
      allowWrites: true,
      auth: { kind: "access_token", accessToken: "access-token" },
      baseUrl: new URL("http://localhost:8787"),
      enableUndocumented: true,
      requestTimeoutMs: 5000,
    });
  });

  it("allows plain HTTP on IPv4 and IPv6 loopback only", () => {
    expect(
      loadConfig({
        JOBBOSS2_ACCESS_TOKEN: "token",
        JOBBOSS2_BASE_URL: "http://127.0.0.1:8787",
      }).baseUrl.href,
    ).toBe("http://127.0.0.1:8787/");
    expect(
      loadConfig({
        JOBBOSS2_ACCESS_TOKEN: "token",
        JOBBOSS2_BASE_URL: "http://[::1]:8787",
      }).baseUrl.href,
    ).toBe("http://[::1]:8787/");
  });

  it.each([
    [{}, "Set JOBBOSS2_ACCESS_TOKEN"],
    [{ JOBBOSS2_CLIENT_ID: "id" }, "must be set together"],
    [
      {
        JOBBOSS2_ACCESS_TOKEN: "token",
        JOBBOSS2_CLIENT_ID: "id",
        JOBBOSS2_CLIENT_SECRET: "secret",
      },
      "not both",
    ],
    [{ JOBBOSS2_ACCESS_TOKEN: "token", JOBBOSS2_BASE_URL: "http://example.com" }, "must use HTTPS"],
    [
      { JOBBOSS2_ACCESS_TOKEN: "token", JOBBOSS2_BASE_URL: "https://example.com/api" },
      "must not contain a path",
    ],
    [
      { JOBBOSS2_ACCESS_TOKEN: "token", JOBBOSS2_BASE_URL: "https://user@example.com" },
      "must not contain credentials",
    ],
    [
      { JOBBOSS2_ACCESS_TOKEN: "token", JOBBOSS2_BASE_URL: "https://example.com?x=1" },
      "must not contain a query string",
    ],
  ])("rejects invalid configuration %#", (environment, message) => {
    expect(() => loadConfig(environment)).toThrowError(ConfigurationError);
    expect(() => loadConfig(environment)).toThrow(message);
  });
});
