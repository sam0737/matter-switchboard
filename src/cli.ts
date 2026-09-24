#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addMock,
  commissionDevice,
  createKey,
  decommissionSelf,
  forgetLocal,
  getConfig,
  listDevices,
  listFabrics,
  listKeys,
  parseConfigValue,
  pingDevice,
  putConfig,
  removeFabric,
  removeMock,
  renameDevice,
  shareDevice,
  deleteKey,
  rotateAdminCredential,
  type FabricRecord,
} from "./admin-api.js";
import { initConfig, loadConfig } from "./config.js";
import { confirmedValue, fabricRemovalConfirmation, requiredArgument } from "./confirm.js";
import { deviceAllowlist } from "./inventory.js";
import { files, ensureDirectories } from "./paths.js";
import { startServer } from "./server.js";
import {
  SHARE_TIMEOUT_DEFAULT_SECONDS,
  SHARE_TIMEOUT_MAX_SECONDS,
  SHARE_TIMEOUT_MIN_SECONDS,
  shareTimeoutSeconds,
} from "./share.js";
import { shouldLaunchTui } from "./tui/launch.js";

const cliPath = fileURLToPath(import.meta.url);

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

async function argument(
  value: string | undefined,
  name: string,
  prompt: string,
  hidden = false,
): Promise<string> {
  return requiredArgument({
    provided: value,
    isTTY: Boolean(process.stdin.isTTY),
    name,
    read: () => ask(prompt, hidden),
  });
}

async function confirmTypedSlug(slug: string, prompt: string, mismatch: string): Promise<void> {
  if (!process.stdin.isTTY) return;
  const entered = await ask(prompt);
  if (entered !== slug) throw new Error(mismatch);
}

