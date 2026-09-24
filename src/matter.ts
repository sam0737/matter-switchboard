import path from "node:path";
import { randomUUID } from "node:crypto";
import { Environment } from "@matter/main";
import { GeneralCommissioning } from "@matter/main/clusters";
import { ElectricalPowerMeasurementClient } from "@matter/main/behaviors/electrical-power-measurement";
import { OnOffClient } from "@matter/main/behaviors/on-off";
import { OperationalCredentialsClient } from "@matter/main/behaviors/operational-credentials";
import { FabricIndex, ManualPairingCodeCodec, NodeId, VendorId } from "@matter/main/types";
import { DclCertificateService } from "@matter/protocol";
import { CommissioningController } from "@project-chip/matter.js";
import { decideAttestation } from "./attestation.js";
import type { DeviceRecord, OutletRecord } from "./model.js";
import { files } from "./paths.js";

const timeout = <T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    Promise.resolve(promise),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);

export interface CommissionOptions {
  allowAttestationBypass?: boolean;
}

export class MatterControllerAdapter {
  #controller: CommissioningController | undefined;
  #certificates: DclCertificateService | undefined;
  #starting: Promise<CommissioningController> | undefined;
  #allowAttestationBypass: boolean;

  constructor(options: { allowAttestationBypass?: boolean } = {}) {
    this.#allowAttestationBypass = options.allowAttestationBypass ?? false;
  }

