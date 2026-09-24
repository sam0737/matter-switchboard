import type { FastifyInstance, FastifySchema } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { logLevels } from "./config.js";

const authenticated = [{ bearerAuth: [] as string[] }];

const userInfo = {
  title: "Matter Switchboard User API",
  version: "0.1.0",
  description: `Programs use this API to list power strips and control their outlets.

Send \`Authorization: Bearer <api-key>\` on every route except health and the documentation pages. Create a key with \`matter-switchboard key create\`. The plaintext key is shown once; store it in the calling program. Do not put the key in a URL.

A \`read\` key can list devices and endpoints and can read outlet state and availability. A \`control\` key can also turn outlets on or off. A key may be limited to specific device slugs.

Address a strip by its slug and an outlet by the endpoint id the device reports. List endpoints before sending a power command. Mock strips use these same routes and are marked \`kind: mock\`. They have socket endpoints 1 and 2 and do not have a Matter node id.

Electrical readings are null when the outlet does not report them. Null is not zero. Readings share the outlet \`observedAt\` timestamp.

Restricted routes allow 3 unauthenticated requests per source IP per 5 seconds and 30 authenticated requests per API key per 5 seconds. \`GET /health\`, \`GET /docs\`, and \`GET /openapi.json\` are exempt. A limited request returns 429 and a Retry-After header.

An HTTP success means this API handled the call. For availability and power, read \`status\` or \`observed\` for the device result.`,
};

const adminInfo = {
  title: "Matter Switchboard Administrator API",
  version: "0.1.0",
  description: `Local administration of inventory, Matter commissioning, API keys, and service settings. The \`matter-switchboard\` CLI calls this API on 127.0.0.1. Remote programs should use the user API.

Send \`Authorization: Bearer <administrator-credential>\`. \`matter-switchboard init\` creates that credential in the invoking user's configuration directory. An API key is not accepted here.

This listener also serves the \`/v1\` device and outlet routes. The CLI and TUI call those on loopback with the administrator credential. Remote programs should keep using the user API.

Commission a strip that is already on Wi-Fi: open a Matter multi-admin sharing window, then \`POST /admin/devices/commission\` with the temporary setup code and a slug. The setup code expires with that window and is not the original pairing code.

To let another administrator join a strip this server already controls, \`POST /admin/devices/{slug}/share\`. The response is a one-time setup code for that window. It is not stored.

\`POST /admin/mocks\` adds a two-socket strip that persists power state and does not join a Matter fabric. Remove it with \`DELETE /admin/mocks/{slug}\`. For a commissioned device, decommission-self asks the device to drop this controller, and forget-local drops only the local pairing.

Removing another fabric requires that fabric's current confirmation label. When the label is empty, confirm with the fabric index. List fabrics immediately before removal; indexes can change.

\`POST /admin/keys\` returns the plaintext token once. Names are unique. \`DELETE /admin/keys/{name}\` removes that key, and the next user-API request that presents it is rejected.

The same rate limits as the user API apply. \`GET /health\`, \`GET /docs\`, and \`GET /openapi.json\` are exempt.`,
};

const userBearer =
  "API key created by an administrator. Send Authorization: Bearer and the key. A read key can list and read. A control key can also change outlet power. The key may be limited to specific devices.";

const adminBearer =
  "Administrator credential created by matter-switchboard init. Send Authorization: Bearer and that credential. User API keys are not accepted on this listener.";

const userTags = [
  {
    name: "service",
    description: "Process status. No credential is required and the route is not rate limited.",
  },
  {
    name: "devices",
    description: "Power strips addressed by a stable slug. A slug is not a Matter node id.",
  },
  {
    name: "endpoints",
    description:
      "Outlets on one strip. Endpoint ids come from the device and can differ between strips.",
  },
];

