#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initConfig, loadConfig, logLevels, readAdminToken } from "./config.js";
import { startServer } from "./server.js";
import { files, ensureDirectories } from "./paths.js";
import { fabricRemovalConfirmation } from "./confirm.js";
import { createSecret } from "./security.js";

const cliPath = fileURLToPath(import.meta.url);

interface ApiResponse<T = unknown> {
  response: Response;
  data: T;
}

async function adminRequest<T = unknown>(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const config = await loadConfig();
  const token = await readAdminToken();
  const response = await fetch(`http://127.0.0.1:${config.adminPort}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = response.status === 204 ? "" : await response.text();
  const data = text ? (JSON.parse(text) as T) : (undefined as T);
  if (!response.ok) {
    const error = data as { message?: string; error?: string };
    throw new Error(error?.message ?? `HTTP ${response.status} ${response.statusText}`);
  }
  return { response, data };
}

async function runLockedServer(): Promise<void> {
  await ensureDirectories();
  try {
    const handle = await fs.open(files.lockFile, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await fs.chmod(files.lockFile, 0o600);
  const child = spawn(
    "flock",
    ["-n", "-E", "73", "-F", files.lockFile, process.execPath, cliPath, "_server-child"],
    { stdio: "inherit" },
  );
  let stopping = false;
  const forward = (signal: NodeJS.Signals) => {
    stopping = true;
    child.kill(signal);
  };
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  ).finally(() => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  });

  if (result.code === 73) {
    let pid = "unknown";
    try {
      const metadata = JSON.parse(await fs.readFile(files.lockFile, "utf8")) as { pid?: number };
      if (metadata.pid) pid = String(metadata.pid);
    } catch {
      // A live process can hold the lock before it writes diagnostic metadata.
    }
    throw new Error(
      `Matter Switchboard is already running (PID ${pid}); this invocation did not start another server`,
    );
  }
  if (result.signal && !stopping) throw new Error(`Server wrapper exited from ${result.signal}`);
  if (result.code !== 0 && result.code !== null)
    throw new Error(`Server exited with status ${result.code}`);
}

async function runServerChild(): Promise<void> {
  const handle = await fs.open(files.lockFile, "w", 0o600);
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  const running = await startServer();
  const shutdown = async () => {
    await running.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  const config = await loadConfig();
  console.log(`Matter Switchboard API listening at http://${config.apiHost}:${config.apiPort}`);
  console.log(`Administrator API listening at http://127.0.0.1:${config.adminPort}`);
  console.log(`OpenAPI: http://${config.apiHost}:${config.apiPort}/openapi.json`);
  console.log(`Swagger UI: http://${config.apiHost}:${config.apiPort}/docs`);
}

async function ask(prompt: string, hidden = false): Promise<string> {
  const readline = await import("node:readline/promises");
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (!hidden) {
    try {
      return (await terminal.question(prompt)).trim();
    } finally {
      terminal.close();
    }
  }
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  process.stdout.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      process.stdout.write("\n");
      terminal.close();
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("Cancelled"));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 127 || byte === 8) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    stdin.on("data", onData);
  });
}

async function init(): Promise<void> {
  const result = await initConfig();
  if (result.created) {
    console.log("Matter Switchboard initialized for the current user.");
    console.log(`Configuration: ${files.config}`);
    console.log(`Persistent data: ${path.dirname(files.state)}`);
    console.log("Administrator credential created and saved with mode 0600.");
  } else {
    console.log("Matter Switchboard is already initialized; existing state was kept.");
    if (result.adminToken)
      console.log(`A replacement administrator credential was created: ${result.adminToken}`);
  }
}

function deviceRows(devices: Array<Record<string, unknown>>): void {
  if (devices.length === 0) return console.log("No devices registered.");
  for (const device of devices) {
    const endpoints = Array.isArray(device.endpoints)
      ? device.endpoints.length
      : (device.endpointCount ?? "?");
    console.log(
      `${String(device.slug).padEnd(24)} ${String(device.kind).padEnd(7)} ${endpoints} endpoint(s)  node=${device.nodeId ?? "—"}`,
    );
  }
}

