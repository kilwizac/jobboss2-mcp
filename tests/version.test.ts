import packageJson from "../package.json" with { type: "json" };
import { expect, it } from "vitest";

import { SERVER_VERSION } from "../src/version.js";

it("keeps the server and package versions in sync", () => {
  expect(SERVER_VERSION).toBe(packageJson.version);
});
