import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Inventory } from "../../inventory.js";
import { SlidingWindowLimiter } from "../../limiter.js";
import { createSecret, matches, verifier } from "../../security.js";
import { StateStore } from "../../storage.js";

test("mock inventory has two sockets and power state survives reload", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "matter-switchboard-unit-"));
  const stateFile = path.join(dir, "state.json");
  try {
    const store = new StateStore(stateFile);
    await store.load();
    const inventory = new Inventory(store);
    const mock = await inventory.addMock("test-strip");
    assert.equal(mock.endpoints.length, 2);
    assert.deepEqual(
      mock.endpoints.map((outlet) => outlet.endpointId),
      [1, 2],
    );
    assert.ok(mock.endpoints.every((outlet) => outlet.on === false));
    await inventory.setPower("test-strip", 2, true);
    const reloaded = new StateStore(stateFile);
    await reloaded.load();
    assert.equal(new Inventory(reloaded).get("test-strip").endpoints[1]?.on, true);
    await new Inventory(reloaded).removeMock("test-strip");
    assert.equal(new Inventory(reloaded).list().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("slugs are unique and mock removal cannot remove Matter inventory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "matter-switchboard-unit-"));
  try {
    const store = new StateStore(path.join(dir, "state.json"));
    await store.load();
    const inventory = new Inventory(store);
    await inventory.addMock("one");
    await assert.rejects(inventory.addMock("one"), /already in use/);
    await assert.rejects(inventory.addMock("Not A Slug"), /Slug must be/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("API device allowlists remain attached to identity across rename and slug reuse", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "matter-switchboard-unit-"));
  try {
    const store = new StateStore(path.join(dir, "state.json"));
    await store.load();
    const inventory = new Inventory(store);
    const first = await inventory.addMock("plug");
    const key = await inventory.createApiKey({
      name: "automation",
      scope: "control",
      devices: ["plug"],
      verifier: verifier("example-key"),
    });
    await inventory.rename("plug", "renamed-plug");
    const record = store.snapshot().apiKeys[0]!;
    assert.deepEqual(record.devices, [first.id]);
    assert.deepEqual(inventory.listApiKeys()[0]?.devices, ["renamed-plug"]);
    await inventory.removeMock("renamed-plug");
    const second = await inventory.addMock("plug");
    assert.notEqual(first.id, second.id);
    assert.deepEqual(store.snapshot().apiKeys[0]?.devices, [first.id]);
    assert.notDeepEqual(store.snapshot().apiKeys[0]?.devices, [second.id]);
    assert.equal(key.devices?.[0], "plug");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("API secrets are high entropy and stored verifiers do not expose them", () => {
  const secret = createSecret("msb");
  assert.equal(secret.startsWith("msb_"), true);
  assert.equal(matches(secret, verifier(secret)), true);
  assert.equal(matches(`${secret}x`, verifier(secret)), false);
  assert.notEqual(verifier(secret), secret);
});

test("sliding window rate limiter enforces limits and expires entries", () => {
  let now = 1000;
  const limiter = new SlidingWindowLimiter(2, 5000, () => now);
  assert.equal(limiter.consume("ip:a").allowed, true);
  assert.equal(limiter.consume("ip:a").allowed, true);
  const rejected = limiter.consume("ip:a");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfterSeconds, 5);
  now += 5001;
  assert.equal(limiter.consume("ip:a").allowed, true);
});
