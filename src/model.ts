export type Scope = "read" | "control";
export type DeviceKind = "matter" | "mock";

export interface OutletRecord {
  endpointId: number;
  name: string;
  kind: "socket";
  on: boolean;
  currentAmps: number | null;
  voltageVolts: number | null;
  activePowerWatts: number | null;
  measurementSupport: { current: boolean; voltage: boolean; activePower: boolean };
  observedAt: string;
}

export interface DeviceRecord {
  id: string;
  slug: string;
  kind: DeviceKind;
  nodeId: string | null;
  vendorName: string | null;
  productName: string | null;
  available: boolean;
  lastSeen: string | null;
  createdAt: string;
  endpoints: OutletRecord[];
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  verifier: string;
  scope: Scope;
  devices: string[] | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface PersistedState {
  version: 1;
  devices: DeviceRecord[];
  apiKeys: ApiKeyRecord[];
}

export interface PublicDevice extends Omit<DeviceRecord, "endpoints"> {
  endpointCount: number;
}

export const initialState = (): PersistedState => ({ version: 1, devices: [], apiKeys: [] });
