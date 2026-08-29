import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import type { Fetcher } from "../src/auth.js";
import type { JobBoss2Config } from "../src/config.js";
import { createJobBoss2Server } from "../src/server.js";

const openClients: Client[] = [];

function makeConfig(overrides: Partial<JobBoss2Config> = {}): JobBoss2Config {
  return {
    allowWrites: false,
    auth: { kind: "access_token", accessToken: "test-token" },
    baseUrl: new URL("https://api.example.com"),
    enableUndocumented: false,
    requestTimeoutMs: 5_000,
    ...overrides,
  };
}

async function connectServer(config: JobBoss2Config, fetcher: Fetcher): Promise<Client> {
  const server = createJobBoss2Server(config, { fetcher });
  const client = new Client({ name: "jobboss2-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe("JobBOSS2 MCP server", () => {
  it("lists focused tools and describes resources without an API request", async () => {
    let requests = 0;
    const client = await connectServer(makeConfig(), () => {
      requests += 1;
      return Promise.resolve(Response.json({}));
    });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "jobboss2_describe_resource",
      "jobboss2_list",
      "jobboss2_get",
      "jobboss2_create",
      "jobboss2_update",
      "jobboss2_issuing_materials_lookup",
      "jobboss2_transfer_stock_to_job",
      "jobboss2_create_report",
      "jobboss2_get_report",
    ]);
    expect(
      tools.find((tool) => tool.name === "jobboss2_describe_resource")?.outputSchema,
    ).toMatchObject({
      properties: { result: { type: "object" } },
      type: "object",
    });

    const result = await client.callTool({
      arguments: { operation: "get", resource: "customers" },
      name: "jobboss2_describe_resource",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        name: "customers",
        operation: "get",
        specification: {
          method: "GET",
          path: "/api/v1/customers/{customerCode}",
          pathParameters: ["customerCode"],
        },
      },
    });
    expect(requests).toBe(0);
  });

  it("executes list calls with JobBOSS2 filter serialization", async () => {
    const urls: string[] = [];
    const client = await connectServer(makeConfig(), (input) => {
      urls.push(String(input));
      return Promise.resolve(Response.json({ Data: [{ customerCode: "ACME" }] }));
    });

    const result = await client.callTool({
      arguments: {
        fields: ["customerCode"],
        filters: { "customerCode[in]": ["ACME", "ECI"] },
        resource: "customers",
        take: 25,
      },
      name: "jobboss2_list",
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      data: { Data: [{ customerCode: "ACME" }] },
      status: 200,
    });
    expect(urls).toEqual([
      "https://api.example.com/api/v1/customers?fields=customerCode&take=25&customerCode%5Bin%5D=ACME%7CECI",
    ]);
  });

  it("blocks writes before making an API request", async () => {
    let requests = 0;
    const client = await connectServer(makeConfig(), () => {
      requests += 1;
      return Promise.resolve(Response.json({}));
    });

    const result = await client.callTool({
      arguments: { data: {}, resource: "customers" },
      name: "jobboss2_create",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("JOBBOSS2_ALLOW_WRITES=true") }),
    ]);
    expect(requests).toBe(0);
  });

  it("registers undocumented operations only when explicitly enabled", async () => {
    const client = await connectServer(makeConfig({ enableUndocumented: true }), () =>
      Promise.resolve(Response.json({})),
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("jobboss2_undocumented_request");
  });

  it("propagates MCP cancellation to the API request", async () => {
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const outboundSignals: AbortSignal[] = [];
    const client = await connectServer(makeConfig(), (_input, init) => {
      if (!init?.signal) throw new Error("missing request signal");
      outboundSignals.push(init.signal);
      requestStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const controller = new AbortController();
    const call = client.callTool(
      { arguments: { resource: "customers", take: 1 }, name: "jobboss2_list" },
      undefined,
      { signal: controller.signal },
    );

    await started;
    controller.abort();
    await expect(call).rejects.toThrow();
    expect(outboundSignals[0]?.aborted).toBe(true);
  });
});
