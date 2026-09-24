import { render } from "ink";
import { useEffect, useRef, useState } from "react";
import { listDevices, readOutletState, setOutletPower } from "../admin-api.js";
import { Configure } from "./configure.js";
import { Dashboard } from "./dashboard.js";
import { errorMessage } from "./format.js";
import {
  POLL_INTERVAL_MS,
  applyInventory,
  applyOutletRead,
  applyServerDown,
  applyStripReachable,
  applyStripReadFailure,
  beginToggle,
  closeConfigure,
  currentEpoch,
  finishToggle,
  initialState,
  moveFocus,
  nextPollSlug,
  openConfigure,
  type TuiState,
} from "./model.js";

export async function runTui(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("The dashboard needs an interactive terminal");
  }
  const instance = render(<App />, { alternateScreen: true, exitOnCtrlC: true });
  await instance.waitUntilExit();
}

function App() {
  const [state, setState] = useState<TuiState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (state.mode !== "dashboard") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSlug: string | null = null;

    const load = async () => {
      try {
        const devices = await listDevices();
        if (cancelled) return;
        setState((current) => applyInventory(current, devices));
      } catch (error) {
        if (cancelled) return;
        setState((current) => applyServerDown(current, errorMessage(error)));
      }
    };

    const refreshStrip = async (slug: string) => {
      const epoch = currentEpoch(stateRef.current, slug);
      const strip = stateRef.current.dashboard.strips.find((item) => item.slug === slug);
      if (!strip) return;
      let failed: string | null = null;
      for (const endpoint of strip.endpoints) {
        if (cancelled) return;
        if (currentEpoch(stateRef.current, slug) !== epoch) return;
        try {
          const outlet = await readOutletState(slug, endpoint.endpointId);
          if (cancelled) return;
          setState((current) => applyOutletRead(current, slug, outlet, epoch));
        } catch (error) {
          const message = errorMessage(error);
          failed = message;
          if (cancelled) return;
          setState((current) => applyStripReadFailure(current, slug, message, epoch));
        }
      }
      if (cancelled) return;
      if (failed === null) setState((current) => applyStripReachable(current, slug, epoch));
    };

    const tick = async () => {
      if (cancelled) return;
      if (stateRef.current.dashboard.serverDown) {
        await load();
      } else {
        const slug = nextPollSlug(stateRef.current, lastSlug);
        if (slug) {
          lastSlug = slug;
          await refreshStrip(slug);
        }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void (async () => {
      await load();
      if (!cancelled) await tick();
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state.mode]);

  const onToggle = () => {
    const started = beginToggle(stateRef.current);
    if (!started) return;
    setState(started.state);
    const { slug, endpointId, on } = started.target;
    void (async () => {
      try {
        const result = await setOutletPower(slug, endpointId, on);
        setState((current) => finishToggle(current, slug, endpointId, result.observed));
      } catch (error) {
        setState((current) =>
          finishToggle(current, slug, endpointId, { error: errorMessage(error) }),
        );
      }
    })();
  };

  if (state.mode === "configure") {
    return <Configure onBack={() => setState((current) => closeConfigure(current))} />;
  }
  return (
    <Dashboard
      state={state}
      onMove={(delta) => setState((current) => moveFocus(current, delta))}
      onToggle={onToggle}
      onConfigure={() => setState((current) => openConfigure(current))}
    />
  );
}
