import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface RunningCommand {
  child: ChildProcess;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function command(env: NodeJS.ProcessEnv, ...args: string[]): RunningCommand {
  const child = spawn(process.execPath, [path.resolve("dist/cli.js"), ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, output: () => text, exited };
}

async function eventually<T>(
  action: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let latest: unknown;
  while (Date.now() < end) {
    try {
      const value = await action();
      if (ready(value)) return value;
      latest = value;
    } catch (error) {
      latest = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for service: ${String(latest)}`);
}

test("CLI, authenticated HTTP API, mocks, persistence, and single-instance behavior", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "matter-switchboard-e2e-"));
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
  };
  let server: RunningCommand | undefined;
  t.after(async () => {
    if (server?.child.exitCode === null) {
      server.child.kill("SIGTERM");
      await server.exited;
    }
    await rm(root, { recursive: true, force: true });
  });

  const init = command(env, "init");
  assert.equal((await init.exited).code, 0, init.output());

  const configPath = path.join(env.XDG_CONFIG_HOME!, "matter-switchboard", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    apiPort: number;
    adminPort: number;
    apiHost: string;
  };
  const apiPort = 18000 + Math.floor(Math.random() * 10000);
  config.apiHost = "127.0.0.1";
  config.apiPort = apiPort;
  config.adminPort = apiPort + 1;
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  server = command(env, "server");
  const base = `http://127.0.0.1:${apiPort}`;
  await eventually(
    async () => fetch(`${base}/health`).then((response) => response.status),
    (status) => status === 200,
  );

  const duplicate = command(env, "server");
  const duplicateExit = await duplicate.exited;
  assert.notEqual(duplicateExit.code, 0);
  assert.match(duplicate.output(), /already running/);

  const add = command(env, "mock", "add", "test-strip");
  assert.equal((await add.exited).code, 0, add.output());
  assert.match(add.output(), /Two Socket Mock Strip/);

  const makeKey = command(
    env,
    "key",
    "create",
    "--name",
    "e2e",
    "--scope",
    "control",
    "--devices",
    "test-strip",
  );
  assert.equal((await makeKey.exited).code, 0, makeKey.output());
  const token = makeKey.output().match(/msb_[A-Za-z0-9_-]{40,}/)?.[0];
  assert.ok(token, makeKey.output());

  for (let i = 0; i < 5; i++) {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/docs`)).status, 200);
    assert.equal((await fetch(`${base}/openapi.json`)).status, 200);
  }
  const unauthorized = await fetch(`${base}/v1/devices`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await fetch(`${base}/v1/devices`)).status, 401);
  assert.equal((await fetch(`${base}/v1/devices`)).status, 401);
  const throttled = await fetch(`${base}/v1/devices`);
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get("retry-after")) >= 1);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/docs`)).status, 200);
  const headers = { Authorization: `Bearer ${token}` };
  const devicesResponse = await fetch(`${base}/v1/devices`, { headers });
  assert.equal(devicesResponse.status, 200);
  const devices = (await devicesResponse.json()) as Array<{
    slug: string;
    kind: string;
    nodeId: string | null;
  }>;
  assert.deepEqual(
    devices.map((device) => [device.slug, device.kind, device.nodeId]),
    [["test-strip", "mock", null]],
  );

  const endpoints = await fetch(`${base}/v1/devices/test-strip/endpoints`, { headers });
  assert.equal(endpoints.status, 200);
  assert.deepEqual(
    ((await endpoints.json()) as Array<{ endpointId: number }>).map((item) => item.endpointId),
    [1, 2],
  );

  const setPower = await fetch(`${base}/v1/devices/test-strip/endpoints/2/power`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(setPower.status, 200);
  const state = await fetch(`${base}/v1/devices/test-strip/endpoints/2/state`, { headers });
  assert.equal(((await state.json()) as { on: boolean }).on, true);

  const openapi = await fetch(`${base}/openapi.json`, { headers });
  assert.equal(openapi.status, 200);
  const specification = (await openapi.json()) as {
    openapi: string;
    paths: Record<string, unknown>;
  };
  assert.equal(specification.openapi, "3.0.3");
  assert.ok(specification.paths["/v1/devices/{slug}/endpoints/{endpointId}/power"]);
  assert.equal(specification.paths["/admin/devices/commission"], undefined);
  assert.equal((await fetch(`${base}/docs`, { headers })).status, 200);

  server.child.kill("SIGTERM");
  const stopped = await server.exited;
  assert.equal(stopped.code, 0, server.output());
  server = command(env, "server");
  await eventually(
    async () => fetch(`${base}/health`).then((response) => response.status),
    (status) => status === 200,
  );
  const persisted = await fetch(`${base}/v1/devices/test-strip/endpoints/2/state`, { headers });
  assert.equal(persisted.status, 200);
  assert.equal(((await persisted.json()) as { on: boolean }).on, true);

  const remove = command(env, "mock", "remove", "test-strip");
  assert.equal((await remove.exited).code, 0, remove.output());
});
