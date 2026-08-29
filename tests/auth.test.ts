import { describe, expect, it } from "vitest";

import { ClientCredentialsTokenProvider, StaticTokenProvider, type Fetcher } from "../src/auth.js";
import { JobBoss2ApiError, JobBoss2CancelledError, JobBoss2NetworkError } from "../src/errors.js";

describe("StaticTokenProvider", () => {
  it("returns its token and cannot refresh it", async () => {
    const provider = new StaticTokenProvider("token");
    await expect(provider.getAccessToken()).resolves.toBe("token");
    expect(provider.invalidate("token")).toBe(false);
  });

  it("honors cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new StaticTokenProvider("token").getAccessToken(controller.signal),
    ).rejects.toBeInstanceOf(JobBoss2CancelledError);
  });
});

describe("ClientCredentialsTokenProvider", () => {
  it("uses the documented client credentials form and caches the token", async () => {
    const requests: { body: string; url: string }[] = [];
    const fetcher: Fetcher = async (input, init) => {
      requests.push({ body: String(init?.body), url: String(input) });
      return Response.json({ access_token: "first-token", expires_in: 3600 });
    };
    const provider = new ClientCredentialsTokenProvider({
      clientId: "client id",
      clientSecret: "secret/value",
      fetcher,
      now: () => 1_000,
      timeoutMs: 5_000,
      tokenUrl: new URL("https://auth.example.com/oauth2/api-user/token"),
    });

    await expect(
      Promise.all([provider.getAccessToken(), provider.getAccessToken()]),
    ).resolves.toEqual(["first-token", "first-token"]);
    await expect(provider.getAccessToken()).resolves.toBe("first-token");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://auth.example.com/oauth2/api-user/token");
    expect(new URLSearchParams(requests[0]?.body)).toEqual(
      new URLSearchParams({
        client_id: "client id",
        client_secret: "secret/value",
        grant_type: "client_credentials",
        scope: "openid",
      }),
    );
  });

  it("refreshes an invalidated token", async () => {
    let calls = 0;
    const fetcher: Fetcher = () => {
      calls += 1;
      return Promise.resolve(Response.json({ access_token: `token-${calls}`, expires_in: 3600 }));
    };
    const provider = new ClientCredentialsTokenProvider({
      clientId: "client",
      clientSecret: "client-secret",
      fetcher,
      timeoutMs: 5_000,
      tokenUrl: new URL("https://auth.example.com/token"),
    });

    await expect(provider.getAccessToken()).resolves.toBe("token-1");
    expect(provider.invalidate("different-token")).toBe(true);
    await expect(provider.getAccessToken()).resolves.toBe("token-1");
    expect(provider.invalidate("token-1")).toBe(true);
    await expect(provider.getAccessToken()).resolves.toBe("token-2");
  });

  it("returns API errors from the token endpoint", async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(
        Response.json(
          {
            client_secret: "secret",
            detail: "bad credentials for client and client-secret",
            echoed: "secret",
          },
          { status: 401 },
        ),
      );
    const provider = new ClientCredentialsTokenProvider({
      clientId: "client",
      clientSecret: "client-secret",
      fetcher,
      timeoutMs: 5_000,
      tokenUrl: new URL("https://auth.example.com/token"),
    });

    const tokenRequest = provider.getAccessToken();
    await expect(tokenRequest).rejects.toBeInstanceOf(JobBoss2ApiError);
    await expect(tokenRequest).rejects.toMatchObject({
      message: "JobBOSS2 returned HTTP 401: bad credentials for [redacted] and [redacted]",
      status: 401,
    });
    await expect(tokenRequest).rejects.not.toHaveProperty("response.client_secret");
    await expect(tokenRequest).rejects.not.toHaveProperty("response.echoed");
    await expect(tokenRequest).rejects.not.toHaveProperty(
      "message",
      expect.stringContaining("-secret"),
    );
  });

  it("rejects malformed token responses", async () => {
    const fetcher: Fetcher = () => Promise.resolve(Response.json({ expires_in: 3600 }));
    const provider = new ClientCredentialsTokenProvider({
      clientId: "id",
      clientSecret: "secret",
      fetcher,
      timeoutMs: 5_000,
      tokenUrl: new URL("https://auth.example.com/token"),
    });

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(JobBoss2NetworkError);
  });

  it("aborts an unshared token request when its caller cancels", async () => {
    const outboundSignals: AbortSignal[] = [];
    const fetcher: Fetcher = (_input, init) => {
      if (!init?.signal) throw new Error("missing token request signal");
      outboundSignals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    };
    const provider = new ClientCredentialsTokenProvider({
      clientId: "id",
      clientSecret: "secret",
      fetcher,
      timeoutMs: 5_000,
      tokenUrl: new URL("https://auth.example.com/token"),
    });
    const controller = new AbortController();
    const tokenRequest = provider.getAccessToken(controller.signal);

    controller.abort();
    await expect(tokenRequest).rejects.toBeInstanceOf(JobBoss2CancelledError);
    expect(outboundSignals[0]?.aborted).toBe(true);
  });
});
