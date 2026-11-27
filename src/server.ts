import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  ClientCredentialsTokenProvider,
  StaticTokenProvider,
  type Fetcher,
  type TokenProvider,
} from "./auth.js";
import {
  actionNames,
  catalog,
  createResourceNames,
  deleteResourceNames,
  documentResourceNames,
  getDocumentOperation,
  getResourceNames,
  getResourceOperation,
  issuingMaterialLookupNames,
  listResourceNames,
  resourceNames,
  stringEnum,
  undocumentedOperationNames,
  updateResourceNames,
  viewNames,
  type CatalogOperation,
  type ResourceOperation,
} from "./catalog.js";
import { JobBoss2Client, apiResultSchema, type QueryValue } from "./client.js";
import type { JobBoss2Config } from "./config.js";
import { JobBoss2CancelledError, JobBoss2InputError, toToolError } from "./errors.js";
import type { JsonObject, JsonValue } from "./json.js";
import {
  buildFieldsQuery,
  buildListQuery,
  catalogResultSchema,
  fieldsSchema,
  jsonObjectSchema,
  listOptionsSchema,
  pathParametersSchema,
  queryParametersSchema,
  toApiToolResult,
  toCatalogToolResult,
} from "./tool-helpers.js";
import { RequestBodyValidator } from "./validation.js";
import { SERVER_VERSION } from "./version.js";

export type CreateJobBoss2ServerOptions = Readonly<{
  fetcher?: Fetcher;
}>;

type ToolContext = Readonly<{
  allowWrites: boolean;
  client: JobBoss2Client;
  validator: RequestBodyValidator;
}>;

const resourceOperationSchema = z.enum(["create", "delete", "get", "list", "update"]);

const documentFileSchema = z.object({
  base64: z.base64(),
  contentType: z.string().min(1).optional(),
  fileName: z.string().min(1),
});

type DescribeInput = Readonly<{
  action?: string | undefined;
  operation?: ResourceOperation | undefined;
  resource?: string | undefined;
  view?: string | undefined;
}>;

type AttachDocumentInput = Readonly<{
  file?: z.infer<typeof documentFileSchema> | undefined;
  folderId?: number | undefined;
  repositoryId?: number | undefined;
}>;

function createTokenProvider(config: JobBoss2Config, fetcher?: Fetcher): TokenProvider {
  if (config.auth.kind === "access_token") {
    return new StaticTokenProvider(config.auth.accessToken);
  }

  return new ClientCredentialsTokenProvider({
    clientId: config.auth.clientId,
    clientSecret: config.auth.clientSecret,
    ...(fetcher ? { fetcher } : {}),
    timeoutMs: config.requestTimeoutMs,
    tokenUrl: config.auth.tokenUrl,
  });
}

function requireWrites(context: ToolContext): void {
  if (!context.allowWrites) {
    throw new JobBoss2InputError(
      "Write tools are disabled. Set JOBBOSS2_ALLOW_WRITES=true to enable them.",
    );
  }
}

async function runApiCall(call: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof JobBoss2CancelledError) throw error;
    return toToolError(error);
  }
}

function validateBody(context: ToolContext, operation: CatalogOperation, body: JsonValue): void {
  context.validator.validate(operation, body);
}

function operationDescription(operation: CatalogOperation): JsonObject {
  return {
    bodyRequired: operation.bodyRequired,
    description: operation.description,
    method: operation.method,
    path: operation.path,
    pathParameters: operation.pathParameters,
    queryParameters: operation.queryParameters,
    requestContentType: operation.requestContentType,
    requestSchema: operation.requestSchema,
    responseStatuses: operation.responseStatuses,
    summary: operation.summary,
  };
}

