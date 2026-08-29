import { z } from "zod";

import rawCatalog from "./generated/catalog.json" with { type: "json" };

const queryParameterSchema = z.object({
  description: z.string(),
  name: z.string(),
  required: z.boolean(),
  type: z.string(),
});

const operationSchema = z.object({
  bodyRequired: z.boolean(),
  description: z.string(),
  method: z.enum(["GET", "POST", "PATCH"]),
  path: z.string().startsWith("/"),
  pathParameters: z.array(z.string()),
  queryParameters: z.array(queryParameterSchema),
  requestContentType: z.string().nullable(),
  requestSchema: z.record(z.string(), z.json()).nullable(),
  responseStatuses: z.array(z.number().int()),
  summary: z.string(),
});

const resourceSchema = z.object({
  operations: z.object({
    create: operationSchema.optional(),
    get: operationSchema.optional(),
    list: operationSchema.optional(),
    update: operationSchema.optional(),
  }),
  title: z.string(),
});

const catalogSchema = z.object({
  api: z.object({
    openapiVersion: z.string(),
    serverUrl: z.url(),
    title: z.string(),
    version: z.string(),
  }),
  documentationUrl: z.url(),
  issuingMaterials: z.record(z.string(), operationSchema),
  reports: z.record(z.string(), operationSchema),
  resources: z.record(z.string(), resourceSchema),
  sourceUrl: z.url(),
  undocumented: z.record(z.string(), operationSchema),
});

export const catalog = catalogSchema.parse(rawCatalog);

export type Catalog = typeof catalog;
export type CatalogOperation = z.infer<typeof operationSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type ResourceOperation = keyof Resource["operations"];

function namesWithOperation(operation: ResourceOperation): string[] {
  return Object.entries(catalog.resources)
    .filter(([, resource]) => resource.operations[operation] !== undefined)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}

export const resourceNames = Object.keys(catalog.resources).sort((left, right) =>
  left.localeCompare(right),
);
export const listResourceNames = namesWithOperation("list");
export const getResourceNames = namesWithOperation("get");
export const createResourceNames = namesWithOperation("create");
export const updateResourceNames = namesWithOperation("update");
export const issuingMaterialLookupNames = Object.keys(catalog.issuingMaterials)
  .filter((name) => name.startsWith("list_"))
  .sort((left, right) => left.localeCompare(right));
export const undocumentedOperationNames = Object.keys(catalog.undocumented).sort((left, right) =>
  left.localeCompare(right),
);

export function stringEnum(values: readonly string[]) {
  const first = values[0];
  if (!first) throw new Error("Cannot create an enum from an empty catalog list");
  return z.enum([first, ...values.slice(1)]);
}

export function getResourceOperation(
  resourceName: string,
  operationName: ResourceOperation,
): CatalogOperation {
  const resource = catalog.resources[resourceName];
  const operation = resource?.operations[operationName];
  if (!operation) {
    throw new Error(`Catalog operation ${resourceName}.${operationName} does not exist`);
  }
  return operation;
}
