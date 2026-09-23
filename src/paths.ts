import os from "node:os";
import path from "node:path";

const under = (envName: string, fallback: string, app = "matter-switchboard") =>
  path.join(process.env[envName] || fallback, app);

export const paths = {
  configDir: under("XDG_CONFIG_HOME", path.join(os.homedir(), ".config")),
  dataDir: under("XDG_DATA_HOME", path.join(os.homedir(), ".local", "share")),
  stateDir: under("XDG_STATE_HOME", path.join(os.homedir(), ".local", "state")),
  runtimeDir: process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, "matter-switchboard")
    : path.join(under("XDG_STATE_HOME", path.join(os.homedir(), ".local", "state")), "run"),
};

export const files = {
  config: path.join(paths.configDir, "config.json"),
  adminCredential: path.join(paths.configDir, "admin-token"),
  state: path.join(paths.dataDir, "state.json"),
  matterStorage: path.join(paths.dataDir, "matter"),
  logFile: path.join(paths.stateDir, "switchboard.log"),
  lockFile: path.join(paths.runtimeDir, "server.lock"),
};

export async function ensureDirectories(): Promise<void> {
  const fs = await import("node:fs/promises");
  for (const dir of [
    paths.configDir,
    paths.dataDir,
    paths.stateDir,
    paths.runtimeDir,
    files.matterStorage,
  ]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
  }
}
