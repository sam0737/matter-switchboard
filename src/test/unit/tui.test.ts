import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import { createElement } from "react";
import type { DeviceRecord, OutletRecord } from "../../model.js";
import { KeyHints } from "../../tui/hint.js";
import { shouldLaunchTui } from "../../tui/launch.js";
import { menuInstanceKey } from "../../tui/menu.js";
import { ResultPane, promptInstanceKey } from "../../tui/prompt.js";
import { layoutResult, moveScroll, revealOffset, wrapText } from "../../tui/scroll.js";
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

test("a follow-up prompt and a submenu are distinct instances", () => {
  assert.notEqual(
    promptInstanceKey({ title: "Set config", label: "Setting name:" }),
    promptInstanceKey({ title: "Set config", label: "Value:" }),
  );
  assert.notEqual(
    menuInstanceKey({
      title: "Configure",
      items: [{ id: "config" }, { id: "keys" }, { id: "local" }],
    }),
    menuInstanceKey({
      title: "Config",
      items: [{ id: "show" }, { id: "set" }],
    }),
  );
});

test("key hints keep confirm and cancel as separate colored actions", () => {
  const output = stripVTControlCharacters(
    renderToString(
      createElement(KeyHints, {
        items: [
          { key: "enter", action: "confirm", color: "green" },
          { key: "esc", action: "cancel", color: "yellow" },
        ],
      }),
    ),
  );
  assert.match(output, /enter confirm\s{3,}esc cancel/);
});

test("a long result stays inside the terminal and can scroll", () => {
  const body = Array.from(
    { length: 40 },
    (_, index) => `row-${String(index).padStart(2, "0")}`,
  ).join("\n");
  const layout = layoutResult({ title: "kitchen", body, columns: 40, rows: 12, offset: 0 });
  assert.equal(layout.fits, false);
  assert.deepEqual(layout.lines, [
    "row-00",
    "row-01",
    "row-02",
    "row-03",
    "row-04",
    "row-05",
    "row-06",
  ]);
  assert.equal(layout.status, "1-7 / 40   arrows scroll");
  assert.equal(moveScroll(0, "down", layout.total, layout.height), 1);
  assert.equal(moveScroll(0, "pagedown", layout.total, layout.height), 7);
  assert.equal(moveScroll(0, "end", layout.total, layout.height), 33);
  assert.equal(moveScroll(500, "up", layout.total, layout.height), 32);
  const tail = layoutResult({
    title: "kitchen",
    body,
    columns: 40,
    rows: 12,
    offset: moveScroll(0, "end", layout.total, layout.height),
  });
  assert.equal(tail.lines.at(-1), "row-39");
  assert.equal(tail.lines[0], "row-33");

  const output = stripVTControlCharacters(
    renderToString(
      createElement(ResultPane, {
        title: "kitchen",
        body,
        columns: 40,
        rows: 12,
        onBack: () => undefined,
      }),
    ),
  );
  assert.match(output, /kitchen/);
  assert.match(output, /row-00/);
  assert.doesNotMatch(output, /row-39/);
  assert.match(output, /arrows scroll/);
  assert.match(output, /enter back/);
  assert.ok(output.split("\n").length <= 11);
});

test("a short result is shown in full", () => {
  const layout = layoutResult({
    title: "Config",
    body: '{\n  "a": 1\n}',
    columns: 80,
    rows: 24,
    offset: 0,
  });
  assert.equal(layout.fits, true);
  assert.equal(layout.status, "");
  assert.deepEqual(layout.lines, ["{", '  "a": 1', "}"]);
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapText("a\n\nb", 4), ["a", "", "b"]);
});

test("a menu window follows the selection", () => {
  assert.equal(revealOffset(0, 2, 40, 7), 0);
  assert.equal(revealOffset(0, 7, 40, 7), 1);
  assert.equal(revealOffset(5, 6, 40, 7), 5);
  assert.equal(revealOffset(5, 4, 40, 7), 4);
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
