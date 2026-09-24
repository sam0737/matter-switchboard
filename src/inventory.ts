import { randomUUID } from "node:crypto";
import type { DeviceRecord, OutletRecord, PersistedState, PublicDevice } from "./model.js";
import { StateStore } from "./storage.js";

const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateSlug(value: string): void {
  if (!slugPattern.test(value)) {
    throw new Error("Slug must be 1–63 lowercase letters, digits, or internal hyphens");
  }
}

/** Blank input means every device. Commas and whitespace separate slugs. */
export function deviceAllowlist(values: readonly string[] | null | undefined): string[] | null {
  const slugs = (values ?? []).flatMap((value) => value.split(/[\s,]+/)).filter(Boolean);
  return slugs.length > 0 ? slugs : null;
}

function newOutlet(endpointId: number, name: string): OutletRecord {
  return {
    endpointId,
    name,
    kind: "socket",
    on: false,
    currentAmps: null,
    voltageVolts: null,
    activePowerWatts: null,
    measurementSupport: { current: false, voltage: false, activePower: false },
    observedAt: new Date().toISOString(),
  };
}

export class Inventory {
  constructor(readonly store: StateStore) {}

  list(): DeviceRecord[] {
    return this.store.snapshot().devices.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  get(slug: string): DeviceRecord {
    const device = this.store.snapshot().devices.find((item) => item.slug === slug);
    if (!device) throw new Error(`Device '${slug}' was not found`);
    return device;
  }

  async addMock(slug: string): Promise<DeviceRecord> {
    validateSlug(slug);
    const now = new Date().toISOString();
    return this.store.update((state) => {
      if (state.devices.some((item) => item.slug === slug))
        throw new Error(`Slug '${slug}' is already in use`);
      const device: DeviceRecord = {
        id: randomUUID(),
        slug,
        kind: "mock",
        nodeId: null,
        vendorName: "Matter Switchboard",
        productName: "Two Socket Mock Strip",
        available: true,
        lastSeen: now,
        createdAt: now,
        endpoints: [newOutlet(1, "Socket 1"), newOutlet(2, "Socket 2")],
      };
      state.devices.push(device);
      return device;
    });
  }

  async addMatter(device: DeviceRecord): Promise<DeviceRecord> {
    validateSlug(device.slug);
    return this.store.update((state) => {
      if (state.devices.some((item) => item.slug === device.slug))
        throw new Error(`Slug '${device.slug}' is already in use`);
      state.devices.push(device);
      return device;
    });
  }

  async removeMock(slug: string): Promise<void> {
    await this.store.update((state) => {
      const index = state.devices.findIndex((item) => item.slug === slug);
      if (index < 0) throw new Error(`Device '${slug}' was not found`);
      if (state.devices[index]!.kind !== "mock")
        throw new Error("Only mock devices can be removed with this command");
      state.devices.splice(index, 1);
    });
  }

  async rename(slug: string, nextSlug: string): Promise<DeviceRecord> {
    validateSlug(nextSlug);
    return this.store.update((state) => {
      const device = state.devices.find((item) => item.slug === slug);
      if (!device) throw new Error(`Device '${slug}' was not found`);
      if (state.devices.some((item) => item.slug === nextSlug))
        throw new Error(`Slug '${nextSlug}' is already in use`);
      device.slug = nextSlug;
      return device;
    });
  }

  async setPower(slug: string, endpointId: number, on: boolean): Promise<OutletRecord> {
    return this.store.update((state: PersistedState) => {
      const device = state.devices.find((item) => item.slug === slug);
      if (!device) throw new Error(`Device '${slug}' was not found`);
      if (device.kind !== "mock")
        throw new Error("Matter power changes must be sent through the Matter controller");
      const endpoint = device.endpoints.find((item) => item.endpointId === endpointId);
      if (!endpoint) throw new Error(`Endpoint ${endpointId} was not found on '${slug}'`);
      endpoint.on = on;
      endpoint.observedAt = new Date().toISOString();
      device.lastSeen = endpoint.observedAt;
      return endpoint;
    });
  }

  async updateObservedOutlet(slug: string, observed: OutletRecord): Promise<OutletRecord> {
    return this.store.update((state) => {
      const device = state.devices.find((item) => item.slug === slug);
      if (!device) throw new Error(`Device '${slug}' was not found`);
      const endpoint = device.endpoints.find((item) => item.endpointId === observed.endpointId);
      if (!endpoint) throw new Error(`Endpoint ${observed.endpointId} was not found on '${slug}'`);
      Object.assign(endpoint, observed);
      device.available = true;
      device.lastSeen = observed.observedAt;
      return endpoint;
    });
  }

  async markAvailability(slug: string, available: boolean): Promise<void> {
    await this.store.update((state) => {
      const device = state.devices.find((item) => item.slug === slug);
      if (!device) throw new Error(`Device '${slug}' was not found`);
      device.available = available;
      if (available) device.lastSeen = new Date().toISOString();
    });
  }

  async removeMatter(slug: string): Promise<void> {
    await this.store.update((state) => {
      const index = state.devices.findIndex((item) => item.slug === slug);
      if (index < 0) throw new Error(`Device '${slug}' was not found`);
      if (state.devices[index]!.kind !== "matter") throw new Error("Device is not a Matter node");
      state.devices.splice(index, 1);
    });
  }

  async createApiKey(input: {
    name: string;
    scope: "read" | "control";
    devices: string[] | null;
    verifier: string;
  }) {
    const slugs = deviceAllowlist(input.devices);
    const keyName = input.name.trim();
    if (!keyName) throw new Error("API key name is required");
    return this.store.update((state) => {
      if (state.apiKeys.some((record) => record.name === keyName)) {
        throw new Error(`API key '${keyName}' already exists`);
      }
      const deviceIds =
        slugs?.map((slug) => {
          const device = state.devices.find((item) => item.slug === slug);
          if (!device) throw new Error(`Device '${slug}' was not found`);
          return device.id;
        }) ?? null;
      const key = {
        id: randomUUID(),
        name: keyName,
        verifier: input.verifier,
        scope: input.scope,
        devices: deviceIds,
        createdAt: new Date().toISOString(),
        revokedAt: null,
      } as const;
      state.apiKeys.push(key);
      return {
        id: key.id,
        name: key.name,
        scope: key.scope,
        devices: slugs,
        createdAt: key.createdAt,
      };
    });
  }

  async deleteApiKey(name: string): Promise<void> {
    const keyName = name.trim();
    await this.store.update((state) => {
      const remaining = state.apiKeys.filter((record) => record.name !== keyName);
      if (remaining.length === state.apiKeys.length) {
        throw new Error(`API key '${keyName}' was not found`);
      }
      state.apiKeys = remaining;
    });
  }

  listApiKeys() {
    const state = this.store.snapshot();
    return state.apiKeys
      .map((key) => ({
        id: key.id,
        name: key.name,
        scope: key.scope,
        devices:
          key.devices?.map(
            (id) => state.devices.find((device) => device.id === id)?.slug ?? "<removed-device>",
          ) ?? null,
        createdAt: key.createdAt,
        revokedAt: key.revokedAt,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  static publicDevice(device: DeviceRecord): PublicDevice {
    const { endpoints, ...rest } = device;
    return { ...rest, endpointCount: endpoints.length };
  }
}
