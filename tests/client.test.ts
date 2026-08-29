import { describe, expect, it } from "vitest";

import type { Fetcher, TokenProvider } from "../src/auth.js";
import { getResourceOperation } from "../src/catalog.js";
import { JobBoss2Client } from "../src/client.js";
import { JobBoss2ApiError, JobBoss2CancelledError, JobBoss2InputError } from "../src/errors.js";

class RefreshableTokenProvider implements TokenProvider {
  calls = 0;

  getAccessToken(): Promise<string> {
    this.calls += 1;
    return Promise.resolve(`token-${this.calls}`);
  }

  invalidate(accessToken: string): boolean {
    return accessToken === "token-1";
  }
}

class SharedRefreshableTokenProvider implements TokenProvider {
  token = "stale-token";

  getAccessToken(): Promise<string> {
    return Promise.resolve(this.token);
  }

  invalidate(accessToken: string): boolean {
    if (this.token === accessToken) this.token = "fresh-token";
    return true;
  }
}

describe("JobBoss2Client", () => {
  it("encodes path parameters, query keys, and bearer authentication", async () => {
    const requests: { authorization: string | null; url: string }[] = [];
    const fetcher: Fetcher = async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ authorization: headers.get("authorization"), url: String(input) });
      return Response.json({ Data: { customerCode: "A/B" } });
    };
    const client = new JobBoss2Client({
      baseUrl: new URL("https://api.example.com"),
      fetcher,
      timeoutMs: 5_000,
      tokenProvider: {
        getAccessToken: () => Promise.resolve("secret-token"),
        invalidate: () => false,
      },
    });

    const result = await client.request({
      operation: getResourceOperation("customers", "get"),
      pathParameters: { customerCode: "A/B" },
      query: { fields: "customerCode,customerDescription" },
    });

    expect(result).toEqual({ status: 200, data: { Data: { customerCode: "A/B" } } });
    expect(requests).toEqual([
      {
        authorization: "Bearer secret-token",
        url: "https://api.example.com/api/v1/customers/A%2FB?fields=customerCode%2CcustomerDescription",
      },
    ]);
  });

  it("retries one 401 after refreshing client credentials", async () => {
    const authorizations: (string | null)[] = [];
    const fetcher: Fetcher = (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Promise.resolve(
        authorizations.length === 1
          ? Response.json({ Detail: "expired" }, { status: 401 })
          : Response.json({ Data: [] }),
      );
    };
    const tokenProvider = new RefreshableTokenProvider();
    const client = new JobBoss2Client({
      baseUrl: new URL("https://api.example.com"),
      fetcher,
      timeoutMs: 5_000,
      tokenProvider,
    });

    await expect(
      client.request({ operation: getResourceOperation("customers", "list") }),
    ).resolves.toEqual({ status: 200, data: { Data: [] } });
    expect(authorizations).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(tokenProvider.calls).toBe(2);
  });

  it("cancels the discarded 401 body before retrying", async () => {
    let bodyCancelled = false;
    let calls = 0;
    const fetcher: Fetcher = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              cancel: () => {
                bodyCancelled = true;
              },
            }),
            { status: 401 },
          ),
        );
      }
      return Promise.resolve(Response.json({ Data: [] }));
    };
    const client = new JobBoss2Client({
      baseUrl: new URL("https://api.example.com"),
      fetcher,
      timeoutMs: 5_000,
      tokenProvider: new RefreshableTokenProvider(),
    });

    await client.request({ operation: getResourceOperation("customers", "list") });
    expect(bodyCancelled).toBe(true);
  });

  it("lets concurrent stale-token reads retry with the refreshed token", async () => {
    let releaseStaleRequests: (() => void) | undefined;
    let staleRequestCount = 0;
    const staleRequestsReady = new Promise<void>((resolve) => {
      releaseStaleRequests = resolve;
    });
    const fetcher: Fetcher = async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === "Bearer stale-token") {
        staleRequestCount += 1;
        if (staleRequestCount === 2) releaseStaleRequests?.();
        await staleRequestsReady;
        return Response.json({ Detail: "expired" }, { status: 401 });
      }
      return Response.json({ Data: [] });
    };
    const client = new JobBoss2Client({
      baseUrl: new URL("https://api.example.com"),
      fetcher,
      timeoutMs: 5_000,
      tokenProvider: new SharedRefreshableTokenProvider(),
    });
    const operation = getResourceOperation("customers", "list");

    await expect(
      Promise.all([client.request({ operation }), client.request({ operation })]),
    ).resolves.toEqual([
      { data: { Data: [] }, status: 200 },
      { data: { Data: [] }, status: 200 },
    ]);
  });

  it("does not replay a write after a 401", async () => {
    let calls = 0;
    const client = new JobBoss2Client({
      baseUrl: new URL("https://api.example.com"),
      fetcher: () => {
        calls += 1;
        return Promise.resolve(Response.json({ Detail: "expired" }, { status: 401 }));
      },
      timeoutMs: 5_000,
      tokenProvider: new RefreshableTokenProvider(),
    });

    await expect(
      client.request({
        body: {},
        operation: getResourceOperation("customers", "create"),
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it("does not retry a static token or a non-401 response", async () => {
    let calls = 0;
    const fetcher: Fetcher = () => {
      calls += 1;
      return Promise.resolve(Response.json({ Detail: "failed" }, { status: 500 }));
    };
    const client = new JobBoss2Client({
      baseUrl: new URL("https://api.example.com"),
      fetcher,
      timeoutMs: 5_000,
      tokenProvider: {
        getAccessToken: () => Promise.resolve("token"),
        invalidate: () => false,
      },
    });

    const request = client.request({ operation: getResourceOperation("customers", "list") });
    await expect(request).rejects.toBeInstanceOf(JobBoss2ApiError);
    await expect(request).rejects.toMatchObject({ status: 500 });
    expect(calls).toBe(1);
  });

  it("rejects missing and unknown path parameters before making a request", async () => {
    let calls = 0;
    const client = new JobBoss2Client({
      baseUrl: new URL("https://api.example.com"),
      fetcher: () => {
        calls += 1;
        return Promise.resolve(Response.json({}));
      },
      timeoutMs: 5_000,
      tokenProvider: {
        getAccessToken: () => Promise.resolve("token"),
        invalidate: () => false,
      },
    });
    const operation = getResourceOperation("customers", "get");

    await expect(client.request({ operation })).rejects.toBeInstanceOf(JobBoss2InputError);
    await expect(
      client.request({
        operation,
        pathParameters: { customerCode: "ACME", extra: "value" },
      }),
    ).rejects.toThrow("Unknown path parameters: extra");
    await expect(
      client.request({ operation, pathParameters: { customerCode: ".." } }),
    ).rejects.toThrow("cannot be a dot segment");
    expect(calls).toBe(0);
  });

  it("propagates cancellation to the outbound request", async () => {
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const outboundSignals: AbortSignal[] = [];
    const fetcher: Fetcher = (_input, init) => {
      if (!init?.signal) throw new Error("missing request signal");
      outboundSignals.push(init.signal);
      requestStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    };
    const client = new JobBoss2Client({
      baseUrl: new URL("https://api.example.com"),
      fetcher,
      timeoutMs: 5_000,
      tokenProvider: {
        getAccessToken: () => Promise.resolve("token"),
        invalidate: () => false,
      },
    });
    const controller = new AbortController();
    const request = client.request({
      operation: getResourceOperation("customers", "list"),
      signal: controller.signal,
    });

    await started;
    controller.abort();
    await expect(request).rejects.toBeInstanceOf(JobBoss2CancelledError);
    expect(outboundSignals[0]?.aborted).toBe(true);
  });
});
