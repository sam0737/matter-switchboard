import fs from "node:fs/promises";
import { loadConfig, normalizeLogLevel, readAdminToken } from "./config.js";
import type { DeviceRecord, OutletRecord } from "./model.js";
import { files } from "./paths.js";
import { createSecret } from "./security.js";
import type { ShareWindow } from "./share.js";

export class AdminApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminApiError";
  }
}

export interface ApiResponse<T = unknown> {
  response: Response;
  data: T;
}

export interface FabricRecord {
  fabricIndex: number;
  label: string;
  vendorId: number;
}

export interface PowerResult {
  device: string;
  kind: string;
  endpointId: number;
  requestedOn: boolean;
  observed: OutletRecord;
}

export interface KeyCreated {
  id: string;
  name: string;
  scope: "read" | "control";
  devices: string[] | null;
  createdAt: string;
  token: string;
}

const SERVER_DOWN = "Administrator API is not running. Start it with: matter-switchboard server";

function connectionFailed(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "fetch failed") return true;
  const cause = error.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = String(cause.code);
    return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND";
  }
  return false;
}

export async function adminRequest<T = unknown>(
  method: string,
  pathname: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<ApiResponse<T>> {
  const config = await loadConfig();
  const token = await readAdminToken();
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${config.adminPort}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (connectionFailed(error)) throw new AdminApiError(SERVER_DOWN);
    throw error;
  }
  const text = response.status === 204 ? "" : await response.text();
  const data = text ? (JSON.parse(text) as T) : (undefined as T);
  if (!response.ok) {
    const error = data as { message?: string; error?: string };
    throw new AdminApiError(error?.message ?? `HTTP ${response.status} ${response.statusText}`);
  }
  return { response, data };
}

export async function listDevices(): Promise<DeviceRecord[]> {
  const { data } = await adminRequest<DeviceRecord[]>("GET", "/admin/devices");
  return data;
}

export async function addMock(slug: string): Promise<DeviceRecord> {
  const { data } = await adminRequest<DeviceRecord>("POST", "/admin/mocks", { slug });
  return data;
}

export async function removeMock(slug: string): Promise<void> {
  await adminRequest("DELETE", `/admin/mocks/${encodeURIComponent(slug)}`);
}

export async function commissionDevice(input: {
  slug: string;
  setupCode: string;
  allowAttestationBypass?: boolean;
}): Promise<DeviceRecord> {
  const { data } = await adminRequest<DeviceRecord>("POST", "/admin/devices/commission", {
    setupCode: input.setupCode,
    slug: input.slug,
    ...(input.allowAttestationBypass ? { allowAttestationBypass: true } : {}),
  });
  return data;
}

export async function shareDevice(slug: string, timeoutSeconds?: number): Promise<ShareWindow> {
  const { data } = await adminRequest<ShareWindow>(
    "POST",
    `/admin/devices/${encodeURIComponent(slug)}/share`,
    timeoutSeconds === undefined ? {} : { timeoutSeconds },
  );
  return data;
}

export async function renameDevice(slug: string, newSlug: string): Promise<DeviceRecord> {
  const { data } = await adminRequest<DeviceRecord>(
    "POST",
    `/admin/devices/${encodeURIComponent(slug)}/rename`,
    { slug: newSlug },
  );
  return data;
}

export async function pingDevice(slug: string): Promise<unknown> {
  const { data } = await adminRequest("POST", `/admin/devices/${encodeURIComponent(slug)}/ping`);
  return data;
}

export async function decommissionSelf(slug: string): Promise<void> {
  await adminRequest("DELETE", `/admin/devices/${encodeURIComponent(slug)}/decommission-self`);
}

export async function forgetLocal(slug: string): Promise<void> {
  await adminRequest("DELETE", `/admin/devices/${encodeURIComponent(slug)}/forget-local`);
}

export async function listFabrics(slug: string): Promise<FabricRecord[]> {
  const { data } = await adminRequest<FabricRecord[]>(
    "GET",
    `/admin/devices/${encodeURIComponent(slug)}/fabrics`,
  );
  return data;
}

export async function removeFabric(
  slug: string,
  fabricIndex: number,
  confirmLabel: string,
): Promise<void> {
  await adminRequest(
    "DELETE",
    `/admin/devices/${encodeURIComponent(slug)}/fabrics/${fabricIndex}`,
    { confirmLabel },
  );
}

export async function createKey(input: {
  name: string;
  scope: "read" | "control";
  devices: string[] | null;
}): Promise<KeyCreated> {
  const { data } = await adminRequest<KeyCreated>("POST", "/admin/keys", {
    name: input.name,
    scope: input.scope,
    ...(input.devices ? { devices: input.devices } : {}),
  });
  return data;
}

export interface PublicKey {
  id: string;
  name: string;
  scope: "read" | "control";
  devices: string[] | null;
  createdAt: string;
  revokedAt: string | null;
}

export async function listKeys(): Promise<PublicKey[]> {
  const { data } = await adminRequest<PublicKey[]>("GET", "/admin/keys");
  return data;
}

export async function deleteKey(name: string): Promise<void> {
  await adminRequest("DELETE", `/admin/keys/${encodeURIComponent(name)}`);
}

export async function getConfig(): Promise<Record<string, unknown>> {
  const { data } = await adminRequest<Record<string, unknown>>("GET", "/admin/config");
  return data;
}

export async function putConfig(config: Record<string, unknown>): Promise<unknown> {
  const { data } = await adminRequest("PUT", "/admin/config", config);
  return data;
}

export async function readOutletState(slug: string, endpointId: number): Promise<OutletRecord> {
  const { data } = await adminRequest<OutletRecord>(
    "GET",
    `/v1/devices/${encodeURIComponent(slug)}/endpoints/${endpointId}/state`,
    undefined,
    20_000,
  );
  return data;
}

export async function setOutletPower(
  slug: string,
  endpointId: number,
  on: boolean,
): Promise<PowerResult> {
  const { data } = await adminRequest<PowerResult>(
    "PUT",
    `/v1/devices/${encodeURIComponent(slug)}/endpoints/${endpointId}/power`,
    { on },
    20_000,
  );
  return data;
}

export function parseConfigValue(
  name: string,
  value: string,
  current: Record<string, unknown>,
): unknown {
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
  if (name === "logLevel") parsed = normalizeLogLevel(value);
  if (
    numeric.includes(name) &&
    (!Number.isInteger(parsed) || Number(parsed) < 1024 || Number(parsed) > 65535)
  ) {
    throw new Error(`${name} must be an integer from 1024 through 65535`);
  }
  if (!(name in current) || name === "adminHost")
    throw new Error(`Setting '${name}' cannot be changed`);
  return parsed;
}

export async function rotateAdminCredential(): Promise<void> {
  const token = createSecret("msb_admin");
  await fs.writeFile(files.adminCredential, `${token}\n`, { mode: 0o600 });
  await fs.chmod(files.adminCredential, 0o600);
}

export function requireTypedConfirmation(entered: string, expected: string, message: string): void {
  if (entered !== expected) throw new Error(message);
}
