import { writeFile } from "node:fs/promises";

import { z } from "zod";

const OPENAPI_URL = "https://api-jb2.integrations.ecimanufacturing.com/openapi/v2.json";
const DOCUMENTATION_URL = "https://integrations.ecimanufacturing.com/api.html?family=jb2";
const OUTPUT_URL = new URL("../src/generated/catalog.json", import.meta.url);
const API_PREFIX = "/api/v2/";
const HTTP_METHODS = ["get", "post", "patch", "delete"] as const;
const ALL_HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"];
const SUPPORTED_HTTP_METHODS = new Set<string>(HTTP_METHODS);
const UNDOCUMENTED_TAGS = new Set(["null", "Authentication", "ShopView"]);
const OMITTED_QUERY_PARAMETERS = new Set(["useCompanyTime"]);

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
type ResourceOperation = "create" | "delete" | "get" | "list" | "update";
type DocumentOperation = "attach" | "detach" | "list";
type HttpMethod = (typeof HTTP_METHODS)[number];

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
  const mediaType =
    contentType === "application/json" ? parsed.data.content[contentType] : undefined;
  const schema = mediaType?.schema;

  return {
    contentType,
    required: parsed.data.required ?? false,
    schema: schema ? addReferencedSchemas(schema, components) : null,
  };
}

