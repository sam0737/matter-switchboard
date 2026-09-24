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

const httpMethods = new Set(["get", "post", "put", "patch", "delete"]);

const userPaths = [
  "/health",
  "/v1/devices",
  "/v1/devices/{slug}",
  "/v1/devices/{slug}/availability",
  "/v1/devices/{slug}/endpoints",
  "/v1/devices/{slug}/endpoints/{endpointId}/power",
  "/v1/devices/{slug}/endpoints/{endpointId}/state",
];

const adminPaths = [
  "/admin/config",
  "/admin/devices",
  "/admin/devices/commission",
  "/admin/devices/{slug}/decommission-self",
  "/admin/devices/{slug}/fabrics",
  "/admin/devices/{slug}/fabrics/{fabricIndex}",
  "/admin/devices/{slug}/forget-local",
  "/admin/devices/{slug}/ping",
  "/admin/devices/{slug}/rename",
  "/admin/devices/{slug}/share",
  "/admin/keys",
  "/admin/keys/{name}",
  "/admin/mocks",
  "/admin/mocks/{slug}",
  "/health",
  "/v1/devices",
  "/v1/devices/{slug}",
  "/v1/devices/{slug}/availability",
  "/v1/devices/{slug}/endpoints",
  "/v1/devices/{slug}/endpoints/{endpointId}/power",
  "/v1/devices/{slug}/endpoints/{endpointId}/state",
];

interface OpenApiDocument {
  openapi: string;
  info: { title: string; description?: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    securitySchemes?: Record<string, { type?: string; scheme?: string; description?: string }>;
  };
}

interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{ name?: string; description?: string; schema?: { type?: string } }>;
  requestBody?: {
    content?: Record<
      string,
      { schema?: { properties?: Record<string, { description?: string }> } }
    >;
  };
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<
        string,
        { schema?: { type?: string; properties?: Record<string, unknown> } }
      >;
    }
  >;
}