const adminTags = [
  {
    name: "service",
    description: "Process status. No credential is required and the route is not rate limited.",
  },
  {
    name: "devices",
    description: "Commissioned and mock strips, including Matter identity and saved outlet state.",
  },
  {
    name: "endpoints",
    description:
      "Outlets on one strip. The CLI and TUI use these /v1 routes on this loopback listener.",
  },
  {
    name: "mocks",
    description: "Persistent two-socket strips that do not join a Matter fabric.",
  },
  {
    name: "fabrics",
    description:
      "Matter fabrics on a commissioned device. Indexes are local to the device and can change.",
  },
  {
    name: "keys",
    description: "User API keys. The plaintext token is returned only when a key is created.",
  },
  {
    name: "configuration",
    description:
      "Service settings saved for this user account. The administrator listener stays on loopback.",
  },
];

const errorText: Record<number, string> = {
  400: "A path parameter or JSON body is invalid, or the server rejected the request.",
  401: "The Authorization bearer credential is missing or not accepted by this listener.",
  403: "The API key is valid, but its scope or device allow list does not allow this operation.",
  404: "No device, endpoint, fabric, or API key matches this URL.",
  409: "The slug is already in use, the device kind does not support this operation, or confirmation does not match.",
  429: "The rate limit for this IP or credential is exhausted. Wait for Retry-After, then send the same request again.",
};

type Schema = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function json(description: string, schema: Schema): Schema {
  return { description, ...schema };
}

function none(description: string): Schema {
  return { description, type: "null" };
}

function errorBody(code: number): Schema {
  const schema: Schema = {
    description: errorText[code],
    title: "Error",
    type: "object",
    additionalProperties: false,
    required: ["error", "message"],
    properties: {
      error: {
        type: "string",
        description:
          "Stable machine-readable code, such as unauthorized, forbidden, not_found, slug_conflict, or rate_limit_exceeded.",
      },
      message: {
        type: "string",
        description: "Explanation of why the request was rejected.",
      },
    },
  };
  if (code === 429) {
    schema.headers = {
      "Retry-After": {
        description: "Whole seconds to wait before sending another request.",
        type: "integer",
        minimum: 0,
      },
    };
  }
  return schema;
}

function operation(input: {
  tags: string[];
  operationId: string;
  summary: string;
  description: string;
  public?: boolean;
  params?: Schema;
  body?: Schema;
  response: Record<string, Schema>;
  errors?: number[];
}): FastifySchema {
  const response: Record<string, Schema> = {};
  for (const [status, schema] of Object.entries(input.response)) response[status] = clone(schema);
  for (const status of input.errors ?? []) response[String(status)] = errorBody(status);
  return {
    tags: input.tags,
    operationId: input.operationId,
    summary: input.summary,
    description: input.description,
    security: input.public ? [] : authenticated,
    ...(input.params ? { params: clone(input.params) } : {}),
    ...(input.body ? { body: clone(input.body) } : {}),
    response,
  };
}

const slug = {
  type: "string",
  description:
    "Device slug. Use 1–63 lowercase letters, digits, or internal hyphens. Renaming changes this value and leaves the Matter node id unchanged.",
};

const slugParams: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["slug"],
  properties: { slug },
};

const endpointParams: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "endpointId"],
  properties: {
    slug,
    endpointId: {
      type: "string",
      description:
        "Outlet endpoint id as a positive integer. Ids are assigned by the device; list endpoints to see which socket each id controls.",
    },
  },
};

const fabricParams: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "fabricIndex"],
  properties: {
    slug,
    fabricIndex: {
      type: "string",
      description:
        "Fabric index from the fabric list, as a positive integer. Indexes belong to this device and can change, so read the list immediately before removal.",
    },
  },
};

const keyParams: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: {
      type: "string",
      description:
        "API key name from key creation or the key list. Names are unique. This is not the bearer token.",
    },
  },
};

const measurementSupport: Schema = {
  title: "MeasurementSupport",
  type: "object",
  additionalProperties: false,
  required: ["current", "voltage", "activePower"],
  description:
    "Which electrical readings this outlet exposes. A false flag means the matching value is null, not zero.",
  properties: {
    current: { type: "boolean", description: "True when the outlet reports current in amps." },
    voltage: { type: "boolean", description: "True when the outlet reports voltage in volts." },
    activePower: {
      type: "boolean",
      description: "True when the outlet reports active power in watts.",
    },
  },
};

const endpointIdField = {
  type: "integer",
  minimum: 1,
  description: "Device-assigned outlet id used in the state and power URLs.",
};

