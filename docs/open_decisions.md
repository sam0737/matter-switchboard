# Open decisions

These questions require product-owner answers. Current defaults are recorded
where a reasonable starting point exists; answers may change the interface or
security model.

## Outlet command rate limit and debounce

**Question:** What minimum spacing should apply to repeated commands to one
outlet, and should rapid commands be rejected, coalesced to the latest desired
state, or queued?

**Why it matters:** A global API-key limit does not prevent a single outlet
from receiving rapid on/off requests. Some strips may delay, coalesce, or reject
rapid Matter commands.

**Current status:** TBD. The service serializes commands per endpoint, but has
no specified debounce duration or per-outlet rate limit.

## Admin listener scope

**Question:** Is a loopback-only administrator API sufficient, with remote
administration performed by SSHing to the host and running the CLI there?

**Default:** Yes. The administrator listener binds to loopback; only the user
API binds to the LAN address. Explicit remote admin access should require a
separate credential and transport policy.

## Admin CLI credential bootstrap and recovery

**Question:** Should the initial administrator credential be created by
`matter-switchboard init` and stored in a mode-`0600` file, or should local OS
user identity plus a Unix socket replace the admin HTTP credential entirely?

**Default:** The local CLI calls the loopback HTTP admin API with a per-user
credential in the user's config directory. The server authenticates the
credential, not the CLI executable. Recovery is by rotating the local
administrator credential while logged in as the service user.

## Remote user API transport

**Question:** Is plain HTTP acceptable on the LAN, or should TLS be included in
the first release?

**Default:** HTTP is allowed for the trusted LAN deployment, with a clear
warning that bearer keys can be observed by a network peer. Do not expose the
service to the internet. TLS or VPN is required if traffic crosses an
untrusted network.

## Remote API binding and firewall

**Question:** Should the API bind to one explicitly configured LAN interface, or
all host interfaces with firewall restrictions?

**Default:** Bind to one configured LAN address; never bind publicly by default.
Document host firewall rules as part of deployment.

## Slug generation

**Question:** Should commissioning require a caller-supplied slug, or generate
one from vendor/product plus a short suffix and allow rename afterward?

**Default:** Commissioning requires a caller-supplied slug. On a terminal the
CLI prompts when it is omitted. Rename remains available afterward.
Generating a slug from vendor and product is not implemented.

## Metering data support

**Question:** Should current, voltage, and wattage endpoints return nullable
fields for every outlet, or should the API omit fields when the device does not
support the corresponding Matter measurement cluster?

**Default:** Keep a stable response shape with `null` values and an explicit
capability/status field. Confirm which measurements the target P304M firmware
actually exposes over Matter before making them part of a compatibility promise.

## Fabric-removal confirmation

**Question:** Is an exact fabric-label flag acceptable for non-interactive
removal of another fabric?

**Default:** Yes. Interactive use displays the fabric label and available
vendor information and asks for the label. A non-terminal session requires
`--confirm-fabric-label` and exits instead of waiting. Fabric removal can
revoke another admin's access and must not be exposed to user API keys.

## Controller storage backup and restore

**Question:** Is manual backup of the user-owned data directory acceptable, or
is an export/import command needed in the first release?

**Default:** Document manual secure backups first. The Matter storage contains
fabric private keys; backups must be protected and a copied controller identity
must not be run concurrently with the original.

## MQTT and multi-site support

**Question:** Are event delivery, queued commands, or multiple physical sites
expected soon?

**Default:** No. Use REST for a single LAN/site. Revisit MQTT or a brokered
architecture only when asynchronous events, offline delivery, or multi-site
routing is a concrete need.