function assertOpenApi(specification: OpenApiDocument, audience: "admin" | "user"): void {
  assert.equal(specification.openapi, "3.0.3");
  assert.equal(
    specification.info.title,
    audience === "admin" ? "Matter Switchboard Administrator API" : "Matter Switchboard User API",
  );
  assert.match(specification.info.description ?? "", /Authorization: Bearer/);
  assert.equal(specification.info.version, "0.1.0");
  assert.equal(specification.paths["/openapi.json"], undefined);
  assert.deepEqual(
    Object.keys(specification.paths).sort(),
    audience === "admin" ? adminPaths : userPaths,
  );
  const bearer = specification.components?.securitySchemes?.bearerAuth;
  assert.equal(bearer?.type, "http");
  assert.equal(bearer?.scheme, "bearer");
  assert.match(bearer?.description ?? "", audience === "admin" ? /dministrator/ : /API key/);

  for (const [route, methods] of Object.entries(specification.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!httpMethods.has(method)) continue;
      assert.ok(operation.summary, `${method} ${route} summary`);
      assert.ok(operation.description, `${method} ${route} description`);
      assert.ok(operation.operationId, `${method} ${route} operationId`);
      assert.ok(operation.responses, `${method} ${route} responses`);
      if (route === "/health") assert.deepEqual(operation.security, []);
      else assert.ok(operation.security?.some((item) => item.bearerAuth));
      for (const [status, response] of Object.entries(operation.responses)) {
        assert.ok(response.description, `${method} ${route} ${status}`);
        if (status === "204") {
          assert.equal(response.content, undefined, `${method} ${route} 204 body`);
        } else {
          const schema = response.content?.["application/json"]?.schema;
          assert.ok(schema?.type, `${method} ${route} ${status} schema`);
        }
      }
    }
  }

  if (audience === "user") {
    const power = specification.paths["/v1/devices/{slug}/endpoints/{endpointId}/power"]?.put;
    assert.equal(
      power?.requestBody?.content?.[
        "application/json"
      ]?.schema?.properties?.on?.description?.includes("turns the socket on"),
      true,
    );
    const state = specification.paths["/v1/devices/{slug}/endpoints/{endpointId}/state"]?.get;
    const observed = state?.responses?.["200"]?.content?.["application/json"]?.schema?.properties;
    assert.equal(typeof observed?.currentAmps, "object");
    assert.equal(typeof observed?.on, "object");
  } else {
    const created = specification.paths["/admin/keys"]?.post?.responses?.["201"];
    const key = created?.content?.["application/json"]?.schema?.properties;
    assert.equal(typeof key?.token, "object");
    const listed = specification.paths["/admin/keys"]?.get?.responses?.["200"]?.content?.[
      "application/json"
    ]?.schema as { items?: { properties?: Record<string, unknown> } } | undefined;
    assert.equal(listed?.items?.properties?.token, undefined);
  }
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

  const help = command(env, "--help");
  assert.equal((await help.exited).code, 0, help.output());
  assert.match(help.output(), /Usage: matter-switchboard/);
  assert.match(help.output(), /tui/);

  const adminToken = (
    await readFile(path.join(env.XDG_CONFIG_HOME!, "matter-switchboard", "admin-token"), "utf8")
  ).trim();
  const adminBase = `http://127.0.0.1:${config.adminPort}`;
  const adminHeaders = {
    Authorization: `Bearer ${adminToken}`,
    "Content-Type": "application/json",
  };
  const adminDevices = await fetch(`${adminBase}/v1/devices`, { headers: adminHeaders });
  assert.equal(adminDevices.status, 200, await adminDevices.text());
  const adminPower = await fetch(`${adminBase}/v1/devices/test-strip/endpoints/1/power`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ on: true }),
  });
  assert.equal(adminPower.status, 200, await adminPower.text());
  const shareMock = await fetch(`${adminBase}/admin/devices/test-strip/share`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(shareMock.status, 409, await shareMock.text());
  const shareTimeout = await fetch(`${adminBase}/admin/devices/test-strip/share`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ timeoutSeconds: 10 }),
  });
  assert.equal(shareTimeout.status, 400);
  const shareCli = command(env, "device", "share", "test-strip");
  assert.notEqual((await shareCli.exited).code, 0);
  assert.match(shareCli.output(), /cannot be shared/);

  const makeKey = command(env, "key", "create", "e2e", "control", "test-strip");
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
  const endpointList = (await endpoints.json()) as Array<{
    endpointId: number;
    currentAmps: number | null;
    measurementSupport: { current: boolean };
  }>;
  assert.deepEqual(
    endpointList.map((item) => item.endpointId),
    [1, 2],
  );
  assert.equal(endpointList[0]?.currentAmps, null);
  assert.equal(endpointList[0]?.measurementSupport.current, false);

  const setPower = await fetch(`${base}/v1/devices/test-strip/endpoints/2/power`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(setPower.status, 200);
  const powered = (await setPower.json()) as {
    requestedOn: boolean;
    observed: { on: boolean; currentAmps: number | null };
  };
  assert.equal(powered.requestedOn, true);
  assert.equal(powered.observed.on, true);
  assert.equal(powered.observed.currentAmps, null);
  const state = await fetch(`${base}/v1/devices/test-strip/endpoints/2/state`, { headers });
  assert.equal(state.status, 200);
  const outlet = (await state.json()) as {
    on: boolean;
    currentAmps: number | null;
    observedAt: string;
  };
  assert.equal(outlet.on, true);
  assert.equal(outlet.currentAmps, null);
  assert.match(outlet.observedAt, /^\d{4}-\d{2}-\d{2}T/);

  const openapi = await fetch(`${base}/openapi.json`, { headers });
  assert.equal(openapi.status, 200);
  const specification = (await openapi.json()) as OpenApiDocument;
  assertOpenApi(specification, "user");
  const again = (await (await fetch(`${base}/openapi.json`)).json()) as OpenApiDocument;
  assert.equal(again.info.title, specification.info.title);
  assert.equal(specification.paths["/admin/devices/commission"], undefined);
  assert.equal((await fetch(`${base}/docs`, { headers })).status, 200);

  const adminSpec = (await (await fetch(`${adminBase}/openapi.json`)).json()) as OpenApiDocument;
  assertOpenApi(adminSpec, "admin");
  const created = await fetch(`${adminBase}/admin/mocks`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ slug: "schema-mock" }),
  });
  assert.equal(created.status, 201);
  const createdDevice = (await created.json()) as {
    slug: string;
    productName: string;
    endpoints: Array<{ endpointId: number; on: boolean; currentAmps: number | null }>;
  };
  assert.equal(createdDevice.slug, "schema-mock");
  assert.equal(createdDevice.productName, "Two Socket Mock Strip");
  assert.equal(createdDevice.endpoints[0]?.currentAmps, null);
  assert.equal(createdDevice.endpoints[0]?.on, false);
  const removed = await fetch(`${adminBase}/admin/mocks/schema-mock`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(removed.status, 204);
  assert.equal(await removed.text(), "");

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
