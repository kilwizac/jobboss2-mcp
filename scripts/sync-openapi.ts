import { writeFile } from "node:fs/promises";

import { z } from "zod";

const OPENAPI_URL = "https://api-jb2.integrations.ecimanufacturing.com/openapi.json";
const DOCUMENTATION_URL = "https://integrations.ecimanufacturing.com/api.html?family=jb2";
const OUTPUT_URL = new URL("../src/generated/catalog.json", import.meta.url);
const HTTP_METHODS = ["get", "post", "patch"] as const;
const ALL_HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"];
const SUPPORTED_HTTP_METHODS = new Set<string>(HTTP_METHODS);

const parameterSchema = z
  .object({
    description: z.string().optional(),
    in: z.enum(["path", "query", "header", "cookie"]),
    name: z.string(),
    required: z.boolean().optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const operationSchema = z
  .object({
    description: z.string().optional(),
    parameters: z.array(parameterSchema).optional(),
    requestBody: z.unknown().optional(),
    responses: z.record(z.string(), z.unknown()),
    summary: z.string().optional(),
    tags: z.array(z.string()).min(1),
  })
  .passthrough();

const documentSchema = z.object({
  components: z.object({
    schemas: z.record(z.string(), z.record(z.string(), z.unknown())),
  }),
  info: z.object({
    title: z.string(),
    version: z.string(),
  }),
  openapi: z.string(),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  servers: z.array(z.object({ url: z.string() })).min(1),
});

const requestBodySchema = z
  .object({
    content: z.record(
      z.string(),
      z
        .object({
          schema: z.record(z.string(), z.unknown()).optional(),
        })
        .passthrough(),
    ),
    required: z.boolean().optional(),
  })
  .passthrough();

type CatalogOperation = ReturnType<typeof toCatalogOperation>;
type ResourceOperation = "create" | "get" | "list" | "update";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function collectReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
    return;
  }

  if (!isRecord(value)) return;

  const reference = value["$ref"];
  if (typeof reference === "string" && reference.startsWith("#/components/schemas/")) {
    references.add(reference.slice("#/components/schemas/".length));
  }

  for (const item of Object.values(value)) collectReferences(item, references);
}

function addReferencedSchemas(
  schema: Record<string, unknown>,
  components: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const references = new Set<string>();
  const processed = new Set<string>();
  collectReferences(schema, references);

  while (references.size > processed.size) {
    for (const name of references) {
      if (processed.has(name)) continue;
      const component = components[name];
      if (!component) throw new Error(`Request schema references missing component ${name}`);
      processed.add(name);
      collectReferences(component, references);
    }
  }

  if (processed.size === 0) return schema;

  const schemas = Object.fromEntries(
    [...processed]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => [name, components[name]]),
  );

  return { ...schema, components: { schemas } };
}

function getRequestSchema(
  requestBody: unknown,
  components: Record<string, Record<string, unknown>>,
): { contentType: string | null; required: boolean; schema: Record<string, unknown> | null } {
  const parsed = requestBodySchema.safeParse(requestBody);
  if (!parsed.success) return { contentType: null, required: false, schema: null };

  const contentTypes = Object.keys(parsed.data.content);
  const contentType = contentTypes.includes("application/json")
    ? "application/json"
    : (contentTypes[0] ?? null);
  const mediaType = contentType ? parsed.data.content[contentType] : undefined;
  const schema = mediaType?.schema;

  return {
    contentType,
    required: parsed.data.required ?? false,
    schema: schema ? addReferencedSchemas(schema, components) : null,
  };
}

function toCatalogOperation(
  method: (typeof HTTP_METHODS)[number],
  path: string,
  operation: z.infer<typeof operationSchema>,
  components: Record<string, Record<string, unknown>>,
) {
  const request = getRequestSchema(operation.requestBody, components);

  return {
    bodyRequired: request.required,
    description: operation.description ?? "",
    method: method.toUpperCase(),
    path,
    pathParameters: (operation.parameters ?? [])
      .filter((parameter) => parameter.in === "path")
      .map((parameter) => parameter.name),
    queryParameters: (operation.parameters ?? [])
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => ({
        description: parameter.description ?? "",
        name: parameter.name,
        required: parameter.required ?? false,
        type: typeof parameter.schema?.["type"] === "string" ? parameter.schema["type"] : "unknown",
      })),
    requestContentType: request.contentType,
    requestSchema: request.schema,
    responseStatuses: Object.keys(operation.responses)
      .filter((status) => /^\d{3}$/.test(status))
      .map(Number)
      .sort((left, right) => left - right),
    summary: operation.summary ?? "",
  };
}

