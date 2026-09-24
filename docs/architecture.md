# Architecture

Matter Switchboard is a single-site, local-user service that presents a small
HTTP API over a persistent Matter controller. It supports multiple power strips
on one LAN, with one Matter fabric owned by the Switchboard controller.

## Overview and technology stack

- **Runtime:** Node.js 22+ with TypeScript, compiled to JavaScript for
  distribution.
- **Matter controller:** Matter.js, with persistent fabric and commissioned
  node state.
- **HTTP server:** Fastify with request schemas and generated OpenAPI.
- **Admin CLI:** TypeScript command-line client using the administrator HTTP
  listener on loopback. On an interactive terminal, the same binary opens a
  full-screen dashboard and configure UI. The user API listener is bound to the
  configured LAN address.
- **Management files:** Small user-owned JSON configuration and inventory
  files, written atomically. No database daemon is required.
- **Documentation UI:** OpenAPI JSON and Swagger UI, available on the LAN API
  listener. The interface documents operations but does not bypass
  authentication.

The service keeps the API and Matter controller in one process. It exposes two
HTTP listeners: an administrator listener on loopback and a user API listener
on the configured LAN address. They share service state. Matter commands are
serialized per endpoint to avoid overlapping operations on one outlet. Matter
fabric credentials remain in controller storage and are never returned through
the user API.

### Single-instance service lifecycle

Only one `matter-switchboard server` process may use a given storage directory
at a time. Before opening Matter storage or binding either HTTP listener, the
process acquires a non-blocking, OS-level exclusive lock on a per-user lock
file. The held file descriptor is the authority for ownership; PID and start
time recorded beside it are diagnostic information only.

If another process already holds the lock, the new invocation prints that
Matter Switchboard is already running (including the recorded PID when
available), exits without opening or changing controller storage, and returns a
non-zero status. It must not terminate or signal the existing process. The
lock is released automatically by the operating system when the process exits
or crashes. The lock file itself may remain on disk; its existence alone does
not mean the service is running and it must not be manually deleted to recover
from a crash.

This guard applies to manual launches and service-manager launches, preventing
both from opening the same Matter fabric storage concurrently. A service
manager may restart the process after a crash; the OS-released lock allows the
restart to acquire it normally.

Matter strips are commissioned onto the server's fabric through Matter
multi-admin sharing. The strip is already provisioned onto Wi-Fi by another
commissioner. Switchboard uses the setup code from a temporary commissioning
window and does not provision Wi-Fi credentials.

### Mock devices

Mock strips are first-class inventory devices and can be added or removed with
the administrator CLI at any time, including in production. They are not
Matter nodes and require no commissioning or network discovery. Each mock strip
has exactly two socket endpoints. It implements the same outlet control and
state API shape as a real strip so programs can exercise their normal API calls.

Mock device identity and socket power state are persisted in the local
Switchboard data directory. Power state survives service restarts. A mock
device is labeled as mock in inventory and API responses; its simulated state
must not be interpreted as proof that a physical outlet changed. It does not
report measured current, voltage, or wattage unless a future specification adds
explicit simulation for those readings.

Matter requires local IPv6 and mDNS/multicast for discovery. The HTTP API can
use IPv4 direct-IP access independently of Matter's local discovery. The host
must be on a network where Matter traffic can reach the strips.

## HTTP interfaces

There are two HTTP API surfaces, hosted by separate listeners in the same
process:

1. **Administrator API** — device commissioning and removal, inventory
   management, reachability checks, and API-key management. It also serves the
   `/v1` device and outlet routes so the local CLI and TUI can read state and
   toggle sockets with the administrator credential. It listens on loopback and
   is used by the local CLI.
2. **User API** — device and endpoint inventory, state reads, and outlet power
   commands. It listens on the configured LAN address for remote programs.
   Program API keys are required. The administrator credential is not accepted
   on this listener.

Each listener publishes its own OpenAPI document. The administrator document
includes management routes and the `/v1` outlet routes. The user document
includes only the `/v1` routes. Admin-only routes require an administrator
credential; `/v1` routes on the LAN listener require a scoped API key. Swagger
UI and the OpenAPI document are readable without authentication on either
listener, but operations still enforce authentication and authorization.

The user API uses stable device slugs for URLs. Each slug maps to an internal
Matter Node ID; endpoint IDs identify individual outlets. Slugs can be renamed
without changing Matter identity.

## Authentication and authorization

### User API keys

Keys are generated with cryptographically secure randomness. A key is displayed
once at creation; only a verifier and metadata are stored. Each key has a name,
creation time, scopes, and optional device allowlist. Key names are unique.
Deleting a key removes its record, including the name. Supported
scopes are `read` and `control`. Key management is available only to an
administrator.

Clients send keys with `Authorization: Bearer <key>`. Keys are not accepted in
query strings or URLs. Deletion takes effect on the next request. One key per
calling program is the expected use so a leaked key can be deleted without
disrupting other programs.

### Administrator CLI

The CLI calls administrator HTTP routes on loopback, including the `/v1`
outlet routes mounted on that listener, and reads its administrator
credential from the invoking user's configuration directory. The credential
file is owned by that user and has mode `0600`; configuration directories have
mode `0700`. The administrator listener binds only to loopback by default. The
CLI does not send administrator credentials over the LAN listener.

The service authenticates the credential, not the CLI executable. Any local
program that can read the credential can act as that administrator; OS user
account security and file permissions are the local trust boundary. The CLI
does not embed a shared hard-coded secret.

If remote administration is enabled explicitly, it requires a separate
administrator credential and is protected by the configured transport/network
policy. It is disabled by default.

### Rate limits

The HTTP process applies an in-memory sliding-window rate limiter to restricted routes. `/health`, `/openapi.json`, and `/docs` (including Swagger assets) are exempt.

- Unauthenticated requests to restricted routes: **3 requests per IP per 5 seconds**.
- Authenticated requests to restricted routes: **30 requests per API key per 5 seconds**.

Rejected requests return HTTP `429 Too Many Requests` and a `Retry-After`
header. In-memory counters reset when the service restarts and are not shared
with another process. Outlet-specific rate limiting and command debounce are
not defined yet; see [Open decisions](open_decisions.md#outlet-command-rate-limit-and-debounce).

## OpenAPI and Swagger UI

- OpenAPI 3 document: `GET /openapi.json` on each listener
- Swagger UI: `GET /docs` on each listener

The administrator OpenAPI document describes management routes and the `/v1`
device and outlet routes; the user OpenAPI document describes device and outlet
routes only. Each documents its bearer authentication requirement. Swagger is
useful for discovery and manual development, not as an authorization
mechanism. It is served by the local service and is not published to an
external documentation host.

## Security boundaries

The API is intended for one trusted LAN and is not exposed to the public
internet. Plain HTTP may be used on that LAN, but bearer keys are visible to
anyone able to observe the traffic. Use TLS or a VPN if the LAN is not trusted
or requests cross a network boundary. Bind the API to the intended interface
and use host/network firewall rules to restrict access.

All device and fabric administration routes require administrator access. User
keys cannot commission devices, rename devices, remove fabrics, or manage keys.
Removing a fabric other than the Switchboard fabric requires an explicit
confirmation step and displays the fabric label and vendor information before
the operation.
