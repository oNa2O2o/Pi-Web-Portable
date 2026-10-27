import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { compareVersions } = await jiti.import("./app-control.ts");

test("compareVersions orders dotted versions numerically", () => {
  assert.equal(compareVersions("1.10.0", "1.9.2"), 1);
  assert.equal(compareVersions("1.4.0", "1.4"), 0);
  assert.equal(compareVersions("v1.4.1", "1.5.0"), -1);
});
