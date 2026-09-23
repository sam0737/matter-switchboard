# Matter Switchboard

Matter Switchboard is a local-user Matter controller and HTTP API for managing
and controlling multiple Matter power strips on one LAN. It provides a small,
programmable interface for remote programs while keeping Matter fabric
credentials and device administration on one server. It also supports
persistent mock strips, each with two controllable sockets, for integration
work without a physical device.

The service runs as an ordinary operating-system user. It does not require a
root installation, a database server, MQTT broker, or cloud account. Matter
communication stays on the local network; the HTTP API is reached by the
server's LAN IP.

## Quick start

Requirements: Node.js 22 or newer, npm, and a Linux host on the same LAN as the
Matter devices. The host network must pass IPv6 and mDNS multicast between the
server and the devices.

```sh
npm ci
npm run build
npm install --global --prefix "$HOME/.local" .
export PATH="$HOME/.local/bin:$PATH"
matter-switchboard init
matter-switchboard server
```

`init` creates user-owned configuration, storage, and an administrator
credential file. The server prints its API and documentation URLs. The local
CLI reads the administrator credential from that file automatically.
Leave the server running and open a second terminal for management commands.
From an existing Matter administrator such as Home Assistant, open a sharing
window for a strip. Then run `matter-switchboard device commission` and enter
the new setup code. The strip must already be on Wi-Fi.

Create an API key for a program and limit it to the device(s) it needs:

```sh
matter-switchboard key create --name irrigation --devices patio-strip
```

The key is shown once. A program uses it in the HTTP `Authorization` header:

```sh
curl -X PUT "http://SERVER_LAN_IP:8090/v1/devices/patio-strip/endpoints/2/power" \
  -H "Authorization: Bearer API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"on":true}'
```

For endpoint IDs and current readings, see [API usage](docs/usage.md#api-usage).
For full CLI commands, see [Administration](docs/usage.md#administration).

## Documentation

- [Architecture](docs/architecture.md) — components, HTTP APIs, authentication,
  Swagger/OpenAPI, rate limits, and security.
- [Building](docs/building.md) — dependencies, linting, unit tests, and E2E tests.
- [Installation and configuration](docs/installation.md) — unprivileged
  installation, configuration, API keys, and storage paths.
- [Usage](docs/usage.md) — Matter administration and HTTP control examples.
- [Open decisions](docs/open_decisions.md) — questions to resolve before
  implementation is considered complete.