function describeCatalog({
  action,
  operation: operationName,
  resource: resourceName,
  view,
}: DescribeInput): JsonObject {
  if ([action, resourceName, view].filter((name) => name !== undefined).length > 1) {
    throw new JobBoss2InputError("Provide only one of resource, action, or view");
  }
  if (operationName && !resourceName) {
    throw new JobBoss2InputError("resource is required when operation is provided");
  }

  if (action) {
    const operation = catalog.actions[action];
    if (!operation) throw new JobBoss2InputError(`Unknown action ${action}`);
    return { action, specification: operationDescription(operation) };
  }

  if (view) {
    const operation = catalog.views[view];
    if (!operation) throw new JobBoss2InputError(`Unknown view ${view}`);
    return { specification: operationDescription(operation), view };
  }

  if (!resourceName) {
    return {
      actions: Object.entries(catalog.actions).map(([name, operation]) => ({
        name,
        summary: operation.summary,
      })),
      api: catalog.api,
      documentationUrl: catalog.documentationUrl,
      issuingMaterialOperations: Object.keys(catalog.issuingMaterials),
      reportOperations: Object.keys(catalog.reports),
      resources: Object.entries(catalog.resources).map(([name, resource]) => ({
        name,
        operations: Object.keys(resource.operations),
        ...(catalog.documents[name] ? { documents: true } : {}),
        title: resource.title,
      })),
      sourceUrl: catalog.sourceUrl,
      views: Object.entries(catalog.views).map(([name, operation]) => ({
        name,
        summary: operation.summary,
      })),
    };
  }

  const resource = catalog.resources[resourceName];
  if (!resource) throw new JobBoss2InputError(`Unknown resource ${resourceName}`);

  if (operationName) {
    const operation = resource.operations[operationName];
    if (!operation) {
      throw new JobBoss2InputError(`${resourceName} does not support ${operationName}`);
    }
    return {
      name: resourceName,
      operation: operationName,
      specification: operationDescription(operation),
      title: resource.title,
    };
  }

  const operations: JsonObject = {};
  for (const [name, operation] of Object.entries(resource.operations)) {
    if (operation) operations[name] = operationDescription(operation);
  }

  const documentOperations = catalog.documents[resourceName];
  return {
    ...(documentOperations
      ? {
          documents: Object.fromEntries(
            Object.entries(documentOperations).map(([name, operation]) => [
              name,
              operationDescription(operation),
            ]),
          ),
        }
      : {}),
    name: resourceName,
    operations,
    title: resource.title,
  };
}

function toDocumentForm({ file, folderId, repositoryId }: AttachDocumentInput): FormData {
  if ((file === undefined) === (repositoryId === undefined)) {
    throw new JobBoss2InputError("Provide either file or repositoryId");
  }
  if (folderId !== undefined && file === undefined) {
    throw new JobBoss2InputError("folderId applies only to an uploaded file");
  }

  const form = new FormData();
  if (repositoryId !== undefined) form.append("repositoryId", String(repositoryId));
  if (file) {
    const bytes = Uint8Array.from(Buffer.from(file.base64, "base64"));
    const blob = new Blob([bytes], { type: file.contentType ?? "application/octet-stream" });
    form.append("file", blob, file.fileName);
  }
  if (folderId !== undefined) form.append("folderId", String(folderId));
  return form;
}

function assertKnownQueryParameters(
  operation: CatalogOperation,
  query: Readonly<Record<string, QueryValue>>,
): void {
  const expected = new Set(operation.queryParameters.map((parameter) => parameter.name));
  const unknown = Object.keys(query).filter((name) => !expected.has(name));
  if (unknown.length > 0) {
    throw new JobBoss2InputError(`Unknown query parameters: ${unknown.join(", ")}`);
  }
}

function registerResourceTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "jobboss2_describe_resource",
    {
      annotations: { idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description:
        "List JobBOSS2 resources, views, and actions, or inspect one resource, view, or action's paths, keys, query parameters, and request schema. Call this before writes and before views whose query parameters you do not know.",
      inputSchema: z.object({
        action: stringEnum(actionNames).optional(),
        operation: resourceOperationSchema.optional(),
        resource: stringEnum(resourceNames).optional(),
        view: stringEnum(viewNames).optional(),
      }),
      outputSchema: catalogResultSchema,
      title: "Describe JobBOSS2 resource",
    },
    async (input) => {
      try {
        return toCatalogToolResult(describeCatalog(input));
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "jobboss2_list",
    {
      annotations: { idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description:
        "List a JobBOSS2 resource with documented fields, filters, sorting, and offset paging. Filter keys use field[operator], where operator is eq, ne, gte, lte, gt, lt, in, notin, null, cont, ncont, sw, or ew. Results carry hasMore when more rows exist; set includeTotalCount only when the number of matching rows is needed. For counts, rankings, and totals prefer jobboss2_get_view.",
      inputSchema: listOptionsSchema.extend({ resource: stringEnum(listResourceNames) }),
      outputSchema: apiResultSchema,
      title: "List JobBOSS2 records",
    },
    async ({ resource, ...options }, { signal }) =>
      runApiCall(async () => {
        const operation = getResourceOperation(resource, "list");
        const result = await context.client.request({
          operation,
          query: buildListQuery(options),
          signal,
        });
        return toApiToolResult(result);
      }),
  );

  server.registerTool(
    "jobboss2_get",
    {
      annotations: { idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description:
        "Get one JobBOSS2 record. Use jobboss2_describe_resource to find the exact key names required by the resource.",
      inputSchema: z.object({
        fields: fieldsSchema,
        keys: pathParametersSchema,
        resource: stringEnum(getResourceNames),
      }),
      outputSchema: apiResultSchema,
      title: "Get a JobBOSS2 record",
    },
    async ({ fields, keys, resource }, { signal }) =>
      runApiCall(async () => {
        const result = await context.client.request({
          operation: getResourceOperation(resource, "get"),
          pathParameters: keys,
          query: buildFieldsQuery(fields),
          signal,
        });
        return toApiToolResult(result);
      }),
  );

  server.registerTool(
    "jobboss2_create",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Create a JobBOSS2 record. Request data is checked against ECI's OpenAPI schema. Use jobboss2_describe_resource first to inspect required parent keys and fields.",
      inputSchema: z.object({
        data: jsonObjectSchema,
        parentKeys: pathParametersSchema.default({}),
        resource: stringEnum(createResourceNames),
      }),
      outputSchema: apiResultSchema,
      title: "Create a JobBOSS2 record",
    },
    async ({ data, parentKeys, resource }, { signal }) =>
      runApiCall(async () => {
        requireWrites(context);
        const operation = getResourceOperation(resource, "create");
        validateBody(context, operation, data);
        const result = await context.client.request({
          body: data,
          operation,
          pathParameters: parentKeys,
          signal,
        });
        return toApiToolResult(result);
      }),
  );

  server.registerTool(
    "jobboss2_update",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Patch a JobBOSS2 record. Request data is checked against ECI's OpenAPI schema. Use jobboss2_describe_resource first to inspect key names and writable fields.",
      inputSchema: z.object({
        data: jsonObjectSchema,
        keys: pathParametersSchema,
        resource: stringEnum(updateResourceNames),
      }),
      outputSchema: apiResultSchema,
      title: "Update a JobBOSS2 record",
    },
    async ({ data, keys, resource }, { signal }) =>
      runApiCall(async () => {
        requireWrites(context);
        const operation = getResourceOperation(resource, "update");
        validateBody(context, operation, data);
        const result = await context.client.request({
          body: data,
          operation,
          pathParameters: keys,
          signal,
        });
        return toApiToolResult(result);
      }),
  );

  server.registerTool(
    "jobboss2_delete",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Delete a JobBOSS2 record such as an order, order line item, quote, quote line item, estimate, estimate routing step or material, or AP/AR invoice or invoice line. Use jobboss2_describe_resource to find the exact key names. Confirm with the user first.",
      inputSchema: z.object({
        keys: pathParametersSchema,
        resource: stringEnum(deleteResourceNames),
      }),
      outputSchema: apiResultSchema,
      title: "Delete a JobBOSS2 record",
    },
    async ({ keys, resource }, { signal }) =>
      runApiCall(async () => {
        requireWrites(context);
        const result = await context.client.request({
          operation: getResourceOperation(resource, "delete"),
          pathParameters: keys,
          signal,
        });
        return toApiToolResult(result);
      }),
  );

  server.registerTool(
    "jobboss2_run_action",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Run a JobBOSS2 record action: copy a quote or AP/AR invoice, create an unprocessed packing list from an order, process or unprocess a packing list, set the status of every quote line, or apply a discount percent to every quote line. Request data is checked against ECI's OpenAPI schema; use jobboss2_describe_resource with action first. Actions change JobBOSS2 data and are not safe to retry blindly.",
      inputSchema: z.object({
        action: stringEnum(actionNames),
        data: jsonObjectSchema.default({}),
        keys: pathParametersSchema,
      }),
      outputSchema: apiResultSchema,
      title: "Run a JobBOSS2 record action",
    },
    async ({ action, data, keys }, { signal }) =>
      runApiCall(async () => {
        requireWrites(context);
        const operation = catalog.actions[action];
        if (!operation) throw new JobBoss2InputError(`Unknown action ${action}`);
        validateBody(context, operation, data);
        const result = await context.client.request({
          body: data,
          operation,
          pathParameters: keys,
          signal,
        });
        return toApiToolResult(result);
      }),
  );
}

function registerViewTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "jobboss2_get_view",
    {
      annotations: { idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description:
        "Get a JobBOSS2 rollup, snapshot, worklist, or session view from ECI's agent-helper endpoints, such as orders/backlog-summary, jobs/{jobNumber}/snapshot, labor/hours-summary, or me/capabilities. Prefer views to paging list tools for counts, rankings, and totals. Put path keys in keys and the view's documented query parameters in query; jobboss2_describe_resource with view lists them. Many views need a JobBOSS2 report privilege, so do not retry a 403.",
      inputSchema: z.object({
        keys: pathParametersSchema.default({}),
        query: queryParametersSchema.default({}),
        view: stringEnum(viewNames),
      }),
      outputSchema: apiResultSchema,
      title: "Get a JobBOSS2 view",
    },
    async ({ keys, query, view }, { signal }) =>
      runApiCall(async () => {
        const operation = catalog.views[view];
        if (!operation) throw new JobBoss2InputError(`Unknown view ${view}`);
        assertKnownQueryParameters(operation, query);
        const result = await context.client.request({
          operation,
          pathParameters: keys,
          query,
          signal,
        });
        return toApiToolResult(result);
      }),
  );
}

function registerDocumentTools(server: McpServer, context: ToolContext): void {
  const resource = stringEnum(documentResourceNames);

  server.registerTool(
    "jobboss2_list_documents",
    {
      annotations: { idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description:
        "List the documents attached to an estimate, order line item, quote line item, AR invoice line, or AP invoice. Use jobboss2_describe_resource to find the record's key names.",
      inputSchema: z.object({ keys: pathParametersSchema, resource }),
      outputSchema: apiResultSchema,
      title: "List JobBOSS2 record documents",
    },
    async ({ keys, resource: resourceName }, { signal }) =>
      runApiCall(async () => {
        const result = await context.client.request({
          operation: getDocumentOperation(resourceName, "list"),
          pathParameters: keys,
          signal,
        });
        return toApiToolResult(result);
      }),
  );

  server.registerTool(
    "jobboss2_attach_document",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Attach a document to an estimate, order line item, quote line item, AR invoice line, or AP invoice. Send repositoryId to link a file already in the JobBOSS2 document repository, or file with base64 content to upload a new one, optionally into folderId from the repository-folders view.",
      inputSchema: z.object({
        file: documentFileSchema.optional(),
        folderId: z.number().int().positive().optional(),
        keys: pathParametersSchema,
        repositoryId: z.number().int().positive().optional(),
        resource,
      }),
      outputSchema: apiResultSchema,
      title: "Attach a JobBOSS2 document",
    },
    async ({ keys, resource: resourceName, ...document }, { signal }) =>
      runApiCall(async () => {
        requireWrites(context);
        const result = await context.client.request({
          body: toDocumentForm(document),
          operation: getDocumentOperation(resourceName, "attach"),
          pathParameters: keys,
          signal,
        });
        return toApiToolResult(result);
      }),
  );

  server.registerTool(
    "jobboss2_detach_document",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Remove a document link from an estimate, order line item, quote line item, AR invoice line, or AP invoice. keys must include the record keys and the document's repositoryId from jobboss2_list_documents.",
      inputSchema: z.object({ keys: pathParametersSchema, resource }),
      outputSchema: apiResultSchema,
      title: "Detach a JobBOSS2 document",
    },
    async ({ keys, resource: resourceName }, { signal }) =>
      runApiCall(async () => {
        requireWrites(context);
        const result = await context.client.request({
          operation: getDocumentOperation(resourceName, "detach"),
          pathParameters: keys,
          signal,
        });
        return toApiToolResult(result);
      }),
  );
}

function registerIssuingMaterialTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "jobboss2_issuing_materials_lookup",
    {
      annotations: { idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description:
        "List issuing-material bin locations, job numbers, or routing steps with standard JobBOSS2 filters and paging.",
      inputSchema: listOptionsSchema.extend({
        lookup: stringEnum(issuingMaterialLookupNames),
      }),
      outputSchema: apiResultSchema,
      title: "Look up issuing materials",
    },
    async ({ lookup, ...options }, { signal }) =>
      runApiCall(async () => {
        const operation = catalog.issuingMaterials[lookup];
        if (!operation) throw new JobBoss2InputError(`Unknown issuing-material lookup ${lookup}`);
        const result = await context.client.request({
          operation,
          query: buildListQuery(options),
          signal,
        });
        return toApiToolResult(result);
      }),
  );

  server.registerTool(
    "jobboss2_transfer_stock_to_job",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Transfer stock material to a job. This changes bin quantities and can create job materials, inventory transactions, and job requirements. It is not safe to retry blindly.",
      inputSchema: z.object({ data: jsonObjectSchema }),
      outputSchema: apiResultSchema,
      title: "Transfer stock to a job",
    },
    async ({ data }, { signal }) =>
      runApiCall(async () => {
        requireWrites(context);
        const operation = catalog.issuingMaterials["transfer_stock_to_job"];
        if (!operation) throw new Error("Stock transfer operation is missing from the catalog");
        validateBody(context, operation, data);
        const result = await context.client.request({ body: data, operation, signal });
        return toApiToolResult(result);
      }),
  );
}

function registerReportTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "jobboss2_create_report",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Submit a JobBOSS2 report request. ECI's current OpenAPI document does not define this request body's fields or response schema.",
      inputSchema: z.object({ data: jsonObjectSchema.default({}) }),
      outputSchema: apiResultSchema,
      title: "Create a JobBOSS2 report",
    },
    async ({ data }, { signal }) =>
      runApiCall(async () => {
        requireWrites(context);
        const operation = catalog.reports["create"];
        if (!operation) throw new Error("Report create operation is missing from the catalog");
        const result = await context.client.request({ body: data, operation, signal });
        return toApiToolResult(result);
      }),
  );

  server.registerTool(
    "jobboss2_get_report",
    {
      annotations: { idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description:
        "Get a previously submitted JobBOSS2 report by request ID. ECI's current OpenAPI document does not define the response schema.",
      inputSchema: z.object({ requestId: z.string().min(1) }),
      outputSchema: apiResultSchema,
      title: "Get a JobBOSS2 report",
    },
    async ({ requestId }, { signal }) =>
      runApiCall(async () => {
        const operation = catalog.reports["get"];
        if (!operation) throw new Error("Report get operation is missing from the catalog");
        const result = await context.client.request({
          operation,
          pathParameters: { requestId },
          signal,
        });
        return toApiToolResult(result);
      }),
  );
}

function registerUndocumentedTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "jobboss2_undocumented_request",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Call an APS or ShopView operation that ECI's OpenAPI document lists without request or response schemas. Use only with separate ECI documentation.",
      inputSchema: z.object({
        body: z.json().optional(),
        operation: stringEnum(undocumentedOperationNames),
        pathParameters: pathParametersSchema.default({}),
        query: queryParametersSchema.default({}),
      }),
      outputSchema: apiResultSchema,
      title: "Call an undocumented JobBOSS2 operation",
    },
    async ({ body, operation: operationName, pathParameters, query }, { signal }) =>
      runApiCall(async () => {
        const operation = catalog.undocumented[operationName];
        if (!operation) throw new JobBoss2InputError(`Unknown operation ${operationName}`);
        if (operation.method !== "GET") requireWrites(context);
        assertKnownQueryParameters(operation, query);
        if (body !== undefined) validateBody(context, operation, body);
        const result = await context.client.request({
          ...(body === undefined ? {} : { body }),
          operation,
          pathParameters,
          query,
          signal,
        });
        return toApiToolResult(result);
      }),
  );
}

export function createJobBoss2Server(
  config: JobBoss2Config,
  options: CreateJobBoss2ServerOptions = {},
): McpServer {
  const tokenProvider = createTokenProvider(config, options.fetcher);
  const client = new JobBoss2Client({
    baseUrl: config.baseUrl,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    timeoutMs: config.requestTimeoutMs,
    tokenProvider,
  });
  const context: ToolContext = {
    allowWrites: config.allowWrites,
    client,
    validator: new RequestBodyValidator(),
  };
  const server = new McpServer(
    { name: "jobboss2-mcp", version: SERVER_VERSION },
    {
      instructions:
        "Call jobboss2_get_view with me/capabilities once per session, and with me/calendar-context before answering about a relative period such as last week or year to date. Prefer views to paging list tools for counts, rankings, and totals. Use jobboss2_describe_resource before writes. JobBOSS2 dates are UTC. Page list calls with skip and take while hasMore is true. Do not retry a 403. Never retry stock transfers, actions, or deletes without checking the result.",
    },
  );

  registerResourceTools(server, context);
  registerViewTools(server, context);
  registerDocumentTools(server, context);
  registerIssuingMaterialTools(server, context);
  registerReportTools(server, context);
  if (config.enableUndocumented) registerUndocumentedTool(server, context);
  return server;
}