async function confirm(input: {
  provided: string | undefined;
  flag: string;
  prompt: string;
  hidden?: boolean;
  expected?: string;
  mismatch: string;
}): Promise<string> {
  return confirmedValue({
    provided: input.provided,
    isTTY: Boolean(process.stdin.isTTY),
    flag: input.flag,
    mismatch: input.mismatch,
    read: () => ask(input.prompt, input.hidden ?? false),
    ...(input.expected === undefined ? {} : { expected: input.expected }),
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

function deviceRows(
  devices: Array<{
    slug: string;
    kind: string;
    endpoints?: unknown;
    endpointCount?: unknown;
    nodeId?: unknown;
  }>,
): void {
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
    .version("1.0.0");

  program
    .command("init")
    .description("Initialize user-local configuration and credentials")
    .action(init);
  program
    .command("server")
    .description("Run the API and Matter controller")
    .action(runLockedServer);
  program
    .command("tui")
    .description("Open the live dashboard and configure screens")
    .action(async () => {
      const { runTui } = await import("./tui/app.js");
      await runTui();
    });

  const mock = program.command("mock").description("Manage persistent two-socket mock strips");
  mock
    .command("add")
    .description("Add a production-capable mock strip")
    .argument("[slug]", "device slug")
    .action(async (slug: string | undefined) => {
      const chosen = await argument(slug, "slug", "Device slug: ");
      console.log(JSON.stringify(await addMock(chosen), null, 2));
    });
  mock
    .command("list")
    .description("List mock strips")
    .action(async () => {
      deviceRows((await listDevices()).filter((item) => item.kind === "mock"));
    });
  mock
    .command("remove")
    .description("Remove a mock strip and its saved state")
    .argument("[slug]", "device slug")
    .action(async (slug: string | undefined) => {
      const chosen = await argument(slug, "slug", "Device slug: ");
      await removeMock(chosen);
      console.log(`Removed mock '${chosen}'.`);
    });

  const device = program.command("device").description("Manage Matter devices");
  device
    .command("commission")
    .description("Commission a strip using a multi-admin setup code")
    .argument("[slug]", "device slug")
    .argument("[setup-code]", "temporary Matter setup code")
    .option(
      "--allow-attestation-bypass",
      "Accept attestation findings for this commission instead of rejecting them",
    )
    .action(
      async (
        slug: string | undefined,
        setupCode: string | undefined,
        options: { allowAttestationBypass?: boolean },
      ) => {
        const chosenSlug = await argument(slug, "slug", "Device slug: ");
        const code = await argument(setupCode, "setup-code", "Temporary Matter setup code: ", true);
        const data = await commissionDevice({
          slug: chosenSlug,
          setupCode: code,
          ...(options.allowAttestationBypass ? { allowAttestationBypass: true } : {}),
        });
        console.log(`Commissioned '${chosenSlug}':`);
        console.log(JSON.stringify(data, null, 2));
      },
    );
  device
    .command("share")
    .description("Open a multi-admin sharing window on a commissioned strip")
    .argument("[slug]", "device slug")
    .option(
      "--timeout <seconds>",
      `Window length in seconds, from ${SHARE_TIMEOUT_MIN_SECONDS} through ${SHARE_TIMEOUT_MAX_SECONDS}`,
      String(SHARE_TIMEOUT_DEFAULT_SECONDS),
    )
    .action(async (slug: string | undefined, options: { timeout?: string }) => {
      const chosen = await argument(slug, "slug", "Device slug: ");
      const timeoutSeconds = shareTimeoutSeconds(options.timeout);
      const window = await shareDevice(chosen, timeoutSeconds);
      console.log(
        `Opened a sharing window for '${chosen}'. Give the manual pairing code to the other administrator before it expires.`,
      );
      console.log(JSON.stringify(window, null, 2));
    });
  device
    .command("list")
    .description("List registered devices")
    .action(async () => {
      deviceRows(await listDevices());
    });
  device
    .command("show")
    .description("Show device and outlet information")
    .argument("[slug]", "device slug")
    .action(async (slug: string | undefined) => {
      const chosen = await argument(slug, "slug", "Device slug: ");
      const found = (await listDevices()).find((item) => item.slug === chosen);
      if (!found) throw new Error(`Device '${chosen}' was not found`);
      console.log(JSON.stringify(found, null, 2));
    });
  device
    .command("rename")
    .description("Change a device's API slug")
    .argument("[slug]", "current device slug")
    .argument("[new-slug]", "new device slug")
    .action(async (slug: string | undefined, newSlug: string | undefined) => {
      const current = await argument(slug, "slug", "Device slug: ");
      const next = await argument(newSlug, "new-slug", "New device slug: ");
      console.log(JSON.stringify(await renameDevice(current, next), null, 2));
    });
  device
    .command("ping")
    .description("Check Matter reachability")
    .argument("[slug]", "device slug")
    .action(async (slug: string | undefined) => {
      const chosen = await argument(slug, "slug", "Device slug: ");
      console.log(JSON.stringify(await pingDevice(chosen), null, 2));
    });
  device
    .command("decommission-self")
    .description("Remove the Switchboard fabric from a reachable strip")
    .argument("[slug]", "device slug")
    .action(async (slug: string | undefined) => {
      const chosen = await argument(slug, "slug", "Device slug: ");
      await confirmTypedSlug(
        chosen,
        `Remove the Matter Switchboard fabric from '${chosen}'? Type '${chosen}': `,
        "Confirmation did not match; device was not changed",
      );
      await decommissionSelf(chosen);
      console.log(`Decommissioned '${chosen}' from the Switchboard fabric.`);
    });
  device
    .command("forget-local")
    .description("Forget a device locally without removing its device fabric")
    .argument("[slug]", "device slug")
    .action(async (slug: string | undefined) => {
      const chosen = await argument(slug, "slug", "Device slug: ");
      await confirmTypedSlug(
        chosen,
        `Forget '${chosen}' locally? The Matter fabric may remain on the device. Type '${chosen}': `,
        "Confirmation did not match; local state was not changed",
      );
      await forgetLocal(chosen);
      console.log(`Forgot '${chosen}' locally. The device may still hold this Matter fabric.`);
    });
  device
    .command("endpoints")
    .description("List endpoint identifiers")
    .argument("[slug]", "device slug")
    .action(async (slug: string | undefined) => {
      const chosen = await argument(slug, "slug", "Device slug: ");
      const found = (await listDevices()).find((item) => item.slug === chosen);
      if (!found) throw new Error(`Device '${chosen}' was not found`);
      console.log(JSON.stringify(found.endpoints, null, 2));
    });

  const fabric = program.command("fabric").description("Inspect and remove Matter fabrics");
  fabric
    .command("list")
    .description("List fabrics reported by a Matter device")
    .argument("[slug]", "device slug")
    .action(async (slug: string | undefined) => {
      const chosen = await argument(slug, "slug", "Device slug: ");
      console.log(JSON.stringify(await listFabrics(chosen), null, 2));
    });
  fabric
    .command("remove")
    .description("Remove another fabric after explicit label confirmation")
    .argument("[slug]", "device slug")
    .argument("[fabric-index]", "fabric index")
    .option(
      "--confirm-fabric-label <label>",
      "Exact fabric label, or the fabric index when the label is empty",
    )
    .action(
      async (
        slug: string | undefined,
        fabricIndex: string | undefined,
        options: { confirmFabricLabel?: string },
      ) => {
        const chosen = await argument(slug, "slug", "Device slug: ");
        const index = await argument(fabricIndex, "fabric-index", "Fabric index: ");
        const fabrics = await listFabrics(chosen);
        const target = fabrics.find((item: FabricRecord) => item.fabricIndex === Number(index));
        if (!target) throw new Error(`Fabric index ${index} was not found`);
        const expected = fabricRemovalConfirmation(target);
        const prompt =
          target.label.length > 0
            ? `Target fabric '${target.label}' (vendor ${target.vendorId}). Type the exact label to remove it: `
            : `Target fabric has no label (index ${target.fabricIndex}, vendor ${target.vendorId}). Type ${expected} to remove it: `;
        const entered = await confirm({
          provided: options.confirmFabricLabel,
          flag: "--confirm-fabric-label",
          prompt,
          expected,
          mismatch: "Confirmation did not match; fabric was not removed",
        });
        await removeFabric(chosen, Number(index), entered);
        console.log(`Removed fabric ${index} from '${chosen}'.`);
      },
    );

  const key = program.command("key").description("Create and delete remote API keys");
  key
    .command("create")
    .description("Create a remote API key")
    .argument("[name]", "key name")
    .argument("[scope]", "read or control")
    .argument("[devices...]", "device slugs; omit for all devices")
    .action(async (name: string | undefined, scope: string | undefined, devices: string[]) => {
      const chosenName = await argument(name, "name", "Key name: ");
      const chosenScope = await argument(scope, "scope", "Scope (read or control): ");
      if (chosenScope !== "read" && chosenScope !== "control")
        throw new Error("Scope must be read or control");
      let deviceArgs = devices;
      if (deviceArgs.length === 0 && process.stdin.isTTY) {
        deviceArgs = [await ask("Devices (space or comma separated, empty for all): ")];
      }
      const data = await createKey({
        name: chosenName,
        scope: chosenScope,
        devices: deviceAllowlist(deviceArgs),
      });
      console.log("Copy this key now; it is shown only once:");
      console.log(data.token);
      console.log(JSON.stringify({ ...data, token: "[shown above]" }, null, 2));
    });
  key.command("list").action(async () => {
    console.log(JSON.stringify(await listKeys(), null, 2));
  });
  key
    .command("delete")
    .description("Delete a remote API key by name")
    .argument("[name]", "key name")
    .action(async (name: string | undefined) => {
      const chosen = await argument(name, "name", "Key name: ");
      await deleteKey(chosen);
      console.log(`Deleted key '${chosen}'.`);
    });

  const config = program.command("config").description("Inspect or update service settings");
  config.command("show").action(async () => {
    console.log(JSON.stringify(await getConfig(), null, 2));
  });
  config
    .command("set")
    .description("Update one service setting")
    .argument("[name]", "setting name")
    .argument("[value]", "setting value")
    .action(async (name: string | undefined, value: string | undefined) => {
      const setting = await argument(name, "name", "Setting name: ");
      const raw = await argument(value, "value", "Setting value: ");
      const current = await getConfig();
      const parsed = parseConfigValue(setting, raw, current);
      const data = await putConfig({ ...current, [setting]: parsed });
      console.log(JSON.stringify(data, null, 2));
      if (setting === "logLevel") {
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
      await rotateAdminCredential();
      console.log("Rotated administrator credential. Existing user API keys were not changed.");
    });

  await program.parseAsync(process.argv);
}

async function main(): Promise<void> {
  if (process.argv[2] === "_server-child") {
    await runServerChild();
    return;
  }
  if (shouldLaunchTui(process.argv, Boolean(process.stdout.isTTY))) {
    const { runTui } = await import("./tui/app.js");
    await runTui();
    return;
  }
  await createProgram();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