const reachabilityStatus = {
  type: "string",
  enum: ["reachable", "unreachable"],
  description: "Result of Matter discovery and a secure read. A mock strip is always reachable.",
};

const outletState: Schema = {
  title: "OutletState",
  type: "object",
  additionalProperties: false,
  required: [
    "endpointId",
    "name",
    "kind",
    "on",
    "currentAmps",
    "voltageVolts",
    "activePowerWatts",
    "measurementSupport",
    "observedAt",
  ],
  properties: {
    endpointId: endpointIdField,
    name: {
      type: "string",
      description: "Outlet name reported by the device or assigned to a mock socket.",
    },
    kind: {
      type: "string",
      enum: ["socket"],
      description: "Outlet kind. Power strips expose sockets.",
    },
    on: { type: "boolean", description: "Observed power state. True means the socket is on." },
    currentAmps: {
      type: "number",
      nullable: true,
      description: "Observed current in amps, or null when the outlet does not report current.",
    },
    voltageVolts: {
      type: "number",
      nullable: true,
      description: "Observed voltage in volts, or null when the outlet does not report voltage.",
    },
    activePowerWatts: {
      type: "number",
      nullable: true,
      description: "Observed active power in watts, or null when the outlet does not report power.",
    },
    measurementSupport,
    observedAt: {
      type: "string",
      format: "date-time",
      description:
        "When this outlet state was observed. Use it to tell a fresh reading from a cached one.",
    },
  },
};

const outletSummary: Schema = {
  title: "OutletSummary",
  type: "object",
  additionalProperties: false,
  required: [
    "endpointId",
    "name",
    "kind",
    "currentAmps",
    "voltageVolts",
    "activePowerWatts",
    "measurementSupport",
  ],
  properties: {
    endpointId: endpointIdField,
    name: {
      type: "string",
      description: "Outlet name reported by the device or assigned to a mock socket.",
    },
    kind: {
      type: "string",
      enum: ["socket"],
      description: "Outlet kind. Power strips expose sockets.",
    },
    currentAmps: {
      type: "number",
      nullable: true,
      description:
        "Last observed current in amps, or null when unsupported. Read endpoint state for the power switch.",
    },
    voltageVolts: {
      type: "number",
      nullable: true,
      description: "Last observed voltage in volts, or null when unsupported.",
    },
    activePowerWatts: {
      type: "number",
      nullable: true,
      description: "Last observed active power in watts, or null when unsupported.",
    },
    measurementSupport,
  },
};

const deviceFields: Schema = {
  id: {
    type: "string",
    format: "uuid",
    description:
      "Stable inventory id. API keys store this id, so renaming the slug does not move access.",
  },
  slug: {
    type: "string",
    description: "URL name of the device. Unique among devices on this server.",
  },
  kind: {
    type: "string",
    enum: ["matter", "mock"],
    description: "matter is a commissioned strip. mock is a local two-socket stand-in.",
  },
  nodeId: {
    type: "string",
    nullable: true,
    description: "Matter node id as a decimal string. Null for a mock strip.",
  },
  vendorName: {
    type: "string",
    nullable: true,
    description: "Vendor name from the device, or null when the device did not report one.",
  },
  productName: {
    type: "string",
    nullable: true,
    description: "Product name from the device, or null when the device did not report one.",
  },
  available: {
    type: "boolean",
    description:
      "True after the last availability check or successful Matter read reached the device.",
  },
  lastSeen: {
    type: "string",
    format: "date-time",
    nullable: true,
    description:
      "Time of the last successful contact, or null when this server has not reached the device.",
  },
  createdAt: {
    type: "string",
    format: "date-time",
    description: "When the device was added to this server.",
  },
};

const publicDevice: Schema = {
  title: "PublicDevice",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "slug",
    "kind",
    "nodeId",
    "vendorName",
    "productName",
    "available",
    "lastSeen",
    "createdAt",
    "endpointCount",
  ],
  properties: {
    ...deviceFields,
    endpointCount: {
      type: "integer",
      minimum: 0,
      description: "Number of outlets on the device. Use the endpoints route to list them.",
    },
  },
};

