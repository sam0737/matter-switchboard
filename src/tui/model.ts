import type { DeviceRecord, OutletRecord } from "../model.js";

export const POLL_INTERVAL_MS = 5_000;

/** A second read after a toggle, once a late electrical report can land. */
export const TOGGLE_REFRESH_MS = 1_000;

export type Mode = "dashboard" | "configure";

export interface OutletView {
  endpointId: number;
  name: string;
  on: boolean;
  currentAmps: number | null;
  voltageVolts: number | null;
  activePowerWatts: number | null;
  pending: boolean;
}

export interface StripView {
  slug: string;
  kind: "matter" | "mock";
  available: boolean;
  lastSeen: string | null;
  endpoints: OutletView[];
  error: string | null;
}

export interface DashboardState {
  strips: StripView[];
  focusIndex: number;
  inFlight: Record<string, true>;
  stripEpochs: Record<string, number>;
  serverDown: boolean;
  notice: string | null;
}

export interface TuiState {
  mode: Mode;
  dashboard: DashboardState;
}

export interface SocketRef {
  stripIndex: number;
  endpointIndex: number;
  slug: string;
  endpointId: number;
}

export function outletKey(slug: string, endpointId: number): string {
  return `${slug}:${endpointId}`;
}

export function initialState(): TuiState {
  return {
    mode: "dashboard",
    dashboard: {
      strips: [],
      focusIndex: 0,
      inFlight: {},
      stripEpochs: {},
      serverDown: false,
      notice: null,
    },
  };
}

export function pollerPaused(state: TuiState): boolean {
  return state.mode === "configure";
}

export function openConfigure(state: TuiState): TuiState {
  return { ...state, mode: "configure" };
}

export function closeConfigure(state: TuiState): TuiState {
  return { ...state, mode: "dashboard" };
}

export function flattenSockets(strips: StripView[]): SocketRef[] {
  const rows: SocketRef[] = [];
  for (let stripIndex = 0; stripIndex < strips.length; stripIndex++) {
    const strip = strips[stripIndex]!;
    for (let endpointIndex = 0; endpointIndex < strip.endpoints.length; endpointIndex++) {
      const endpoint = strip.endpoints[endpointIndex]!;
      rows.push({
        stripIndex,
        endpointIndex,
        slug: strip.slug,
        endpointId: endpoint.endpointId,
      });
    }
  }
  return rows;
}

export function focusedSocket(state: TuiState): SocketRef | undefined {
  return flattenSockets(state.dashboard.strips)[state.dashboard.focusIndex];
}

export function moveFocus(state: TuiState, delta: number): TuiState {
  const rows = flattenSockets(state.dashboard.strips);
  if (rows.length === 0) return state;
  const next = (state.dashboard.focusIndex + delta + rows.length) % rows.length;
  return { ...state, dashboard: { ...state.dashboard, focusIndex: next } };
}

function stripHasToggle(state: TuiState, slug: string): boolean {
  const prefix = `${slug}:`;
  return Object.keys(state.dashboard.inFlight).some((key) => key.startsWith(prefix));
}

export function nextPollSlug(state: TuiState, afterSlug: string | null): string | undefined {
  if (pollerPaused(state) || state.dashboard.serverDown) return undefined;
  const candidates = state.dashboard.strips.filter((strip) => !stripHasToggle(state, strip.slug));
  if (candidates.length === 0) return undefined;
  if (afterSlug === null) return candidates[0]?.slug;
  const index = candidates.findIndex((strip) => strip.slug === afterSlug);
  if (index === -1) return candidates[0]?.slug;
  return candidates[(index + 1) % candidates.length]?.slug;
}

export function currentEpoch(state: TuiState, slug: string): number {
  return state.dashboard.stripEpochs[slug] ?? 0;
}

export function outletFromRecord(outlet: OutletRecord, pending = false): OutletView {
  return {
    endpointId: outlet.endpointId,
    name: outlet.name,
    on: outlet.on,
    currentAmps: outlet.currentAmps,
    voltageVolts: outlet.voltageVolts,
    activePowerWatts: outlet.activePowerWatts,
    pending,
  };
}

export function stripFromDevice(device: DeviceRecord): StripView {
  return {
    slug: device.slug,
    kind: device.kind,
    available: device.available,
    lastSeen: device.lastSeen,
    error: null,
    endpoints: device.endpoints.map((outlet) => outletFromRecord(outlet)),
  };
}

