import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { randomBytes } from "node:crypto";
import { loadConfig, readAdminToken, saveConfig } from "./config.js";
import { fabricRemovalConfirmation } from "./confirm.js";
import { HttpError } from "./errors.js";
import { applyLogLevel } from "./log.js";
import { Inventory, validateSlug } from "./inventory.js";
import { SlidingWindowLimiter } from "./limiter.js";
import { MatterControllerAdapter } from "./matter.js";
import type { ApiKeyRecord, DeviceRecord } from "./model.js";
import { ensureDirectories } from "./paths.js";
import { bearer, findApiKey, matches, verifier } from "./security.js";
import { StateStore } from "./storage.js";

declare module "fastify" {
  interface FastifyRequest {
    switchboardKey?: ApiKeyRecord;
  }
}

export interface ServiceContext {
  inventory: Inventory;
  matter: MatterControllerAdapter;
  countryCode: string;
  allowAttestationBypass: boolean;
}

export async function createServiceContext(): Promise<ServiceContext> {
  await ensureDirectories();
  const config = await loadConfig();
  applyLogLevel(config.logLevel);
  const store = new StateStore();
  await store.load();
  return {
    inventory: new Inventory(store),
    matter: new MatterControllerAdapter({
      allowAttestationBypass: config.allowAttestationBypass,
    }),
    countryCode: config.matterCountryCode,
    allowAttestationBypass: config.allowAttestationBypass,
  };
}

function rateLimit(limiter: SlidingWindowLimiter, key: string, reply: FastifyReply): boolean {
  const result = limiter.consume(key);
  if (result.allowed) return true;
  reply.header("Retry-After", String(result.retryAfterSeconds));
  void reply.code(429).send({ error: "rate_limit_exceeded", message: "Too many requests" });
  return false;
}

/** Docs, the OpenAPI document, and the health check are open and unlimited. */
function isPublicPath(url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  return (
    path === "/health" || path === "/openapi.json" || path === "/docs" || path.startsWith("/docs/")
  );
}

