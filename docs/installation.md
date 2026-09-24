# Installation and configuration

Matter Switchboard is installed and operated by a regular local user. It does
not install files under `/usr`, require `sudo`, or run as root.

## User-local installation

From a source checkout:

```sh
npm ci
npm run build
npm install --global --prefix "$HOME/.local" .
export PATH="$HOME/.local/bin:$PATH"
```

Add `$HOME/.local/bin` to the user's shell `PATH` permanently. The CLI can also
be run directly from the checkout during development. Installation and data
directories are created with the invoking user's ownership.

Start the service in a terminal:

```sh
matter-switchboard init
matter-switchboard server
```

The service can optionally run as a `systemd --user` service. It must retain
the same user and storage directory across restarts. Do not run two controller
instances against the same storage at once.

### Single-instance lock

The server acquires an exclusive per-user OS lock before it reads Matter
storage or opens network listeners. The lock file is stored under the user's
runtime directory (`$XDG_RUNTIME_DIR/matter-switchboard/server.lock`), with a
state-directory fallback when no runtime directory is available. A second
`matter-switchboard server` invocation reports that the service is already
running and exits with a non-zero status without touching controller state. It
does not stop the active process.

The operating system releases the lock when its process exits, including after
a crash. A leftover lock file is normal and does not indicate a live process;
do not delete it as a recovery step. The lock held by the process, rather than
the file's presence or its recorded PID, determines whether another instance
can start.

## First-time setup

`matter-switchboard init` creates directories, generates the administrator
credential, and writes the initial configuration. The credential is saved in a
user-only file. The administrator credential is not a user
API key and cannot be used by remote programs to control outlets.

Configure the LAN bind address and HTTP port before starting the service. The
default user API binds to `0.0.0.0:8090` (all IPv4 interfaces); the
administrator listener binds only to `127.0.0.1:8091`. Restrict the user API
with a host firewall or bind it to a specific LAN address. The service reports
its effective URLs at startup. A static LAN address or DHCP reservation is
recommended for callers that use direct IP access.

## Configuration and reconfiguration

Configuration is stored as a user-owned file in the XDG config directory:

```text
$XDG_CONFIG_HOME/matter-switchboard/config.json
```

When `XDG_CONFIG_HOME` is unset, the default is `~/.config`. Configuration
includes the HTTP bind address/port, administrator loopback listener, Matter
network-interface selection, logging level, and local-management settings.
Secrets are stored separately from non-secret configuration.

Use `matter-switchboard config show` to inspect non-secret settings and
`matter-switchboard config set <name> <value>` to update a setting. Restart the
service after changing listener settings. The
effective configuration and validation errors are printed at startup.

### Logging

`logLevel` sets the minimum severity written by the service and the Matter
stack. The default is `info`, so info, notice, warn, error, and fatal messages
are kept and debug messages are omitted. Use `debug` while diagnosing
commissioning or network problems:

```sh
matter-switchboard config set logLevel debug
```

Accepted values are `debug`, `info`, `notice`, `warn`, `error`, and `fatal`.
A running service applies the new level immediately. Configuration files that
omit `logLevel` use `info`.

Re-run `matter-switchboard init` only to create missing files. It does not
reset commissioned Matter state or overwrite existing credentials. Use the
explicit reset command only when intentionally discarding controller identity
and device inventory.

## Storage locations and permissions

Paths follow the XDG Base Directory convention and can be overridden with the
standard environment variables:

| Data             | Default path                         | Purpose                                                      |
| ---------------- | ------------------------------------ | ------------------------------------------------------------ |
| Configuration    | `~/.config/matter-switchboard/`      | Listener and service configuration, administrator credential |
| Matter data      | `~/.local/share/matter-switchboard/` | Fabric keys, controller state, commissioned-node records     |
| Mock device data | `~/.local/share/matter-switchboard/` | Mock inventory and persisted socket power states             |
| Runtime state    | `~/.local/state/matter-switchboard/` | Logs, audit records, transient state                         |
| CLI executable   | `~/.local/bin/matter-switchboard`    | User-local command                                           |

Directories are mode `0700`; secret and state files are mode `0600`, owned by
the local user. Matter data contains private credentials that permit control of
the Switchboard fabric. Back it up only to a protected location. Losing that
data loses the controller's fabric identity; deleting it does not remove the
fabric from devices.

API-key verifiers, key metadata, device slugs, inventory, and mock socket power
states are persisted in local files with atomic replacement. No database server
is used.

## API key lifecycle

Create one scoped key per remote program:

```sh
matter-switchboard key create irrigation control patio-strip
matter-switchboard key list
matter-switchboard key delete <name>
```

The full key is printed only on creation. Copy it to the calling program's
secret store. The service stores only a verifier and metadata. Keys can be
limited to `read` or `control` and to a list of device slugs. Omit the device
list to allow every device. Deleting a key removes its record immediately.
Keys must not be committed to source control or passed in a URL.

The local CLI uses the separate administrator credential stored under the
invoking user's config directory to call the loopback admin API. The service
validates the credential; it does not identify the CLI binary. Local file
permissions protect this credential from other OS users.

To rotate the administrator credential, use
`matter-switchboard admin-credential rotate`. The command replaces the local
credential and invalidates the old one. It does not change Matter fabric keys
or remote program API keys.
