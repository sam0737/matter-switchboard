# Building

## Requirements

- Node.js 22 or newer and npm.
- Git for source checkout.
- GNU `flock` (provided by util-linux) for the single-instance server lock.
- A Linux host with IPv6 and mDNS/multicast connectivity for Matter end-to-end
  commissioning and control tests.

The application is authored in TypeScript and distributed as compiled
JavaScript. It does not require root privileges to build or install.

## Install development dependencies

```sh
npm ci
```

`package-lock.json` pins the dependency tree. Changes to dependencies update
the lockfile and are reviewed with the source change.

## Build and lint

```sh
npm run build
npm run lint
npm run lint -- --fix
npm run format:check
npm run format
```

ESLint checks TypeScript and can automatically fix supported issues with
`--fix`. Prettier applies consistent formatting. Build output is generated
under `dist/` and is not edited by hand.

## Tests

```sh
npm test
npm run test:unit
npm run test:e2e
```

Unit tests cover API validation, authorization, key creation and revocation,
rate limits, storage updates, and command scheduling. Matter transport and
controller behavior are mocked for unit tests.

End-to-end tests start the service as a child process and add a persistent mock
strip through the production CLI. They cover API authentication and rate limits,
device and endpoint listing, outlet state reads, on/off commands, persistence
across restart, and single-instance locking. They do not commission real Matter
hardware; a physical-device integration test can be run separately on an
isolated Matter network.

## Package for user-local installation

```sh
npm run build
npm pack
```

The package contains compiled output, runtime dependencies, CLI entry points,
and documentation. Installation is performed under the user's home directory;
see [Installation](installation.md).