async function createProgram(): Promise<void> {
  const program = new Command();
  program
    .name("matter-switchboard")
    .description("Local Matter power-strip controller and API")
    .version("0.1.0");

  program
    .command("init")
    .description("Initialize user-local configuration and credentials")
    .action(init);
  program
    .command("server")
    .description("Run the API and Matter controller")
    .action(runLockedServer);

  const mock = program.command("mock").description("Manage persistent two-socket mock strips");
  mock
    .command("add <slug>")
    .description("Add a production-capable mock strip")
    .action(async (slug: string) => {
      const { data } = await adminRequest("POST", "/admin/mocks", { slug });
      console.log(JSON.stringify(data, null, 2));
    });
  mock
    .command("list")
    .description("List mock strips")
    .action(async () => {
      const { data } = await adminRequest<Array<Record<string, unknown>>>("GET", "/admin/devices");
      deviceRows(data.filter((item) => item.kind === "mock"));
    });
  mock
    .command("remove <slug>")
    .description("Remove a mock strip and its saved state")
    .action(async (slug: string) => {
      await adminRequest("DELETE", `/admin/mocks/${encodeURIComponent(slug)}`);
      console.log(`Removed mock '${slug}'.`);
    });

  const device = program.command("device").description("Manage Matter devices");
  device
    .command("commission [slug]")
    .description("Commission a strip using a multi-admin setup code")
    .option(
      "--allow-attestation-bypass",
      "Accept attestation findings for this commission instead of rejecting them",
    )
    .action(async (slug: string | undefined, options: { allowAttestationBypass?: boolean }) => {
      const chosenSlug = slug || (await ask("Device slug: "));
      const setupCode = await ask("Temporary Matter setup code: ", true);
      const { data } = await adminRequest("POST", "/admin/devices/commission", {
        setupCode,
        slug: chosenSlug,
        ...(options.allowAttestationBypass ? { allowAttestationBypass: true } : {}),
      });
      console.log(`Commissioned '${chosenSlug}':`);
      console.log(JSON.stringify(data, null, 2));
    });
  device
    .command("list")
    .description("List registered devices")
    .action(async () => {
      const { data } = await adminRequest<Array<Record<string, unknown>>>("GET", "/admin/devices");
      deviceRows(data);
    });
  device
    .command("show <slug>")
    .description("Show device and outlet information")
    .action(async (slug: string) => {
      const { data } = await adminRequest<Array<Record<string, unknown>>>("GET", "/admin/devices");
      const found = data.find((item) => item.slug === slug);
      if (!found) throw new Error(`Device '${slug}' was not found`);
      console.log(JSON.stringify(found, null, 2));
    });
  device
    .command("rename <slug> <newSlug>")
    .description("Change a device's API slug")
    .action(async (slug: string, newSlug: string) => {
      const { data } = await adminRequest(
        "POST",
        `/admin/devices/${encodeURIComponent(slug)}/rename`,
        { slug: newSlug },
      );
      console.log(JSON.stringify(data, null, 2));
    });
  device
    .command("ping <slug>")
    .description("Check Matter reachability")
    .action(async (slug: string) => {
      const { data } = await adminRequest(
        "POST",
        `/admin/devices/${encodeURIComponent(slug)}/ping`,
      );
      console.log(JSON.stringify(data, null, 2));
    });
  device
    .command("decommission-self <slug>")
    .description("Remove the Switchboard fabric from a reachable strip")
    .action(async (slug: string) => {
      const confirmation = await ask(
        `Remove the Matter Switchboard fabric from '${slug}'? Type '${slug}': `,
      );
      if (confirmation !== slug)
        throw new Error("Confirmation did not match; device was not changed");
      await adminRequest("DELETE", `/admin/devices/${encodeURIComponent(slug)}/decommission-self`);
      console.log(`Decommissioned '${slug}' from the Switchboard fabric.`);
    });
  device
    .command("forget-local <slug>")
    .description("Forget a device locally without removing its device fabric")
    .action(async (slug: string) => {
      const confirmation = await ask(
        `Forget '${slug}' locally? The Matter fabric may remain on the device. Type '${slug}': `,
      );
      if (confirmation !== slug)
        throw new Error("Confirmation did not match; local state was not changed");
      await adminRequest("DELETE", `/admin/devices/${encodeURIComponent(slug)}/forget-local`);
      console.log(`Forgot '${slug}' locally. The device may still hold this Matter fabric.`);
    });
  device
    .command("endpoints <slug>")
    .description("List endpoint identifiers")
    .action(async (slug: string) => {
      const { data } = await adminRequest<Array<Record<string, unknown>>>("GET", "/admin/devices");
      const found = data.find((item) => item.slug === slug);
      if (!found) throw new Error(`Device '${slug}' was not found`);
      console.log(JSON.stringify(found.endpoints, null, 2));
    });

  const fabric = program.command("fabric").description("Inspect and remove Matter fabrics");
  fabric
    .command("list <slug>")
    .description("List fabrics reported by a Matter device")
    .action(async (slug: string) => {
      const { data } = await adminRequest(
        "GET",
        `/admin/devices/${encodeURIComponent(slug)}/fabrics`,
      );
      console.log(JSON.stringify(data, null, 2));
    });
  fabric
    .command("remove <slug> <fabricIndex>")
    .description("Remove another fabric after explicit label confirmation")
    .option("--yes", "Confirm after typing the exact fabric label")
    .option(
      "--confirm-fabric-label <label>",
      "Exact fabric label, or the fabric index when the label is empty",
    )
    .action(
      async (
        slug: string,
        fabricIndex: string,
        options: { yes?: boolean; confirmFabricLabel?: string },
      ) => {
        const { data: fabrics } = await adminRequest<
          Array<{ fabricIndex: number; label: string; vendorId: number }>
        >("GET", `/admin/devices/${encodeURIComponent(slug)}/fabrics`);
        const target = fabrics.find((item) => item.fabricIndex === Number(fabricIndex));
        if (!target) throw new Error(`Fabric index ${fabricIndex} was not found`);
        const expected = fabricRemovalConfirmation(target);
        const prompt =
          target.label.length > 0
            ? `Target fabric '${target.label}' (vendor ${target.vendorId}). Type the exact label to remove it: `
            : `Target fabric has no label (index ${target.fabricIndex}, vendor ${target.vendorId}). Type ${expected} to remove it: `;
        const entered = options.confirmFabricLabel ?? (await ask(prompt));
        if (entered !== expected)
          throw new Error("Confirmation did not match; fabric was not removed");
        if (options.confirmFabricLabel && !options.yes)
          throw new Error("Non-interactive removal also requires --yes");
        await adminRequest(
          "DELETE",
          `/admin/devices/${encodeURIComponent(slug)}/fabrics/${fabricIndex}`,
          { confirmLabel: entered },
        );
        console.log(`Removed fabric ${fabricIndex} from '${slug}'.`);
      },
    );

  const key = program.command("key").description("Create and revoke remote API keys");
  key
    .command("create")
    .requiredOption("--name <name>")
    .requiredOption("--scope <scope>", "read or control")
    .option("--devices <slugs>", "comma-separated device slug allowlist")
    .action(async (options: { name: string; scope: string; devices?: string }) => {
      if (options.scope !== "read" && options.scope !== "control")
        throw new Error("Scope must be read or control");
      const devices =
        options.devices
          ?.split(",")
          .map((slug) => slug.trim())
          .filter(Boolean) ?? null;
      const { data } = await adminRequest("POST", "/admin/keys", {
        name: options.name,
        scope: options.scope,
        devices,
      });
      console.log("Copy this key now; it is shown only once:");
      console.log((data as { token: string }).token);
      console.log(JSON.stringify({ ...(data as object), token: "[shown above]" }, null, 2));
    });
  key.command("list").action(async () => {
    const { data } = await adminRequest("GET", "/admin/keys");
    console.log(JSON.stringify(data, null, 2));
  });
  key.command("revoke <keyId>").action(async (keyId: string) => {
    await adminRequest("DELETE", `/admin/keys/${encodeURIComponent(keyId)}`);
    console.log(`Revoked key '${keyId}'.`);
  });

  const config = program.command("config").description("Inspect or update service settings");
  config.command("show").action(async () => {
    const { data } = await adminRequest("GET", "/admin/config");
    console.log(JSON.stringify(data, null, 2));
  });
  config.command("set <name> <value>").action(async (name: string, value: string) => {
    const { data: current } = await adminRequest<Record<string, unknown>>("GET", "/admin/config");
    const numeric = ["apiPort", "adminPort"];
    const booleans = ["allowAttestationBypass"];
    let parsed: unknown = value;
    if (numeric.includes(name)) parsed = Number(value);
    if (booleans.includes(name)) {
      if (value !== "true" && value !== "false") {
        throw new Error(`${name} must be true or false`);
      }
      parsed = value === "true";
    }
    if (name === "logLevel") {
      const level = value.toLowerCase();
      if (!(logLevels as readonly string[]).includes(level)) {
        throw new Error("logLevel must be debug, info, notice, warn, error, or fatal");
      }
      parsed = level;
    }
    if (
      numeric.includes(name) &&
      (!Number.isInteger(parsed) || Number(parsed) < 1024 || Number(parsed) > 65535)
    ) {
      throw new Error(`${name} must be an integer from 1024 through 65535`);
    }
    if (!(name in current) || name === "adminHost")
      throw new Error(`Setting '${name}' cannot be changed`);
    const { data } = await adminRequest("PUT", "/admin/config", { ...current, [name]: parsed });
    console.log(JSON.stringify(data, null, 2));
    if (name === "logLevel") {
      console.log("Log level applied to the running service.");
    } else {
      console.log(
        "Restart Matter Switchboard for listener or Matter-network changes to take effect.",
      );
    }
  });

  program
    .command("admin-credential")
    .description("Rotate local administrator API credential")
    .command("rotate")
    .action(async () => {
      const token = createSecret("msb_admin");
      await fs.writeFile(files.adminCredential, `${token}\n`, { mode: 0o600 });
      await fs.chmod(files.adminCredential, 0o600);
      console.log("Rotated administrator credential. Existing user API keys were not changed.");
    });

  await program.parseAsync(process.argv);
}

async function main(): Promise<void> {
  if (process.argv[2] === "_server-child") {
    await runServerChild();
    return;
  }
  await createProgram();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
