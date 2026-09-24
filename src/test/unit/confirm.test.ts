import assert from "node:assert/strict";
import test from "node:test";
import { fabricRemovalConfirmation } from "../../confirm.js";

test("an empty fabric label is confirmed by its index", () => {
  assert.equal(fabricRemovalConfirmation({ fabricIndex: 1, label: "" }), "1");
  assert.equal(
    fabricRemovalConfirmation({ fabricIndex: 3, label: "Matter Switchboard" }),
    "Matter Switchboard",
  );
});
