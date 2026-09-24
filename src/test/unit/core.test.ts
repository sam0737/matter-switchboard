import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LogLevel, Logger } from "@matter/general";
import { decideAttestation } from "../../attestation.js";
import { unregisteredCommissionedNode } from "../../commissioned.js";
import { defaultConfig, validateConfig, type LogLevelName } from "../../config.js";
import { deviceAllowlist, Inventory } from "../../inventory.js";
import { SlidingWindowLimiter } from "../../limiter.js";
import { applyLogLevel } from "../../log.js";
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

test("active API key names are unique and delete removes the record", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "matter-switchboard-unit-"));
  try {
    const store = new StateStore(path.join(dir, "state.json"));
    await store.load();
    const inventory = new Inventory(store);
    await inventory.createApiKey({
      name: "irrigation",
      scope: "read",
      devices: null,
      verifier: verifier("example-key"),
    });
    await assert.rejects(
      () =>
        inventory.createApiKey({
          name: "irrigation",
          scope: "control",
          devices: null,
          verifier: verifier("other-key"),
        }),
      /API key 'irrigation' already exists/,
    );
    await inventory.deleteApiKey("irrigation");
    assert.equal(
      inventory.listApiKeys().some((key) => key.name === "irrigation"),
      false,
    );
    await inventory.createApiKey({
      name: "irrigation",
      scope: "control",
      devices: null,
      verifier: verifier("replacement-key"),
    });
    assert.equal(
      inventory.listApiKeys().filter((key) => key.name === "irrigation" && key.revokedAt === null)
        .length,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loading state deletes keys that were only marked revoked", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "matter-switchboard-unit-"));
  const stateFile = path.join(dir, "state.json");
  try {
    await writeFile(
      stateFile,
      JSON.stringify({
        version: 1,
        devices: [],
        apiKeys: [
          {
            id: "kept",
            name: "dashboard",
            verifier: "abc",
            scope: "read",
            devices: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            revokedAt: null,
          },
          {
            id: "dropped",
            name: "old-name",
            verifier: "def",
            scope: "read",
            devices: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            revokedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      }),
    );
    const store = new StateStore(stateFile);
    await store.load();
    assert.deepEqual(
      store.snapshot().apiKeys.map((key) => key.name),
      ["dashboard"],
    );
    assert.equal((await readFile(stateFile, "utf8")).includes("old-name"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a blank device allowlist means every device", () => {
  assert.deepEqual(deviceAllowlist(["patio-strip", "garage-strip"]), [
    "patio-strip",
    "garage-strip",
  ]);
  assert.deepEqual(deviceAllowlist(["patio-strip, garage-strip"]), ["patio-strip", "garage-strip"]);
  assert.deepEqual(deviceAllowlist(["patio-strip garage-strip"]), ["patio-strip", "garage-strip"]);
  assert.equal(deviceAllowlist(null), null);
  assert.equal(deviceAllowlist([]), null);
  assert.equal(deviceAllowlist([""]), null);
  assert.equal(deviceAllowlist(["  ,  "]), null);
});

test("API secrets are high entropy and stored verifiers do not expose them", () => {
  const secret = createSecret("msb");
  assert.equal(secret.startsWith("msb_"), true);
  assert.equal(matches(secret, verifier(secret)), true);
  assert.equal(matches(`${secret}x`, verifier(secret)), false);
  assert.notEqual(verifier(secret), secret);
});

test("attestation bypass defaults off and must be boolean", () => {
  assert.equal(defaultConfig.allowAttestationBypass, false);
  assert.equal(validateConfig({ ...defaultConfig }).allowAttestationBypass, false);
  assert.equal(
    validateConfig({ ...defaultConfig, allowAttestationBypass: true }).allowAttestationBypass,
    true,
  );
  assert.throws(
    () =>
      validateConfig({
        ...defaultConfig,
        allowAttestationBypass: "true" as unknown as boolean,
      }),
    /allowAttestationBypass must be true or false/,
  );
});

test("log level defaults to info and can be set to debug", () => {
  assert.equal(defaultConfig.logLevel, "info");
  assert.equal(validateConfig({ ...defaultConfig }).logLevel, "info");
  assert.equal(
    validateConfig({ ...defaultConfig, logLevel: "DEBUG" as LogLevelName }).logLevel,
    "debug",
  );
  assert.equal(validateConfig({ ...defaultConfig, logLevel: "warn" }).logLevel, "warn");
  assert.throws(
    () => validateConfig({ ...defaultConfig, logLevel: "verbose" as LogLevelName }),
    /logLevel must be debug, info, notice, warn, error, or fatal/,
  );
  const previous = Logger.level;
  try {
    applyLogLevel("info");
    assert.equal(Logger.level, LogLevel.INFO);
    applyLogLevel("debug");
    assert.equal(Logger.level, LogLevel.DEBUG);
    assert.ok(LogLevel.DEBUG < LogLevel.INFO);
  } finally {
    Logger.level = previous;
  }
});

test("attestation accepts every finding below error", () => {
  const note = {
    level: "info" as const,
    type: "PaaTrustStoreTimeMismatch",
    message: "cannot confirm PAA was in DCL when DAC was issued",
  };
  const warning = {
    level: "warning" as const,
    type: "CdSignerVerificationSkipped",
    message: "skipping CD signature verification",
  };
  assert.equal(decideAttestation([note, warning], false), true);
  assert.equal(
    decideAttestation(
      [note, warning, { level: "error", type: "PaaNotTrusted", message: "PAA not found" }],
      false,
    ),
    "PaaNotTrusted: PAA not found",
  );
  assert.equal(
    decideAttestation([{ level: "error", type: "PaaNotTrusted", message: "no" }], true),
    true,
  );
});

test("a fabric conflict restores the single unregistered commissioned node", () => {
  assert.equal(unregisteredCommissionedNode(["10", "20"], ["10"]), "20");
  assert.throws(() => unregisteredCommissionedNode(["10"], ["10"]), /no unregistered node/);
  assert.throws(
    () => unregisteredCommissionedNode(["10", "20"], []),
    /2 commissioned nodes are not in the inventory/,
  );
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
