import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { files, ensureDirectories } from "./paths.js";
import { initialState, type PersistedState } from "./model.js";

export class StateStore {
  #state: PersistedState = initialState();
  #tail: Promise<void> = Promise.resolve();
  #loaded = false;

  constructor(readonly statePath = files.state) {}

  async load(): Promise<void> {
    if (this.statePath === files.state) await ensureDirectories();
    else await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const state = JSON.parse(raw) as PersistedState;
      if (state.version !== 1 || !Array.isArray(state.devices) || !Array.isArray(state.apiKeys)) {
        throw new Error("Unsupported or malformed state file");
      }
      const apiKeys = state.apiKeys.filter((key) => key.revokedAt === null);
      this.#state = apiKeys.length === state.apiKeys.length ? state : { ...state, apiKeys };
      if (apiKeys.length !== state.apiKeys.length) await this.#persist(this.#state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#state = initialState();
      await this.#persist(this.#state);
    }
    this.#loaded = true;
  }

  snapshot(): PersistedState {
    this.#assertLoaded();
    return structuredClone(this.#state);
  }

  async update<T>(mutator: (state: PersistedState) => T | Promise<T>): Promise<T> {
    this.#assertLoaded();
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#tail = this.#tail
      .then(async () => {
        const next = structuredClone(this.#state);
        const value = await mutator(next);
        await this.#persist(next);
        this.#state = next;
        resolveResult(value);
      })
      .catch((error: unknown) => rejectResult(error));
    return result;
  }

  async #persist(state: PersistedState): Promise<void> {
    const temp = `${this.statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, this.statePath);
    await fs.chmod(this.statePath, 0o600);
    const dir = await fs.open(path.dirname(this.statePath), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  #assertLoaded(): void {
    if (!this.#loaded) throw new Error("State store has not been loaded");
  }
}
