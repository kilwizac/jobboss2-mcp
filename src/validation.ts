import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import * as formatsModule from "ajv-formats";

import type { CatalogOperation } from "./catalog.js";
import { JobBoss2InputError } from "./errors.js";
import type { JsonValue } from "./json.js";

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "request body does not match the API schema";
  return errors
    .map((error) =>
      error.keyword === "readOnly"
        ? `${error.instancePath || "/"} is read-only`
        : `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
}

export class RequestBodyValidator {
  readonly #ajv: Ajv;
  readonly #validators = new Map<string, ValidateFunction>();

  constructor() {
    this.#ajv = new Ajv({ allErrors: true, logger: false, strict: false });
    formatsModule.default.default(this.#ajv);
    this.#ajv.removeKeyword("readOnly");
    this.#ajv.addKeyword({
      errors: false,
      keyword: "readOnly",
      schemaType: "boolean",
      validate: (readOnly: boolean) => !readOnly,
    });
  }

  validate(operation: CatalogOperation, body: JsonValue): void {
    if (!operation.requestSchema) return;

    const key = `${operation.method} ${operation.path}`;
    const validator = this.#validators.get(key) ?? this.#compile(key, operation.requestSchema);

    if (!validator(body)) {
      throw new JobBoss2InputError(formatValidationErrors(validator.errors));
    }
  }

  #compile(key: string, schema: Record<string, unknown>): ValidateFunction {
    const validator = this.#ajv.compile(schema);
    this.#validators.set(key, validator);
    return validator;
  }
}
