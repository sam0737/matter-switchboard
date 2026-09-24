import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { files, ensureDirectories } from "./paths.js";

export interface SwitchboardConfig {
  apiHost: string;
  apiPort: number;
  adminHost: "127.0.0.1";
  adminPort: number;
  matterCountryCode: string;
  allowAttestationBypass: boolean;
}

export const defaultConfig: SwitchboardConfig = {
  apiHost: "0.0.0.0",
  apiPort: 8090,
  adminHost: "127.0.0.1",
  adminPort: 8091,
  matterCountryCode: "CN",
  allowAttestationBypass: false,
};

export function validateConfig(config: SwitchboardConfig): SwitchboardConfig {
  if (
    typeof config.apiHost !== "string" ||
    config.apiHost.length === 0 ||
    config.apiHost.trim() !== config.apiHost
  ) {
    throw new Error("apiHost must be a non-empty host or IP address");
  }
  if (!Number.isInteger(config.apiPort) || config.apiPort < 1024 || config.apiPort > 65535) {
    throw new Error("apiPort must be an integer between 1024 and 65535");
  }
  if (!Number.isInteger(config.adminPort) || config.adminPort < 1024 || config.adminPort > 65535) {
    throw new Error("adminPort must be an integer between 1024 and 65535");
  }
  if (config.apiPort === config.adminPort) throw new Error("API and admin ports must differ");
  if (config.adminHost !== "127.0.0.1") throw new Error("adminHost must remain 127.0.0.1");
  if (!/^[A-Z]{2}$/.test(config.matterCountryCode)) {
    throw new Error("matterCountryCode must be a two-letter uppercase code");
  }
  if (typeof config.allowAttestationBypass !== "boolean") {
    throw new Error("allowAttestationBypass must be true or false");
  }
  return config;
}

export async function initConfig(): Promise<{ created: boolean; adminToken?: string }> {
  await ensureDirectories();
  try {
    await fs.access(files.config);
    try {
      await fs.access(files.adminCredential);
    } catch {
      const adminToken = randomBytes(32).toString("base64url");
      await fs.writeFile(files.adminCredential, `${adminToken}\n`, { mode: 0o600, flag: "wx" });
      return { created: false, adminToken };
    }
    return { created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = `${files.config}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(defaultConfig, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temp, files.config);
  await fs.chmod(files.config, 0o600);
  const adminToken = randomBytes(32).toString("base64url");
  await fs.writeFile(files.adminCredential, `${adminToken}\n`, { mode: 0o600, flag: "wx" });
  return { created: true, adminToken };
}

export async function loadConfig(): Promise<SwitchboardConfig> {
  try {
    const config = JSON.parse(
      await fs.readFile(files.config, "utf8"),
    ) as Partial<SwitchboardConfig>;
    const merged = { ...defaultConfig, ...config };
    return validateConfig(merged);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Not initialized. Run matter-switchboard init first.");
    throw error;
  }
}

export async function saveConfig(config: SwitchboardConfig): Promise<void> {
  validateConfig(config);
  const temp = `${files.config}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await fs.rename(temp, files.config);
  await fs.chmod(files.config, 0o600);
}

export async function readAdminToken(): Promise<string> {
  return (await fs.readFile(files.adminCredential, "utf8")).trim();
}