export function applyInventory(state: TuiState, devices: DeviceRecord[]): TuiState {
  const previous = new Map(state.dashboard.strips.map((strip) => [strip.slug, strip]));
  const strips = devices.map((device) => {
    const old = previous.get(device.slug);
    if (!old) return stripFromDevice(device);
    const oldEndpoints = new Map(old.endpoints.map((endpoint) => [endpoint.endpointId, endpoint]));
    return {
      slug: device.slug,
      kind: device.kind,
      available: old.available,
      lastSeen: device.lastSeen ?? old.lastSeen,
      error: old.error,
      endpoints: device.endpoints.map((outlet) => {
        const prev = oldEndpoints.get(outlet.endpointId);
        if (prev?.pending) return prev;
        if (prev) {
          return {
            ...prev,
            name: outlet.name,
          };
        }
        return outletFromRecord(outlet);
      }),
    };
  });
  const rows = flattenSockets(strips);
  const focusIndex = rows.length === 0 ? 0 : Math.min(state.dashboard.focusIndex, rows.length - 1);
  const inFlight: Record<string, true> = {};
  for (const [key, value] of Object.entries(state.dashboard.inFlight)) {
    const separator = key.lastIndexOf(":");
    const slug = key.slice(0, separator);
    const endpointId = Number(key.slice(separator + 1));
    if (
      strips.some(
        (strip) =>
          strip.slug === slug && strip.endpoints.some((ep) => ep.endpointId === endpointId),
      )
    ) {
      inFlight[key] = value;
    }
  }
  const stripEpochs: Record<string, number> = {};
  for (const strip of strips) {
    const epoch = state.dashboard.stripEpochs[strip.slug];
    if (epoch !== undefined) stripEpochs[strip.slug] = epoch;
  }
  return {
    ...state,
    dashboard: {
      ...state.dashboard,
      strips,
      focusIndex,
      inFlight,
      stripEpochs,
      serverDown: false,
      notice: null,
    },
  };
}

export function applyServerDown(state: TuiState, notice: string): TuiState {
  return {
    ...state,
    dashboard: {
      ...state.dashboard,
      serverDown: true,
      notice,
    },
  };
}

export function clearServerDown(state: TuiState): TuiState {
  return {
    ...state,
    dashboard: {
      ...state.dashboard,
      serverDown: false,
      notice: null,
    },
  };
}

export function canToggle(state: TuiState): boolean {
  if (state.mode !== "dashboard") return false;
  const focused = focusedSocket(state);
  if (!focused) return false;
  return state.dashboard.inFlight[outletKey(focused.slug, focused.endpointId)] === undefined;
}

export function beginToggle(
  state: TuiState,
): { state: TuiState; target: { slug: string; endpointId: number; on: boolean } } | undefined {
  if (!canToggle(state)) return undefined;
  const focused = focusedSocket(state);
  if (!focused) return undefined;
  const outlet = state.dashboard.strips[focused.stripIndex]!.endpoints[focused.endpointIndex]!;
  const key = outletKey(focused.slug, focused.endpointId);
  const epoch = currentEpoch(state, focused.slug) + 1;
  const strips = state.dashboard.strips.map((strip, stripIndex) =>
    stripIndex !== focused.stripIndex
      ? strip
      : {
          ...strip,
          endpoints: strip.endpoints.map((endpoint, endpointIndex) =>
            endpointIndex !== focused.endpointIndex ? endpoint : { ...endpoint, pending: true },
          ),
        },
  );
  return {
    state: {
      ...state,
      dashboard: {
        ...state.dashboard,
        strips,
        inFlight: { ...state.dashboard.inFlight, [key]: true },
        stripEpochs: { ...state.dashboard.stripEpochs, [focused.slug]: epoch },
      },
    },
    target: { slug: focused.slug, endpointId: focused.endpointId, on: !outlet.on },
  };
}

function updateStrip(
  state: TuiState,
  slug: string,
  epoch: number,
  update: (strip: StripView) => StripView,
): TuiState {
  if (currentEpoch(state, slug) !== epoch) return state;
  return {
    ...state,
    dashboard: {
      ...state.dashboard,
      strips: state.dashboard.strips.map((strip) => (strip.slug === slug ? update(strip) : strip)),
    },
  };
}

export function applyOutletRead(
  state: TuiState,
  slug: string,
  outlet: OutletRecord,
  epoch: number,
): TuiState {
  if (state.dashboard.inFlight[outletKey(slug, outlet.endpointId)]) return state;
  return updateStrip(state, slug, epoch, (strip) => ({
    ...strip,
    endpoints: strip.endpoints.map((endpoint) =>
      endpoint.endpointId === outlet.endpointId && !endpoint.pending
        ? outletFromRecord(outlet)
        : endpoint,
    ),
  }));
}

export function applyStripReadFailure(
  state: TuiState,
  slug: string,
  error: string,
  epoch: number,
): TuiState {
  return updateStrip(state, slug, epoch, (strip) => ({
    ...strip,
    available: false,
    error,
  }));
}

export function applyStripReachable(state: TuiState, slug: string, epoch: number): TuiState {
  return updateStrip(state, slug, epoch, (strip) => ({
    ...strip,
    available: true,
    error: null,
    lastSeen: new Date().toISOString(),
  }));
}

export function finishToggle(
  state: TuiState,
  slug: string,
  endpointId: number,
  result: OutletRecord | { error: string },
): TuiState {
  const key = outletKey(slug, endpointId);
  const inFlight = { ...state.dashboard.inFlight };
  delete inFlight[key];
  const strips = state.dashboard.strips.map((strip) => {
    if (strip.slug !== slug) return strip;
    if ("error" in result) {
      return {
        ...strip,
        error: result.error,
        endpoints: strip.endpoints.map((endpoint) =>
          endpoint.endpointId === endpointId ? { ...endpoint, pending: false } : endpoint,
        ),
      };
    }
    return {
      ...strip,
      available: true,
      error: null,
      lastSeen: result.observedAt,
      endpoints: strip.endpoints.map((endpoint) =>
        endpoint.endpointId === endpointId ? outletFromRecord(result) : endpoint,
      ),
    };
  });
  return { ...state, dashboard: { ...state.dashboard, strips, inFlight } };
}
