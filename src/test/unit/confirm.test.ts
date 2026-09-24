import assert from "node:assert/strict";
import test from "node:test";
import { confirmedValue, fabricRemovalConfirmation, requiredArgument } from "../../confirm.js";

const base = {
  flag: "--confirm-fabric-label",
  mismatch: "value required",
  isTTY: true,
  read: async () => "typed",
};

test("a terminal prompt supplies the value when no flag is passed", async () => {
  let reads = 0;
  const value = await confirmedValue({
    ...base,
    provided: undefined,
    read: async () => {
      reads += 1;
      return "  34970112332  ";
    },
  });
  assert.equal(value, "34970112332");
  assert.equal(reads, 1);
});

test("a missing terminal requires the value flag", async () => {
  await assert.rejects(
    () => confirmedValue({ ...base, provided: undefined, isTTY: false }),
    /Non-interactive use requires --confirm-fabric-label/,
  );
});

test("a flag value is accepted without a prompt", async () => {
  let reads = 0;
  const value = await confirmedValue({
    ...base,
    provided: " 34970112332 ",
    read: async () => {
      reads += 1;
      return "typed";
    },
  });
  assert.equal(value, "34970112332");
  assert.equal(reads, 0);
});

test("a flagged confirmation must match the expected value", async () => {
  await assert.rejects(
    () =>
      confirmedValue({
        ...base,
        flag: "--confirm-fabric-label",
        provided: "other",
        expected: "patio-strip",
        mismatch: "Confirmation did not match",
      }),
    /Confirmation did not match/,
  );
  const value = await confirmedValue({
    ...base,
    flag: "--confirm-fabric-label",
    provided: "patio-strip",
    expected: "patio-strip",
    mismatch: "Confirmation did not match",
  });
  assert.equal(value, "patio-strip");
});

test("an empty fabric label is confirmed by its index", () => {
  assert.equal(fabricRemovalConfirmation({ fabricIndex: 1, label: "" }), "1");
  assert.equal(
    fabricRemovalConfirmation({ fabricIndex: 3, label: "Matter Switchboard" }),
    "Matter Switchboard",
  );
});

test("a required argument prompts on a terminal and fails without one", async () => {
  const prompted = await requiredArgument({
    provided: undefined,
    isTTY: true,
    name: "setup-code",
    read: async () => "  34970112332  ",
  });
  assert.equal(prompted, "34970112332");
  assert.equal(
    await requiredArgument({
      provided: " patio-strip ",
      isTTY: false,
      name: "slug",
      read: async () => "unused",
    }),
    "patio-strip",
  );
  await assert.rejects(
    () =>
      requiredArgument({
        provided: undefined,
        isTTY: false,
        name: "setup-code",
        read: async () => "unused",
      }),
    /Missing required argument 'setup-code'/,
  );
});

test("a prompted confirmation must match the expected value", async () => {
  await assert.rejects(
    () =>
      confirmedValue({
        ...base,
        provided: undefined,
        expected: "patio-strip",
        mismatch: "Confirmation did not match",
        read: async () => "other",
      }),
    /Confirmation did not match/,
  );
});