const adminDevice: Schema = {
  title: "Device",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "slug",
    "kind",
    "nodeId",
    "vendorName",
    "productName",
    "available",
    "lastSeen",
    "createdAt",
    "endpoints",
  ],
  properties: {
    ...deviceFields,
    endpoints: {
      type: "array",
      description:
        "Saved outlet state. Matter values update after a successful read or power command.",
      items: outletState,
    },
  },
};

const availability: Schema = {
  title: "Availability",
  type: "object",
  additionalProperties: false,
  required: ["status", "lastSeen"],
  properties: {
    status: reachabilityStatus,
    lastSeen: {
      type: "string",
      format: "date-time",
      nullable: true,
      description: "Last successful contact. Unchanged when this check could not reach the device.",
    },
    error: {
      type: "string",
      description: "Present when status is unreachable. Explains the failed Matter check.",
    },
    kind: {
      type: "string",
      enum: ["mock"],
      description: "Present on the administrator ping of a mock strip.",
    },
  },
};

const powerResult: Schema = {
  title: "PowerResult",
  type: "object",
  additionalProperties: false,
  required: ["device", "kind", "endpointId", "requestedOn", "observed"],
  properties: {
    device: { type: "string", description: "Slug of the strip that received the command." },
    kind: {
      type: "string",
      enum: ["matter", "mock"],
      description: "Whether the command was applied to a commissioned strip or a mock.",
    },
    endpointId: { type: "integer", minimum: 1, description: "Outlet that was commanded." },
    requestedOn: {
      type: "boolean",
      description:
        "Power state requested by this call. It matches the on field in the request body.",
    },
    observed: {
      ...outletState,
      description:
        "Outlet state after the command. Electrical readings can lag the new power state.",
    },
  },
};

const shareWindow: Schema = {
  title: "ShareWindow",
  type: "object",
  additionalProperties: false,
  required: ["manualPairingCode", "qrPairingCode", "timeoutSeconds", "expiresAt"],
  properties: {
    manualPairingCode: {
      type: "string",
      description:
        "Temporary Matter manual pairing code. Enter it in the other administrator. It stops working when the window expires or another window is opened.",
    },
    qrPairingCode: {
      type: "string",
      description:
        "Matter QR payload for the same window. Scan it from an administrator that accepts QR codes.",
    },
    timeoutSeconds: {
      type: "integer",
      description: "How long the device accepts a new administrator, in seconds.",
    },
    expiresAt: {
      type: "string",
      description: "UTC time when the window stops accepting a new administrator.",
    },
  },
};

const fabric: Schema = {
  title: "Fabric",
  type: "object",
  additionalProperties: false,
  required: ["fabricIndex", "label", "vendorId"],
  properties: {
    fabricIndex: {
      type: "integer",
      minimum: 1,
      description:
        "Index to send when removing this fabric. Read it again if the list may have changed.",
    },
    label: {
      type: "string",
      description:
        "Fabric label. Send this exact text as confirmLabel. When it is empty, send the fabric index instead.",
    },
    vendorId: {
      type: "integer",
      description:
        "Vendor id reported for the fabric. Use it to recognize the other administrator.",
    },
  },
};

const storedKey: Schema = {
  title: "ApiKey",
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "scope", "devices", "createdAt", "revokedAt"],
  properties: {
    id: {
      type: "string",
      format: "uuid",
      description: "Inventory id of the key. Delete the key by name, not by this id.",
    },
    name: {
      type: "string",
      description: "Unique name used to delete the key. It is not a secret.",
    },
    scope: {
      type: "string",
      enum: ["read", "control"],
      description: "read allows inventory and state. control also allows outlet power commands.",
    },
    devices: {
      type: "array",
      nullable: true,
      description:
        "Slugs this key may access, or null when the key is not limited. A removed device is shown as <removed-device>.",
      items: { type: "string" },
    },
    createdAt: { type: "string", format: "date-time", description: "When the key was created." },
    revokedAt: {
      type: "string",
      format: "date-time",
      nullable: true,
      description: "When the key was revoked, or null while it is still active.",
    },
  },
};

