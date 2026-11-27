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
      "jobboss2_delete",
      "jobboss2_run_action",
      "jobboss2_get_view",
      "jobboss2_list_documents",
      "jobboss2_attach_document",
      "jobboss2_detach_document",
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
          path: "/api/v2/customers/{customerCode}",
          pathParameters: ["customerCode"],
        },
      },
    });

    const viewResult = await client.callTool({
      arguments: { view: "orders/backlog-summary" },
      name: "jobboss2_describe_resource",
    });
    expect(viewResult.structuredContent).toMatchObject({
      result: {
        specification: { method: "GET", path: "/api/v2/orders/backlog-summary" },
        view: "orders/backlog-summary",
      },
    });

    const conflictResult = await client.callTool({
      arguments: { resource: "quotes", view: "orders/backlog-summary" },
      name: "jobboss2_describe_resource",
    });
    expect(conflictResult.isError).toBe(true);
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
        filters: { "customerCode[in]": ["ACME", "ECI"], "customerName[cont]": "Steel" },
        includeTotalCount: true,
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
      "https://api.example.com/api/v2/customers?fields=customerCode&take=25&includeTotalCount=true&customerCode%5Bin%5D=ACME%7CECI&customerName%5Bcont%5D=Steel",
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

  it("blocks deletes, actions, and document changes before making an API request", async () => {
    let requests = 0;
    const client = await connectServer(makeConfig(), () => {
      requests += 1;
      return Promise.resolve(Response.json({}));
    });

    const calls = [
      { arguments: { keys: { orderNumber: "1001" }, resource: "orders" }, name: "jobboss2_delete" },
      {
        arguments: { action: "quotes/{quoteNumber}/copy", keys: { quoteNumber: "Q1" } },
        name: "jobboss2_run_action",
      },
      {
        arguments: { keys: { partNumber: "P1" }, repositoryId: 7, resource: "estimates" },
        name: "jobboss2_attach_document",
      },
      {
        arguments: { keys: { partNumber: "P1", repositoryId: 7 }, resource: "estimates" },
        name: "jobboss2_detach_document",
      },
    ];
    for (const call of calls) {
      const result = await client.callTool(call);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("JOBBOSS2_ALLOW_WRITES=true") }),
      ]);
    }
    expect(requests).toBe(0);
  });

  it("deletes records and runs validated actions when writes are enabled", async () => {
    const requests: { body: unknown; method: string | undefined; url: string }[] = [];
    const client = await connectServer(makeConfig({ allowWrites: true }), (input, init) => {
      requests.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        method: init?.method,
        url: String(input),
      });
      return Promise.resolve(Response.json({ data: null }));
    });

    const deleted = await client.callTool({
      arguments: { keys: { orderNumber: "1001" }, resource: "orders" },
      name: "jobboss2_delete",
    });
    expect(deleted.isError).not.toBe(true);

    const invalid = await client.callTool({
      arguments: {
        action: "quotes/{quoteNumber}/flush-discount-percent",
        data: { discountPercent: "ten" },
        keys: { quoteNumber: "Q1" },
      },
      name: "jobboss2_run_action",
    });
    expect(invalid.isError).toBe(true);

    const flushed = await client.callTool({
      arguments: {
        action: "quotes/{quoteNumber}/flush-discount-percent",
        data: { discountPercent: 10 },
        keys: { quoteNumber: "Q1" },
      },
      name: "jobboss2_run_action",
    });
    expect(flushed.isError).not.toBe(true);

    expect(requests).toEqual([
      {
        body: undefined,
        method: "DELETE",
        url: "https://api.example.com/api/v2/orders/1001",
      },
      {
        body: { discountPercent: 10 },
        method: "POST",
        url: "https://api.example.com/api/v2/quotes/Q1/flush-discount-percent",
      },
    ]);
  });

  it("gets views with documented query parameters only", async () => {
    const urls: string[] = [];
    const client = await connectServer(makeConfig(), (input) => {
      urls.push(String(input));
      return Promise.resolve(Response.json({ data: [], hasMore: false }));
    });

    const backlog = await client.callTool({
      arguments: { query: { groupBy: "customer", take: 25 }, view: "orders/backlog-summary" },
      name: "jobboss2_get_view",
    });
    expect(backlog.structuredContent).toEqual({ data: { data: [], hasMore: false }, status: 200 });

    const snapshot = await client.callTool({
      arguments: { keys: { jobNumber: "J-1" }, view: "jobs/{jobNumber}/snapshot" },
      name: "jobboss2_get_view",
    });
    expect(snapshot.isError).not.toBe(true);

    const unknown = await client.callTool({
      arguments: { query: { "status[in]": "open" }, view: "jobs" },
      name: "jobboss2_get_view",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Unknown query parameters") }),
    ]);

    expect(urls).toEqual([
      "https://api.example.com/api/v2/orders/backlog-summary?groupBy=customer&take=25",
      "https://api.example.com/api/v2/jobs/J-1/snapshot",
    ]);
  });

  it("uploads documents as multipart form data", async () => {
    const requests: { body: unknown; contentType: string | null; url: string }[] = [];
    const client = await connectServer(makeConfig({ allowWrites: true }), (input, init) => {
      requests.push({
        body: init?.body,
        contentType: new Headers(init?.headers).get("content-type"),
        url: String(input),
      });
      return Promise.resolve(Response.json({ data: { repositoryId: 42 } }, { status: 201 }));
    });

    const both = await client.callTool({
      arguments: {
        file: { base64: "aGVsbG8=", fileName: "note.txt" },
        keys: { partNumber: "P1" },
        repositoryId: 7,
        resource: "estimates",
      },
      name: "jobboss2_attach_document",
    });
    expect(both.isError).toBe(true);

    const uploaded = await client.callTool({
      arguments: {
        file: { base64: "aGVsbG8=", contentType: "text/plain", fileName: "note.txt" },
        folderId: 3,
        keys: { partNumber: "P1" },
        resource: "estimates",
      },
      name: "jobboss2_attach_document",
    });
    expect(uploaded.structuredContent).toEqual({
      data: { data: { repositoryId: 42 } },
      status: 201,
    });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe("https://api.example.com/api/v2/estimates/P1/documents");
    expect(request?.contentType).toBeNull();
    const form = request?.body;
    if (!(form instanceof FormData)) throw new Error("expected a multipart body");
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("expected an uploaded file");
    expect(file.name).toBe("note.txt");
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toBe("hello");
    expect(form.get("folderId")).toBe("3");
    expect(form.has("repositoryId")).toBe(false);
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