async function buildApp(
  context: ServiceContext,
  audience: "admin" | "user",
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 64 * 1024 });
  const unauthenticatedLimiter = new SlidingWindowLimiter(3, 5_000);
  const authenticatedLimiter = new SlidingWindowLimiter(30, 5_000);

  app.addHook("onRequest", async (request, reply) => {
    if (isPublicPath(request.url)) return;

    const supplied = bearer(request);
    if (audience === "admin") {
      const adminToken = await readAdminToken();
      if (supplied && matches(supplied, verifier(adminToken))) {
        if (!rateLimit(authenticatedLimiter, `admin:${verifier(supplied)}`, reply)) return;
        return;
      }
      if (!rateLimit(unauthenticatedLimiter, `ip:${request.ip}`, reply)) return;
      return reply
        .code(401)
        .send({ error: "unauthorized", message: "Administrator credential required" });
    }

    const state = context.inventory.store.snapshot();
    const key = supplied ? findApiKey(state.apiKeys, supplied) : undefined;
    if (key) {
      request.switchboardKey = key;
      if (!rateLimit(authenticatedLimiter, `key:${key.id}`, reply)) return;
      return;
    }
    if (!rateLimit(unauthenticatedLimiter, `ip:${request.ip}`, reply)) return;
    return reply.code(401).send({ error: "unauthorized", message: "Valid API key required" });
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: { title: "Matter Switchboard API", version: "0.1.0" },
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list" } });
  app.get("/openapi.json", async () => app.swagger());
  app.get("/health", async () => ({ status: "ok" }));

  if (audience === "admin") {
    registerAdminRoutes(app, context);
  } else {
    registerUserRoutes(app, context);
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      void reply.code(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : "Unexpected server error";
    const status = /not found/i.test(message)
      ? 404
      : /already in use|only mock|not a Matter/i.test(message)
        ? 409
        : 400;
    void reply.code(status).send({ error: "request_failed", message });
  });

  return app;
}

function allowedDevice(request: FastifyRequest, device: DeviceRecord): void {
  const key = request.switchboardKey;
  if (!key) throw new HttpError(401, "Valid API key required", "unauthorized");
  if (key.devices && !key.devices.includes(device.id))
    throw new HttpError(403, "Key cannot access this device", "forbidden");
}

function requireScope(request: FastifyRequest, scope: "read" | "control"): void {
  const key = request.switchboardKey;
  if (!key) throw new HttpError(401, "Valid API key required", "unauthorized");
  if (scope === "control" && key.scope !== "control")
    throw new HttpError(403, "Control scope required", "forbidden");
}

function registerUserRoutes(app: FastifyInstance, context: ServiceContext): void {
  const slugParams = {
    type: "object",
    required: ["slug"],
    properties: { slug: { type: "string" } },
  } as const;
  const endpointParams = {
    type: "object",
    required: ["slug", "endpointId"],
    properties: { slug: { type: "string" }, endpointId: { type: "string" } },
  } as const;
  app.get(
    "/v1/devices",
    { schema: { tags: ["devices"], security: [{ bearerAuth: [] }] } },
    async (request) => {
      requireScope(request, "read");
      const key = request.switchboardKey!;
      return context.inventory
        .list()
        .filter((device) => !key.devices || key.devices.includes(device.id))
        .map((device) => ({ ...Inventory.publicDevice(device), kind: device.kind }));
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/v1/devices/:slug",
    { schema: { tags: ["devices"], security: [{ bearerAuth: [] }], params: slugParams } },
    async (request) => {
      requireScope(request, "read");
      const device = context.inventory.get(request.params.slug);
      allowedDevice(request, device);
      return { ...Inventory.publicDevice(device), kind: device.kind };
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/v1/devices/:slug/endpoints",
    { schema: { tags: ["endpoints"], security: [{ bearerAuth: [] }], params: slugParams } },
    async (request) => {
      requireScope(request, "read");
      const device = context.inventory.get(request.params.slug);
      allowedDevice(request, device);
      return device.endpoints.map((endpoint) => ({
        endpointId: endpoint.endpointId,
        name: endpoint.name,
        kind: endpoint.kind,
        currentAmps: endpoint.currentAmps,
        voltageVolts: endpoint.voltageVolts,
        activePowerWatts: endpoint.activePowerWatts,
        measurementSupport: endpoint.measurementSupport,
      }));
    },
  );

  app.get<{ Params: { slug: string; endpointId: string } }>(
    "/v1/devices/:slug/endpoints/:endpointId/state",
    { schema: { tags: ["endpoints"], security: [{ bearerAuth: [] }], params: endpointParams } },
    async (request) => {
      requireScope(request, "read");
      const device = context.inventory.get(request.params.slug);
      allowedDevice(request, device);
      const endpointId = parseEndpointId(request.params.endpointId);
      const outlet =
        device.kind === "mock"
          ? device.endpoints.find((endpoint) => endpoint.endpointId === endpointId)
          : await context.matter.readOutlet(device, endpointId);
      if (!outlet) throw new HttpError(404, "Endpoint not found", "not_found");
      if (device.kind === "matter")
        await context.inventory.updateObservedOutlet(device.slug, outlet);
      return outlet;
    },
  );

  app.put<{ Params: { slug: string; endpointId: string }; Body: { on: boolean } }>(
    "/v1/devices/:slug/endpoints/:endpointId/power",
    {
      schema: {
        tags: ["endpoints"],
        security: [{ bearerAuth: [] }],
        params: endpointParams,
        body: {
          type: "object",
          required: ["on"],
          additionalProperties: false,
          properties: { on: { type: "boolean" } },
        },
      },
    },
    async (request) => {
      requireScope(request, "control");
      const device = context.inventory.get(request.params.slug);
      allowedDevice(request, device);
      const endpointId = parseEndpointId(request.params.endpointId);
      const result =
        device.kind === "mock"
          ? await context.inventory.setPower(device.slug, endpointId, request.body.on)
          : await context.matter.power(device, endpointId, request.body.on);
      if (device.kind === "matter")
        await context.inventory.updateObservedOutlet(device.slug, result);
      return {
        device: device.slug,
        kind: device.kind,
        endpointId,
        requestedOn: request.body.on,
        observed: result,
      };
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/v1/devices/:slug/availability",
    { schema: { tags: ["devices"], security: [{ bearerAuth: [] }], params: slugParams } },
    async (request) => {
      requireScope(request, "read");
      const device = context.inventory.get(request.params.slug);
      allowedDevice(request, device);
      if (device.kind === "mock") return { status: "reachable", lastSeen: device.lastSeen };
      try {
        await context.matter.ping(device);
        await context.inventory.markAvailability(device.slug, true);
        return { status: "reachable", lastSeen: new Date().toISOString() };
      } catch (error) {
        await context.inventory.markAvailability(device.slug, false);
        return {
          status: "unreachable",
          lastSeen: device.lastSeen,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

function parseEndpointId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new HttpError(400, "endpointId must be a positive integer", "invalid_endpoint");
  return id;
}

function registerAdminRoutes(app: FastifyInstance, context: ServiceContext): void {
  app.get(
    "/admin/devices",
    { schema: { tags: ["admin"], security: [{ bearerAuth: [] }] } },
    async () => context.inventory.list(),
  );

  app.post<{ Body: { slug: string } }>(
    "/admin/mocks",
    {
      schema: {
        tags: ["admin"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["slug"],
          additionalProperties: false,
          properties: { slug: { type: "string" } },
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await context.inventory.addMock(request.body.slug)),
  );

  app.delete<{ Params: { slug: string } }>(
    "/admin/mocks/:slug",
    { schema: { tags: ["admin"], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      await context.inventory.removeMock(request.params.slug);
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { setupCode: string; slug: string; allowAttestationBypass?: boolean } }>(
    "/admin/devices/commission",
    {
      schema: {
        tags: ["admin"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["setupCode", "slug"],
          additionalProperties: false,
          properties: {
            setupCode: { type: "string" },
            slug: { type: "string" },
            allowAttestationBypass: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      validateSlug(request.body.slug);
      if (context.inventory.list().some((device) => device.slug === request.body.slug)) {
        throw new HttpError(409, `Slug '${request.body.slug}' is already in use`, "slug_conflict");
      }
      const device = await context.matter.commission(
        request.body.setupCode,
        request.body.slug,
        context.countryCode,
        {
          allowAttestationBypass:
            request.body.allowAttestationBypass ?? context.allowAttestationBypass,
          registeredNodeIds: context.inventory
            .list()
            .flatMap((item) => (item.kind === "matter" && item.nodeId ? [item.nodeId] : [])),
        },
      );
      return reply.code(201).send(await context.inventory.addMatter(device));
    },
  );

  app.post<{ Params: { slug: string }; Body: { slug: string } }>(
    "/admin/devices/:slug/rename",
    {
      schema: {
        tags: ["admin"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["slug"],
          additionalProperties: false,
          properties: { slug: { type: "string" } },
        },
      },
    },
    async (request) => context.inventory.rename(request.params.slug, request.body.slug),
  );

  app.post<{ Params: { slug: string } }>(
    "/admin/devices/:slug/ping",
    { schema: { tags: ["admin"], security: [{ bearerAuth: [] }] } },
    async (request) => {
      const device = context.inventory.get(request.params.slug);
      if (device.kind === "mock")
        return { status: "reachable", kind: "mock", lastSeen: device.lastSeen };
      try {
        await context.matter.ping(device);
        await context.inventory.markAvailability(device.slug, true);
        return { status: "reachable", lastSeen: new Date().toISOString() };
      } catch (error) {
        await context.inventory.markAvailability(device.slug, false);
        return {
          status: "unreachable",
          lastSeen: device.lastSeen,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  app.delete<{ Params: { slug: string } }>(
    "/admin/devices/:slug/decommission-self",
    { schema: { tags: ["admin"], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const device = context.inventory.get(request.params.slug);
      if (device.kind !== "matter")
        throw new HttpError(409, "Mock devices are removed with mock remove", "wrong_device_kind");
      await context.matter.decommission(device);
      await context.inventory.removeMatter(device.slug);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { slug: string } }>(
    "/admin/devices/:slug/forget-local",
    { schema: { tags: ["admin"], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const device = context.inventory.get(request.params.slug);
      if (device.kind !== "matter")
        throw new HttpError(409, "Mock devices are removed with mock remove", "wrong_device_kind");
      await context.matter.forgetLocal(device);
      await context.inventory.removeMatter(device.slug);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/admin/devices/:slug/fabrics",
    { schema: { tags: ["admin"], security: [{ bearerAuth: [] }] } },
    async (request) => {
      const device = context.inventory.get(request.params.slug);
      if (device.kind !== "matter")
        throw new HttpError(409, "Mock devices do not have Matter fabrics", "wrong_device_kind");
      return context.matter.fabrics(device);
    },
  );

  app.delete<{ Params: { slug: string; fabricIndex: string }; Body: { confirmLabel: string } }>(
    "/admin/devices/:slug/fabrics/:fabricIndex",
    {
      schema: {
        tags: ["admin"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["confirmLabel"],
          additionalProperties: false,
          properties: { confirmLabel: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const device = context.inventory.get(request.params.slug);
      if (device.kind !== "matter")
        throw new HttpError(409, "Mock devices do not have Matter fabrics", "wrong_device_kind");
      const index = Number(request.params.fabricIndex);
      if (!Number.isSafeInteger(index) || index < 1)
        throw new HttpError(400, "Invalid fabric index", "invalid_fabric_index");
      const fabric = (await context.matter.fabrics(device)).find(
        (item) => item.fabricIndex === index,
      );
      if (!fabric) throw new HttpError(404, "Fabric index not found", "fabric_not_found");
      if (request.body.confirmLabel !== fabricRemovalConfirmation(fabric)) {
        throw new HttpError(
          409,
          "Confirmation label does not match target fabric",
          "fabric_confirmation_required",
        );
      }
      await context.matter.removeFabric(device, index);
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { name: string; scope: "read" | "control"; devices?: string[] | null } }>(
    "/admin/keys",
    {
      schema: {
        tags: ["admin"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["name", "scope"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            scope: { type: "string", enum: ["read", "control"] },
            devices: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
          },
        },
      },
    },
    async (request, reply) => {
      const token = `msb_${randomBytes(32).toString("base64url")}`;
      const key = await context.inventory.createApiKey({
        name: request.body.name,
        scope: request.body.scope,
        devices: request.body.devices ?? null,
        verifier: verifier(token),
      });
      return reply.code(201).send({ ...key, token });
    },
  );

  app.get(
    "/admin/keys",
    { schema: { tags: ["admin"], security: [{ bearerAuth: [] }] } },
    async () => context.inventory.listApiKeys(),
  );

  app.delete<{ Params: { keyId: string } }>(
    "/admin/keys/:keyId",
    { schema: { tags: ["admin"], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      await context.inventory.revokeApiKey(request.params.keyId);
      return reply.code(204).send();
    },
  );

  app.get(
    "/admin/config",
    { schema: { tags: ["admin"], security: [{ bearerAuth: [] }] } },
    async () => loadConfig(),
  );

  app.put<{ Body: Record<string, unknown> }>(
    "/admin/config",
    { schema: { tags: ["admin"], security: [{ bearerAuth: [] }] } },
    async (request) => {
      const old = await loadConfig();
      const allowed = new Set([
        "apiHost",
        "apiPort",
        "adminPort",
        "adminHost",
        "matterCountryCode",
        "allowAttestationBypass",
        "logLevel",
      ]);
      if (Object.keys(request.body).some((key) => !allowed.has(key))) {
        throw new HttpError(400, "Unknown configuration setting", "invalid_config");
      }
      let next = { ...old, ...request.body } as typeof old;
      try {
        next = await saveConfig(next);
      } catch (error) {
        throw new HttpError(
          400,
          error instanceof Error ? error.message : "Invalid configuration",
          "invalid_config",
        );
      }
      applyLogLevel(next.logLevel);
      return next;
    },
  );
}

export async function startServer(): Promise<{ close: () => Promise<void> }> {
  const config = await loadConfig();
  const context = await createServiceContext();
  const userApp = await buildApp(context, "user");
  const adminApp = await buildApp(context, "admin");
  try {
    await adminApp.listen({ host: "127.0.0.1", port: config.adminPort });
    await userApp.listen({ host: config.apiHost, port: config.apiPort });
  } catch (error) {
    await Promise.allSettled([adminApp.close(), userApp.close(), context.matter.close()]);
    throw error;
  }
  return {
    close: async () => {
      await Promise.all([adminApp.close(), userApp.close(), context.matter.close()]);
    },
  };
}
