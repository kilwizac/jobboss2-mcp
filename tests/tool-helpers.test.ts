import { describe, expect, it } from "vitest";

import { catalog, getResourceOperation } from "../src/catalog.js";
import { JobBoss2InputError } from "../src/errors.js";
import { buildListQuery } from "../src/tool-helpers.js";
import { RequestBodyValidator } from "../src/validation.js";

describe("buildListQuery", () => {
  it("serializes fields, sort expressions, paging, and filter arrays", () => {
    expect(
      buildListQuery({
        fields: ["customerCode", "lastModDate"],
        filters: {
          "customerCode[in]": ["ACME", "ECI"],
          "lastModDate[gte]": "2026-01-01",
        },
        skip: 20,
        sort: ["+customerCode", "-lastModDate"],
        take: 10,
      }),
    ).toEqual({
      fields: "customerCode,lastModDate",
      "customerCode[in]": "ACME|ECI",
      "lastModDate[gte]": "2026-01-01",
      skip: 20,
      sort: "+customerCode,-lastModDate",
      take: 10,
    });
  });

  it("blocks filter forms that ECI documents as invalid", () => {
    expect(() => buildListQuery({ filters: { "revisedDate[null]": true } })).toThrowError(
      JobBoss2InputError,
    );
    expect(() => buildListQuery({ filters: { "customerCode[eq]": ["ACME"] } })).toThrow(
      "accepts an array only with in or notin",
    );
    expect(() => buildListQuery({ filters: { "lastModDate[null]": "true" } })).toThrow(
      "requires a boolean value",
    );
    expect(() => buildListQuery({ filters: { "customerCode[in]": ["A|B", "C"] } })).toThrow(
      "cannot contain a pipe character",
    );
  });

  it("rejects bare filter keys that would override list options", () => {
    for (const key of ["fields", "skip", "sort", "take", "Take"]) {
      expect(() => buildListQuery({ filters: { [key]: "1" } })).toThrow("would override the");
    }
    expect(buildListQuery({ filters: { "take[eq]": 5 } })).toEqual({ "take[eq]": 5 });
  });
});

describe("RequestBodyValidator", () => {
  it("contains every operation from the source OpenAPI document exactly once", () => {
    const operations = [
      ...Object.values(catalog.resources).flatMap((resource) => Object.values(resource.operations)),
      ...Object.values(catalog.issuingMaterials),
      ...Object.values(catalog.reports),
      ...Object.values(catalog.undocumented),
    ].filter((operation) => operation !== undefined);
    const identities = new Set(
      operations.map((operation) => `${operation.method} ${operation.path}`),
    );

    expect(operations).toHaveLength(142);
    expect(identities.size).toBe(142);
  });

  it("compiles every request schema in the generated catalog", () => {
    const validator = new RequestBodyValidator();
    let schemaCount = 0;
    const groups = [
      ...Object.values(catalog.resources).map((resource) => resource.operations),
      catalog.issuingMaterials,
      catalog.reports,
      catalog.undocumented,
    ];

    for (const group of groups) {
      for (const operation of Object.values(group)) {
        if (!operation?.requestSchema) continue;
        schemaCount += 1;
        try {
          validator.validate(operation, {});
        } catch (error) {
          expect(error).toBeInstanceOf(JobBoss2InputError);
        }
      }
    }

    expect(schemaCount).toBe(38);
  });

  it("rejects fields outside a documented request schema", () => {
    const validator = new RequestBodyValidator();
    const operation = getResourceOperation("customers", "create");
    expect(() => validator.validate(operation, { notAJobBoss2Field: true })).toThrow(
      "must NOT have additional properties",
    );
  });

  it("rejects fields marked read-only by the API schema", () => {
    const validator = new RequestBodyValidator();
    const operation = getResourceOperation("quotes", "create");
    expect(() => validator.validate(operation, { user_Currency1: "USD" })).toThrow(
      "/user_Currency1 is read-only",
    );
  });
});