const createdKey: Schema = {
  title: "CreatedApiKey",
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "scope", "devices", "createdAt", "token"],
  properties: {
    id: {
      type: "string",
      format: "uuid",
      description: "Inventory id of the new key. Delete the key later by its name.",
    },
    name: { type: "string", description: "Name supplied when the key was created." },
    scope: {
      type: "string",
      enum: ["read", "control"],
      description: "Scope stored for this key.",
    },
    devices: {
      type: "array",
      nullable: true,
      description: "Device slugs the key may access, or null when it may access every device.",
      items: { type: "string" },
    },
    createdAt: { type: "string", format: "date-time", description: "When the key was created." },
    token: {
      type: "string",
      description:
        "Plaintext bearer token. It is returned only by this response and cannot be retrieved later. Store it in the calling program.",
    },
  },
};

const serviceConfig: Schema = {
  title: "ServiceConfig",
  type: "object",
  additionalProperties: false,
  required: [
    "apiHost",
    "apiPort",
    "adminHost",
    "adminPort",
    "matterCountryCode",
    "allowAttestationBypass",
    "logLevel",
  ],
  properties: {
    apiHost: {
      type: "string",
      description:
        "Host or address where the user API listens. Use a LAN address for remote programs.",
    },
    apiPort: {
      type: "integer",
      minimum: 1024,
      maximum: 65535,
      description: "TCP port of the user API. It must differ from adminPort.",
    },
    adminHost: {
      type: "string",
      enum: ["127.0.0.1"],
      description: "Administrator listener address. It remains loopback.",
    },
    adminPort: {
      type: "integer",
      minimum: 1024,
      maximum: 65535,
      description: "TCP port of this administrator API.",
    },
    matterCountryCode: {
      type: "string",
      pattern: "^[A-Z]{2}$",
      description: "Two-letter uppercase country code used when commissioning a Matter device.",
    },
    allowAttestationBypass: {
      type: "boolean",
      description:
        "When true, commissioning may accept a device that fails vendor attestation. Leave false for production devices.",
    },
    logLevel: {
      type: "string",
      enum: [...logLevels],
      description:
        "Minimum log level written by the service. The default is info, which hides debug.",
    },
  },
};

const configUpdate: Schema = {
  type: "object",
  description:
    "Any subset of service settings. Unknown fields are rejected. The administrator listener remains bound to 127.0.0.1. Restart the service before host and port changes take effect.",
  properties: serviceConfig.properties,
};

export function healthSchema(): FastifySchema {
  return operation({
    tags: ["service"],
    operationId: "getHealth",
    summary: "Service health",
    description:
      "Use this to check that the listener is running. No credential is required, and calls are not counted against the API rate limit.",
    public: true,
    response: {
      200: json("The listener is accepting requests.", {
        title: "Health",
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: {
            type: "string",
            enum: ["ok"],
            description: "Always ok when the process can answer.",
          },
        },
      }),
    },
  });
}