  async start(): Promise<CommissioningController> {
    if (this.#controller) return this.#controller;
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      const environment = Environment.default;
      environment.vars.set("storage.path", path.resolve(files.matterStorage));
      if (!this.#certificates) {
        const certificates = new DclCertificateService(environment);
        await certificates.construction;
        this.#certificates = certificates;
      }
      const controller = new CommissioningController({
        environment: { environment, id: "matter-switchboard" },
        adminFabricLabel: "Matter Switchboard",
        autoConnect: false,
        adminVendorId: VendorId(0xfff1),
      });
      await controller.start();
      this.#controller = controller;
      return controller;
    })();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async commission(
    setupCode: string,
    slug: string,
    countryCode = "CN",
    options: CommissionOptions = {},
  ): Promise<DeviceRecord> {
    const allowAttestationBypass = options.allowAttestationBypass ?? this.#allowAttestationBypass;
    if (allowAttestationBypass) {
      console.warn(
        "Commissioning with attestation bypass: findings will be accepted instead of rejected",
      );
    }
    const controller = await this.start();
    const payload = ManualPairingCodeCodec.decode(setupCode);
    const nodeId = await controller.commissionNode({
      passcode: payload.passcode,
      commissioning: {
        regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
        regulatoryCountryCode: countryCode,
        onAttestationFailure: (findings) => {
          const decision = decideAttestation(findings, allowAttestationBypass);
          if (decision === true) {
            for (const finding of findings) {
              console.info(`Attestation note accepted: ${finding.type} ${finding.message}`);
            }
          }
          return decision;
        },
      },
      discovery: {
        identifierData: { shortDiscriminator: payload.shortDiscriminator },
        discoveryCapabilities: { onIpNetwork: true },
      },
    });
    const paired = await controller.getNode(nodeId);
    const initialization = timeout(
      paired.events.initializedFromRemote,
      30_000,
      "Commissioned device initialization",
    );
    paired.connect();
    await initialization;
    const info = paired.basicInformation;
    const outlets = paired
      .getDevices()
      .flatMap((endpoint) => {
        if (!endpoint.maybeStateOf(OnOffClient)) return [];
        const endpointId = endpoint.number;
        if (endpointId === undefined) return [];
        const state = endpoint.maybeStateOf(OnOffClient);
        if (!state) return [];
        return [
          this.#makeOutlet(
            endpointId,
            `Outlet ${endpointId}`,
            state.onOff,
            endpoint.maybeStateOf(ElectricalPowerMeasurementClient),
          ),
        ];
      })
      .sort((a, b) => a.endpointId - b.endpointId);
    if (outlets.length === 0) throw new Error("Commissioned Matter device has no On/Off endpoints");
    return {
      id: randomUUID(),
      slug,
      kind: "matter",
      nodeId: String(nodeId),
      vendorName: info?.vendorName ?? null,
      productName: info?.productName ?? null,
      available: true,
      lastSeen: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      endpoints: outlets,
    };
  }

  async power(device: DeviceRecord, endpointId: number, on: boolean): Promise<OutletRecord> {
    const endpoint = await this.#matterEndpoint(device, endpointId);
    const commands = endpoint.commandsOf(OnOffClient);
    if (on) await commands.on();
    else await commands.off();
    const state = endpoint.stateOf(OnOffClient);
    return this.#makeOutlet(
      endpointId,
      endpoint.name || `Endpoint ${endpointId}`,
      state.onOff,
      endpoint.maybeStateOf(ElectricalPowerMeasurementClient),
    );
  }

  async readOutlet(device: DeviceRecord, endpointId: number): Promise<OutletRecord> {
    const endpoint = await this.#matterEndpoint(device, endpointId);
    const state = endpoint.stateOf(OnOffClient);
    return this.#makeOutlet(
      endpointId,
      endpoint.name || `Endpoint ${endpointId}`,
      state.onOff,
      endpoint.maybeStateOf(ElectricalPowerMeasurementClient),
    );
  }

  async ping(device: DeviceRecord): Promise<void> {
    await this.#paired(device);
  }

  async decommission(device: DeviceRecord): Promise<void> {
    const paired = await this.#paired(device);
    await paired.decommission();
  }

  async forgetLocal(device: DeviceRecord): Promise<void> {
    if (device.kind !== "matter" || !device.nodeId) throw new Error("Device is not a Matter node");
    const controller = await this.start();
    await controller.removeNode(NodeId(BigInt(device.nodeId)), false);
  }

  async fabrics(
    device: DeviceRecord,
  ): Promise<Array<{ fabricIndex: number; label: string; vendorId: number }>> {
    const paired = await this.#paired(device);
    const state = paired.node.stateOf(OperationalCredentialsClient);
    return state.fabrics.map((fabric) => ({
      fabricIndex: fabric.fabricIndex,
      label: fabric.label,
      vendorId: fabric.vendorId,
    }));
  }

  async removeFabric(device: DeviceRecord, fabricIndex: number): Promise<void> {
    const paired = await this.#paired(device);
    const result = await paired.node
      .commandsOf(OperationalCredentialsClient)
      .removeFabric({ fabricIndex: FabricIndex(fabricIndex) });
    if (result.statusCode !== 0)
      throw new Error(`RemoveFabric failed with status ${result.statusCode}`);
  }

  async close(): Promise<void> {
    await this.#controller?.close();
    this.#controller = undefined;
    await this.#certificates?.close();
    this.#certificates = undefined;
  }

  async #matterEndpoint(device: DeviceRecord, endpointId: number) {
    const paired = await this.#paired(device);
    const endpoint = paired.getDeviceById(endpointId);
    if (!endpoint || !endpoint.maybeStateOf(OnOffClient)) {
      throw new Error(`On/Off endpoint ${endpointId} was not found on '${device.slug}'`);
    }
    return endpoint;
  }

  async #paired(device: DeviceRecord) {
    if (device.kind !== "matter" || !device.nodeId) throw new Error("Device is not a Matter node");
    const controller = await this.start();
    const paired = await controller.getNode(NodeId(BigInt(device.nodeId)));
    if (!paired.isConnected) {
      const initialization = timeout(
        paired.events.initializedFromRemote,
        15_000,
        `Connection to '${device.slug}'`,
      );
      paired.connect();
      await initialization;
    }
    return paired;
  }

  #makeOutlet(
    endpointId: number,
    name: string,
    on: boolean,
    measurement?: {
      activeCurrent?: number | bigint | null;
      voltage?: number | bigint | null;
      activePower?: number | bigint | null;
    },
  ): OutletRecord {
    const toBaseUnit = (value: number | bigint | null | undefined): number | null =>
      value === undefined || value === null ? null : Number(value) / 1000;
    return {
      endpointId,
      name,
      kind: "socket",
      on,
      currentAmps: toBaseUnit(measurement?.activeCurrent),
      voltageVolts: toBaseUnit(measurement?.voltage),
      activePowerWatts: toBaseUnit(measurement?.activePower),
      measurementSupport: {
        current: measurement?.activeCurrent !== undefined,
        voltage: measurement?.voltage !== undefined,
        activePower: measurement?.activePower !== undefined,
      },
      observedAt: new Date().toISOString(),
    };
  }
}