function getResourceOperation(
  method: (typeof HTTP_METHODS)[number],
  operation: z.infer<typeof operationSchema>,
): ResourceOperation {
  if (method === "patch") return "update";
  if (method === "post") return "create";

  const isList = (operation.parameters ?? []).some(
    (parameter) => parameter.in === "query" && parameter.name === "filters",
  );
  return isList ? "list" : "get";
}

function makeInternalName(method: string, path: string): string {
  return normalizeName(`${method}_${path.replace(/^\/api\/v1\//, "")}`);
}

async function main(): Promise<void> {
  const response = await fetch(OPENAPI_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OpenAPI request failed with HTTP ${response.status}`);

  const document = documentSchema.parse(await response.json());
  const resources: Record<
    string,
    { operations: Partial<Record<ResourceOperation, CatalogOperation>>; title: string }
  > = {};
  const issuingMaterials: Record<string, CatalogOperation> = {};
  const reports: Record<string, CatalogOperation> = {};
  const undocumented: Record<string, CatalogOperation> = {};
  let operationCount = 0;

  for (const [path, pathItem] of Object.entries(document.paths)) {
    const unsupportedMethods = ALL_HTTP_METHODS.filter(
      (method) => pathItem[method] && !SUPPORTED_HTTP_METHODS.has(method),
    );
    if (unsupportedMethods.length > 0) {
      throw new Error(`${path} uses unsupported methods: ${unsupportedMethods.join(", ")}`);
    }

    for (const method of HTTP_METHODS) {
      const rawOperation = pathItem[method];
      if (!rawOperation) continue;
      operationCount += 1;

      const operation = operationSchema.parse(rawOperation);
      const tag = operation.tags[0];
      if (!tag) throw new Error(`${method.toUpperCase()} ${path} has no tag`);

      const catalogOperation = toCatalogOperation(
        method,
        path,
        operation,
        document.components.schemas,
      );

      if (tag === "null" || tag === "Authentication") {
        const name = makeInternalName(method, path);
        if (undocumented[name]) throw new Error(`Duplicate undocumented operation ${name}`);
        undocumented[name] = catalogOperation;
        continue;
      }

      if (tag === "Issuing Materials") {
        const name =
          method === "post"
            ? "transfer_stock_to_job"
            : `list_${normalizeName(path.split("/").at(-1) ?? path)}`;
        if (issuingMaterials[name]) throw new Error(`Duplicate issuing-material operation ${name}`);
        issuingMaterials[name] = catalogOperation;
        continue;
      }

      if (tag === "Reports") {
        const name = method === "post" ? "create" : "get";
        if (reports[name]) throw new Error(`Duplicate report operation ${name}`);
        reports[name] = catalogOperation;
        continue;
      }

      const resourceName = normalizeName(tag);
      const resource = (resources[resourceName] ??= { operations: {}, title: tag });
      const resourceOperation = getResourceOperation(method, operation);
      if (resource.operations[resourceOperation]) {
        throw new Error(`${resourceName} has multiple ${resourceOperation} operations`);
      }
      resource.operations[resourceOperation] = catalogOperation;
    }
  }

  const catalog = {
    api: {
      openapiVersion: document.openapi,
      serverUrl: document.servers[0]?.url,
      title: document.info.title,
      version: document.info.version,
    },
    documentationUrl: DOCUMENTATION_URL,
    issuingMaterials: Object.fromEntries(
      Object.entries(issuingMaterials).sort(([left], [right]) => left.localeCompare(right)),
    ),
    reports: Object.fromEntries(
      Object.entries(reports).sort(([left], [right]) => left.localeCompare(right)),
    ),
    resources: Object.fromEntries(
      Object.entries(resources).sort(([left], [right]) => left.localeCompare(right)),
    ),
    sourceUrl: OPENAPI_URL,
    undocumented: Object.fromEntries(
      Object.entries(undocumented).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };

  const mappedOperationCount =
    Object.values(resources).reduce(
      (count, resource) => count + Object.keys(resource.operations).length,
      0,
    ) +
    Object.keys(issuingMaterials).length +
    Object.keys(reports).length +
    Object.keys(undocumented).length;
  if (mappedOperationCount !== operationCount) {
    throw new Error(`Mapped ${mappedOperationCount} of ${operationCount} operations`);
  }

  await writeFile(OUTPUT_URL, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.error(
    `Wrote ${operationCount} operations across ${Object.keys(resources).length} resources`,
  );
}

await main();
