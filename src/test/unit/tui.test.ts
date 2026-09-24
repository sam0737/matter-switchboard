import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceRecord, OutletRecord } from "../../model.js";
import { shouldLaunchTui } from "../../tui/launch.js";
import {
  applyInventory,
  applyOutletRead,
  applyStripReadFailure,
  beginToggle,
  closeConfigure,
  currentEpoch,
  initialState,
  nextPollSlug,
  openConfigure,
  pollerPaused,
} from "../../tui/model.js";

test("no-args TTY opens the TUI and existing flags stay with Commander", () => {
  assert.equal(shouldLaunchTui(["node", "cli.js"], true), true);
  assert.equal(shouldLaunchTui(["node", "cli.js"], false), false);
  assert.equal(shouldLaunchTui(["node", "cli.js", "tui"], false), true);
  assert.equal(shouldLaunchTui(["node", "cli.js", "tui", "--help"], true), false);
  assert.equal(shouldLaunchTui(["node", "cli.js", "--help"], true), false);
  assert.equal(shouldLaunchTui(["node", "cli.js", "--version"], true), false);
  assert.equal(shouldLaunchTui(["node", "cli.js", "device", "list"], true), false);
});

function outlet(id: number, on = false, watts: number | null = null): OutletRecord {
  return {
    endpointId: id,
    name: `Outlet ${id}`,
    kind: "socket",
    on,
    currentAmps: watts === null ? null : 0.1,
    voltageVolts: watts === null ? null : 230,
    activePowerWatts: watts,
    measurementSupport: {
      current: watts !== null,
      voltage: watts !== null,
      activePower: watts !== null,
    },
    observedAt: "2026-01-01T00:00:00.000Z",
  };
}

function device(slug: string, endpoints: OutletRecord[]): DeviceRecord {
  return {
    id: slug,
    slug,
    kind: "mock",
    nodeId: null,
    vendorName: "Test",
    productName: "Strip",
    available: true,
    lastSeen: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    endpoints,
  };
}

test("configure pauses the poller", () => {
  let state = applyInventory(initialState(), [device("a", [outlet(1), outlet(2)])]);
  assert.equal(nextPollSlug(state, null), "a");
  state = openConfigure(state);
  assert.equal(pollerPaused(state), true);
  assert.equal(nextPollSlug(state, null), undefined);
  state = closeConfigure(state);
  assert.equal(pollerPaused(state), false);
  assert.equal(nextPollSlug(state, null), "a");
});

test("a second toggle is dropped while one is in flight", () => {
  let state = applyInventory(initialState(), [device("a", [outlet(1), outlet(2)])]);
  const first = beginToggle(state);
  assert.ok(first);
  state = first.state;
  assert.equal(state.dashboard.strips[0]?.endpoints[0]?.pending, true);
  assert.equal(beginToggle(state), undefined);
  assert.equal(nextPollSlug(state, null), undefined);
});

test("a failed read keeps last readings and marks the strip unreachable", () => {
  let state = applyInventory(initialState(), [device("a", [outlet(1, true, 23)])]);
  const epoch = currentEpoch(state, "a");
  const live = outlet(1, true, 40);
  live.currentAmps = 0.2;
  state = applyOutletRead(state, "a", live, epoch);
  state = applyStripReadFailure(state, "a", "timed out", epoch);
  const endpoint = state.dashboard.strips[0]?.endpoints[0];
  assert.equal(endpoint?.on, true);
  assert.equal(endpoint?.activePowerWatts, 40);
  assert.equal(endpoint?.currentAmps, 0.2);
  assert.equal(state.dashboard.strips[0]?.available, false);
  assert.equal(state.dashboard.strips[0]?.error, "timed out");
});

test("stale poll results after a toggle do not apply", () => {
  let state = applyInventory(initialState(), [device("a", [outlet(1, false, 0)])]);
  const staleEpoch = currentEpoch(state, "a");
  const started = beginToggle(state);
  assert.ok(started);
  state = started.state;
  const live = outlet(1, true, 12);
  state = applyOutletRead(state, "a", live, staleEpoch);
  assert.equal(state.dashboard.strips[0]?.endpoints[0]?.on, false);
  assert.equal(state.dashboard.strips[0]?.endpoints[0]?.pending, true);
});