export function createUserSchemas() {
  return {
    listDevices: operation({
      tags: ["devices"],
      operationId: "listDevices",
      summary: "List visible devices",
      description:
        "Returns every strip this API key may access, without outlet detail. A key with no device limit sees the full inventory. Use the result to discover slugs before reading endpoints or sending power commands.",
      errors: [401, 429],
      response: {
        200: json("Devices visible to this API key, ordered by slug.", {
          title: "PublicDeviceList",
          type: "array",
          items: publicDevice,
        }),
      },
    }),
    getDevice: operation({
      tags: ["devices"],
      operationId: "getDevice",
      summary: "Get one device",
      description:
        "Returns one strip by slug, including how many outlets it has. The key must be allowed to access that device. Call the endpoints route for outlet ids and the state route for power and electrical readings.",
      params: slugParams,
      errors: [401, 403, 404, 429],
      response: {
        200: json("The requested device, without its outlet list.", publicDevice),
      },
    }),
    listEndpoints: operation({
      tags: ["endpoints"],
      operationId: "listEndpoints",
      summary: "List outlets on a device",
      description:
        "Returns the outlets on one strip and the electrical readings last saved for them. Use endpointId from this list in the state and power URLs. This list does not include the on/off switch; read endpoint state for that.",
      params: slugParams,
      errors: [401, 403, 404, 429],
      response: {
        200: json("Outlets on the device, in endpoint id order.", {
          title: "OutletSummaryList",
          type: "array",
          items: outletSummary,
        }),
      },
    }),
    getEndpointState: operation({
      tags: ["endpoints"],
      operationId: "getEndpointState",
      summary: "Read outlet state",
      description:
        "Reads one outlet. A mock socket returns its saved power state. A Matter outlet is read from the device, then the saved inventory is updated. Unsupported current, voltage, and wattage are null. observedAt is when that observation was taken.",
      params: endpointParams,
      errors: [400, 401, 403, 404, 429],
      response: {
        200: json("Observed outlet state.", outletState),
      },
    }),
    setPower: operation({
      tags: ["endpoints"],
      operationId: "setEndpointPower",
      summary: "Turn an outlet on or off",
      description:
        "Sets one outlet to the requested power state. The caller needs a control key that is allowed to access the device. Sending the same state again is safe. The response repeats the request and returns the observed outlet. A Matter device may report the new switch position before it reports new electrical measurements.",
      params: endpointParams,
      body: {
        type: "object",
        additionalProperties: false,
        required: ["on"],
        properties: {
          on: {
            type: "boolean",
            description: "True turns the socket on. False turns it off.",
          },
        },
      },
      errors: [400, 401, 403, 404, 409, 429],
      response: {
        200: json(
          "The requested power state and the outlet observation after the command.",
          powerResult,
        ),
      },
    }),
    getAvailability: operation({
      tags: ["devices"],
      operationId: "getDeviceAvailability",
      summary: "Check device reachability",
      description:
        "Checks whether the strip can be reached. A mock is reported reachable from saved state. A Matter strip is checked with operational discovery and a secure read. HTTP 200 means the API handled the check; status says whether the strip answered. A failure is returned in this body, not as an HTTP error.",
      params: slugParams,
      errors: [401, 403, 404, 429],
      response: {
        200: json(
          "Reachability of the strip. error is present only when the strip is unreachable.",
          {
            title: "DeviceAvailability",
            type: "object",
            additionalProperties: false,
            required: ["status", "lastSeen"],
            properties: {
              status: reachabilityStatus,
              lastSeen: {
                type: "string",
                format: "date-time",
                nullable: true,
                description:
                  "Last successful contact. Unchanged when this check could not reach the device.",
              },
              error: {
                type: "string",
                description:
                  "Present when status is unreachable. Explains the failed Matter check.",
              },
            },
          },
        ),
      },
    }),
  };
}

