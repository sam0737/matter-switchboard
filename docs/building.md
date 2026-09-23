# Building

## Requirements

- Node.js 22 or newer and npm.
- Git for source checkout.
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

End-to-end tests run the service and a Matter test device/controller on an
isolated test network. They cover commissioning, persistence across restart,
device and endpoint listing, reachability, outlet state reads, on/off commands,
and fabric removal. E2E tests never target production devices by default.

## Package for user-local installation

```sh
npm run build
npm pack
```

The package contains compiled output, runtime dependencies, CLI entry points,
and documentation. Installation is performed under the user's home directory;
see [Installation](installation.md).