function toCatalogOperation(
  method: HttpMethod,
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
      .filter(
        (parameter) => parameter.in === "query" && !OMITTED_QUERY_PARAMETERS.has(parameter.name),
      )
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

function isParameterSegment(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

function relativePath(path: string): string {
  if (!path.startsWith(API_PREFIX)) throw new Error(`${path} is outside ${API_PREFIX}`);
  return path.slice(API_PREFIX.length);
}

function hasQueryParameter(operation: z.infer<typeof operationSchema>, name: string): boolean {
  return (operation.parameters ?? []).some(
    (parameter) => parameter.in === "query" && parameter.name.toLowerCase() === name,
  );
}

function getResourceOperation(method: HttpMethod, path: string): ResourceOperation {
  if (method === "delete") return "delete";
  if (method === "patch") return "update";
  if (method === "post") return "create";
  return path.split("/").some(isParameterSegment) ? "get" : "list";
}

function isView(
  operation: z.infer<typeof operationSchema>,
  path: string,
  siblings: readonly {
    method: HttpMethod;
    operation: z.infer<typeof operationSchema>;
    path: string;
  }[],
): boolean {
  if (hasQueryParameter(operation, "fields")) return false;
  const segments = path.split("/");
  if (!isParameterSegment(segments.at(-1) ?? "")) return true;
  const parent = segments.slice(0, -1).join("/");
  return !siblings.some(
    (sibling) =>
      sibling.method === "get" &&
      sibling.path === parent &&
      hasQueryParameter(sibling.operation, "fields"),
  );
}

function isRecordAction(path: string, siblingPaths: readonly string[]): boolean {
  const segments = path.split("/");
  const last = segments.at(-1) ?? "";
  const parent = segments.at(-2) ?? "";
  if (isParameterSegment(last) || !isParameterSegment(parent)) return false;
  return !siblingPaths.some((sibling) => sibling.split("/").includes(last));
}

function getDocumentOwner(path: string): { operation: string; resource: string } {
  const segments = relativePath(path).split("/");
  const index = segments.lastIndexOf("documents");
  const owner = segments
    .slice(0, index)
    .filter((segment) => !isParameterSegment(segment))
    .at(-1);
  if (index < 1 || !owner) throw new Error(`Cannot find the record that owns ${path}`);
  return { operation: segments.slice(index + 1).join("/"), resource: normalizeName(owner) };
}

function makeInternalName(method: string, path: string): string {
  return normalizeName(`${method}_${relativePath(path)}`);
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function main(): Promise<void> {
  const response = await fetch(OPENAPI_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OpenAPI request failed with HTTP ${response.status}`);

  const document = documentSchema.parse(await response.json());
  const resources: Record<
    string,
    { operations: Partial<Record<ResourceOperation, CatalogOperation>>; title: string }
  > = {};
  const actions: Record<string, CatalogOperation> = {};
  const documents: Record<string, Partial<Record<DocumentOperation, CatalogOperation>>> = {};
  const issuingMaterials: Record<string, CatalogOperation> = {};
  const reports: Record<string, CatalogOperation> = {};
  const undocumented: Record<string, CatalogOperation> = {};
  const views: Record<string, CatalogOperation> = {};
  const operations: {
    method: HttpMethod;
    operation: z.infer<typeof operationSchema>;
    path: string;
    tag: string;
  }[] = [];

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
      const operation = operationSchema.parse(rawOperation);
      const tag = operation.tags[0];
      if (!tag) throw new Error(`${method.toUpperCase()} ${path} has no tag`);
      operations.push({ method, operation, path, tag });
    }
  }

  for (const { method, operation, path, tag } of operations) {
    const catalogOperation = toCatalogOperation(
      method,
      path,
      operation,
      document.components.schemas,
    );

    if (UNDOCUMENTED_TAGS.has(tag)) {
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

    if (tag === "Documents") {
      const owner = getDocumentOwner(path);
      const name: DocumentOperation | undefined =
        method === "get" && owner.operation === ""
          ? "list"
          : method === "post" && owner.operation === ""
            ? "attach"
            : method === "delete" && owner.operation === "{repositoryId}"
              ? "detach"
              : undefined;
      if (!name) throw new Error(`Unrecognized document operation ${method.toUpperCase()} ${path}`);
      const group = (documents[owner.resource] ??= {});
      if (group[name])
        throw new Error(`${owner.resource} has multiple document ${name} operations`);
      group[name] = catalogOperation;
      continue;
    }

    const siblings = operations.filter(
      (sibling) => sibling.tag === tag && sibling.operation !== operation,
    );
    if (method === "get" && isView(operation, path, siblings)) {
      const name = relativePath(path);
      if (views[name]) throw new Error(`Duplicate view ${name}`);
      views[name] = catalogOperation;
      continue;
    }

    if (
      method === "post" &&
      isRecordAction(
        path,
        siblings.map((sibling) => sibling.path),
      )
    ) {
      const name = relativePath(path);
      if (actions[name]) throw new Error(`Duplicate action ${name}`);
      actions[name] = catalogOperation;
      continue;
    }

    const resourceOperation = getResourceOperation(method, path);
    let resourceName = normalizeName(tag);
    let title = tag;
    if (resources[resourceName]?.operations[resourceOperation]) {
      const key = catalogOperation.pathParameters.at(-1);
      if (!key) throw new Error(`${resourceName} has multiple ${resourceOperation} operations`);
      resourceName = `${resourceName}_by_${normalizeName(key)}`;
      title = `${tag} by ${key}`;
    }
    const resource = (resources[resourceName] ??= { operations: {}, title });
    if (resource.operations[resourceOperation]) {
      throw new Error(`${resourceName} has multiple ${resourceOperation} operations`);
    }
    resource.operations[resourceOperation] = catalogOperation;
  }

  for (const resourceName of Object.keys(documents)) {
    if (!resources[resourceName]) {
      throw new Error(`Documents belong to unknown resource ${resourceName}`);
    }
  }

  const catalog = {
    actions: sortRecord(actions),
    api: {
      openapiVersion: document.openapi,
      serverUrl: document.servers[0]?.url,
      title: document.info.title,
      version: document.info.version,
    },
    documentationUrl: DOCUMENTATION_URL,
    documents: sortRecord(documents),
    issuingMaterials: sortRecord(issuingMaterials),
    reports: sortRecord(reports),
    resources: sortRecord(resources),
    sourceUrl: OPENAPI_URL,
    undocumented: sortRecord(undocumented),
    views: sortRecord(views),
  };

  const mappedOperationCount =
    Object.values(resources).reduce(
      (count, resource) => count + Object.keys(resource.operations).length,
      0,
    ) +
    Object.values(documents).reduce((count, group) => count + Object.keys(group).length, 0) +
    Object.keys(actions).length +
    Object.keys(issuingMaterials).length +
    Object.keys(reports).length +
    Object.keys(undocumented).length +
    Object.keys(views).length;
  if (mappedOperationCount !== operations.length) {
    throw new Error(`Mapped ${mappedOperationCount} of ${operations.length} operations`);
  }

  await writeFile(OUTPUT_URL, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.error(
    `Wrote ${operations.length} operations: ${Object.keys(resources).length} resources, ${Object.keys(views).length} views, ${Object.keys(actions).length} actions`,
  );
}

await main();
