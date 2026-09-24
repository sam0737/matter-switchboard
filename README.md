# Matter Switchboard

[![CI](https://github.com/sam0737/matter-switchboard/actions/workflows/ci.yml/badge.svg)](https://github.com/sam0737/matter-switchboard/actions/workflows/ci.yml)

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

![Matter Switchboard controlling a strip from the terminal and HTTP API](docs/demo.webp)

## Quick start

Requirements: Node.js 22 or newer, npm, and a Linux host on the same LAN as the
Matter devices. The host network must pass IPv6 and mDNS multicast between the
server and the devices.

```sh
npx matter-switchboard init
npx matter-switchboard server
# In another session
npx matter-switchboard
```

To install the command under your home directory:

```sh
npm install --global --prefix "$HOME/.local" matter-switchboard
export PATH="$HOME/.local/bin:$PATH"
```

Add `$HOME/.local/bin` to the shell `PATH` permanently. After that,
`matter-switchboard` works without `npx`.

`init` creates user-owned configuration, storage, and an administrator
credential file. Leave the server running. The second session opens the live
dashboard. Press `c` to configure.

Switchboard joins devices that are already on the LAN. It does not use
Bluetooth and does not provision Wi-Fi. Commission a new strip with a phone
app onto Wi-Fi and that app's fabric, then share a temporary multi-admin setup
code into Switchboard. With no other smart-home controller, use the
[Google Home Mobile SDK sample app for Matter](https://github.com/sam0737/sample-apps-for-matter-android):
commission the device onto Wi-Fi and the app's local fabric, then share the
commissioning code and enter it under Configure → Commission. To let another
administrator join a strip this server already controls, share from Configure
or run `matter-switchboard device share`.

Create an API key from the same configure screen (`c`, then API keys), and
limit it to the device(s) it needs. The key is shown once. A program uses it
in the HTTP `Authorization` header:

```sh
curl -X PUT "http://SERVER_LAN_IP:8090/v1/devices/patio-strip/endpoints/2/power" \
  -H "Authorization: Bearer API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"on":true}'
```

The server prints documentation URLs at startup. Open the user API Swagger UI
at `http://SERVER_LAN_IP:8090/docs` (default port 8090). `/docs` and
`/openapi.json` are readable without a key; device and outlet calls still need
the bearer key.

Source checkout, a user-local install, and a lingering systemd service are in
[Installation](docs/installation.md). Building from source is in
[Building](docs/building.md). For endpoint IDs and current readings, see
[API usage](docs/usage.md#api-usage). For full CLI commands, see
[Administration](docs/usage.md#administration).

## Documentation

- [Architecture](docs/architecture.md) — components, HTTP APIs, authentication,
  Swagger/OpenAPI, rate limits, and security.
- [Building](docs/building.md) — dependencies, linting, unit tests, and E2E tests.
- [Installation and configuration](docs/installation.md) — npx, Swagger,
  systemd, configuration, API keys, and storage paths.
- [Usage](docs/usage.md) — Matter administration and HTTP control examples.
- [Open decisions](docs/open_decisions.md) — questions to resolve before
  implementation is considered complete.