export function createAdminSchemas() {
  return {
    listDevices: operation({
      tags: ["devices"],
      operationId: "listAdminDevices",
      summary: "List inventory",
      description:
        "Returns every commissioned and mock strip, including Matter node ids and saved outlet state. Use this before commissioning, renaming, or removing a device.",
      errors: [401, 429],
      response: {
        200: json("All devices on this server, ordered by slug.", {
          title: "DeviceList",
          type: "array",
          items: adminDevice,
        }),
      },
    }),
    addMock: operation({
      tags: ["mocks"],
      operationId: "addMock",
      summary: "Add a mock strip",
      description:
        "Creates a persistent mock strip with socket endpoints 1 and 2, both off. The slug must be unused. Mock outlets accept the same user-API power and state routes as a commissioned strip.",
      body: {
        type: "object",
        additionalProperties: false,
        required: ["slug"],
        properties: {
          slug: {
            type: "string",
            description:
              "New slug for the mock strip. It must not already belong to another device.",
          },
        },
      },
      errors: [400, 401, 409, 429],
      response: {
        201: json("The mock strip, including both sockets.", adminDevice),
      },
    }),
    removeMock: operation({
      tags: ["mocks"],
      operationId: "removeMock",
      summary: "Remove a mock strip",
      description:
        "Deletes a mock strip and its saved outlet state. A commissioned Matter device is rejected; use decommission-self or forget-local for those. This does not change any Matter fabric.",
      params: slugParams,
      errors: [401, 404, 409, 429],
      response: {
        204: none("The mock strip was removed. The response has no body."),
      },
    }),
    commission: operation({
      tags: ["devices"],
      operationId: "commissionDevice",
      summary: "Commission a Matter strip",
      description:
        "Joins a strip that is already on the LAN Wi-Fi. Pass a setup code from a current multi-admin sharing window and a new slug. The code is not stored as an API credential and cannot be reused after the window expires. On success the strip is saved in the local inventory.",
      body: {
        type: "object",
        additionalProperties: false,
        required: ["setupCode", "slug"],
        properties: {
          setupCode: {
            type: "string",
            description:
              "Temporary Matter setup code from the sharing window. Do not send the original pairing code.",
          },
          slug: {
            type: "string",
            description:
              "Slug to assign. It must be unused and is the name user-API clients will call.",
          },
          allowAttestationBypass: {
            type: "boolean",
            description:
              "When true, accept this device if vendor attestation fails. Omit to use the saved server setting.",
          },
        },
      },
      errors: [400, 401, 409, 429],
      response: {
        201: json("The commissioned strip and the outlets discovered on it.", adminDevice),
      },
    }),
    share: operation({
      tags: ["devices"],
      operationId: "shareDevice",
      summary: "Share a strip with another administrator",
      description:
        "Opens an enhanced Matter commissioning window on a commissioned strip. The response contains a one-time manual pairing code and QR code for another administrator. The code is not stored. Opening a window replaces any commissioning window already open on the device. A mock strip is rejected. timeoutSeconds defaults to 180 and must be an integer from 180 through 900.",
      params: slugParams,
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          timeoutSeconds: {
            type: "integer",
            minimum: 180,
            maximum: 900,
            description:
              "How long the device accepts the new administrator, in seconds. Omit for 180. The allowed range is 180 through 900.",
          },
        },
      },
      errors: [400, 401, 404, 409, 429],
      response: {
        200: json(
          "Temporary setup code for the other administrator. It is not stored and expires with the window.",
          shareWindow,
        ),
      },
    }),
    rename: operation({
      tags: ["devices"],
      operationId: "renameDevice",
      summary: "Rename a device",
      description:
        "Changes the slug used in API URLs. The Matter node id, fabric, endpoints, and API-key device grants stay the same because grants are stored by inventory id.",
      params: slugParams,
      body: {
        type: "object",
        additionalProperties: false,
        required: ["slug"],
        properties: {
          slug: {
            type: "string",
            description: "Replacement slug. It must be unused and follow the slug rules.",
          },
        },
      },
      errors: [400, 401, 404, 409, 429],
      response: {
        200: json("The device after the slug change.", adminDevice),
      },
    }),
    ping: operation({
      tags: ["devices"],
      operationId: "pingDevice",
      summary: "Check reachability",
      description:
        "Checks a strip from the administrator API. A mock is reported from saved state and includes kind mock. A Matter strip is checked with discovery and a secure read. HTTP 200 with status unreachable means the API ran the check and the device did not answer.",
      params: slugParams,
      errors: [401, 404, 429],
      response: {
        200: json(
          "Reachability result. kind is included for a mock. error is included when unreachable.",
          availability,
        ),
      },
    }),
    decommissionSelf: operation({
      tags: ["devices"],
      operationId: "decommissionSelf",
      summary: "Remove this controller from the device",
      description:
        "Asks a reachable Matter device to remove the Switchboard fabric, then deletes the local pairing and inventory entry. The device must be a commissioned strip. The secure session can close before a response arrives because the fabric used for that session is the one being removed.",
      params: slugParams,
      errors: [401, 404, 409, 429],
      response: {
        204: none(
          "The local pairing was removed after the device was asked to drop this fabric. No body is returned.",
        ),
      },
    }),
    forgetLocal: operation({
      tags: ["devices"],
      operationId: "forgetLocal",
      summary: "Forget the local pairing",
      description:
        "Removes the local inventory entry and Matter credentials for a commissioned strip. The fabric can remain on the device and keep occupying a fabric slot. Use this when the strip is offline and remote decommissioning cannot finish.",
      params: slugParams,
      errors: [401, 404, 409, 429],
      response: {
        204: none("Local inventory and credentials were removed. No body is returned."),
      },
    }),
    listFabrics: operation({
      tags: ["fabrics"],
      operationId: "listFabrics",
      summary: "List Matter fabrics",
      description:
        "Reads every fabric on a commissioned strip, not only the Switchboard fabric. Use the returned index and label immediately for removal. A mock strip has no fabrics and is rejected.",
      params: slugParams,
      errors: [401, 404, 409, 429],
      response: {
        200: json("Fabrics currently on the device.", {
          title: "FabricList",
          type: "array",
          items: fabric,
        }),
      },
    }),
    removeFabric: operation({
      tags: ["fabrics"],
      operationId: "removeFabric",
      summary: "Remove a Matter fabric",
      description:
        "Removes one fabric from a reachable commissioned strip. The body must repeat that fabric's current label. If the label is empty, send the fabric index as a decimal string. Removing another administrator's fabric disconnects that ecosystem. The device must be reachable.",
      params: fabricParams,
      body: {
        type: "object",
        additionalProperties: false,
        required: ["confirmLabel"],
        properties: {
          confirmLabel: {
            type: "string",
            description:
              "Exact label from the fabric list. When the label is empty, the fabric index as a decimal string.",
          },
        },
      },
      errors: [400, 401, 404, 409, 429],
      response: {
        204: none("The fabric was removed. No body is returned."),
      },
    }),
    createKey: operation({
      tags: ["keys"],
      operationId: "createApiKey",
      summary: "Create an API key",
      description:
        "Creates a user-API key and returns its plaintext token once. Only a verifier is stored. Choose read or control, and optionally limit the key to existing device slugs. A limited key keeps access across rename because the grant is stored by device id.",
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name", "scope"],
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description:
              "Unique name shown in the key list and used to delete the key. It is not a secret.",
          },
          scope: {
            type: "string",
            enum: ["read", "control"],
            description: "read lists and reads. control also turns outlets on and off.",
          },
          devices: {
            description:
              "Slugs the key may access. Omit or send null to allow every current and future device. Each slug must already exist.",
            anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
          },
        },
      },
      errors: [400, 401, 404, 409, 429],
      response: {
        201: json("Key metadata and the one-time plaintext token.", createdKey),
      },
    }),
    listKeys: operation({
      tags: ["keys"],
      operationId: "listApiKeys",
      summary: "List API keys",
      description:
        "Returns key names, scopes, device limits, and revocation time. Plaintext tokens are not stored and are not included. Device limits are shown as current slugs. Use the name to delete a key.",
      errors: [401, 429],
      response: {
        200: json("API keys ordered by creation time.", {
          title: "ApiKeyList",
          type: "array",
          items: storedKey,
        }),
      },
    }),
    deleteKey: operation({
      tags: ["keys"],
      operationId: "deleteApiKey",
      summary: "Delete an API key",
      description:
        "Deletes the key with this unique name and removes its stored record. The next user-API request that presents the token is rejected. An unknown name returns 404.",
      params: keyParams,
      errors: [401, 404, 429],
      response: {
        204: none("The key was deleted. No body is returned."),
      },
    }),
    getConfig: operation({
      tags: ["configuration"],
      operationId: "getConfig",
      summary: "Read service configuration",
      description:
        "Returns the saved listener addresses, Matter country code, attestation policy, and log level. The administrator credential is not part of this document.",
      errors: [401, 429],
      response: {
        200: json("Saved service configuration.", serviceConfig),
      },
    }),
    putConfig: operation({
      tags: ["configuration"],
      operationId: "updateConfig",
      summary: "Update service configuration",
      description:
        "Replaces any included settings and leaves the others unchanged. Unknown fields are rejected. apiHost and both ports are validated, and the administrator host must stay 127.0.0.1. Restart the service before a host or port change is used for listening. Log level applies to the running process immediately.",
      body: configUpdate,
      errors: [400, 401, 429],
      response: {
        200: json("Configuration after the change was saved.", serviceConfig),
      },
    }),
  };
}

/** Publish Swagger UI and the OpenAPI document for one listener. */
export async function registerDocumentation(
  app: FastifyInstance,
  audience: "admin" | "user",
): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: audience === "admin" ? adminInfo : userInfo,
      servers: [{ url: "/", description: "This Switchboard listener" }],
      tags: audience === "admin" ? adminTags : userTags,
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: audience === "admin" ? adminBearer : userBearer,
          },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list" } });
  // Served for clients, and omitted from the document it returns.
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
}
