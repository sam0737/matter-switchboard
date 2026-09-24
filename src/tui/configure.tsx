import { useState } from "react";
import { initConfig } from "../config.js";
import { fabricRemovalConfirmation } from "../confirm.js";
import { deviceAllowlist } from "../inventory.js";
import {
  addMock,
  commissionDevice,
  createKey,
  decommissionSelf,
  forgetLocal,
  getConfig,
  listDevices,
  listFabrics,
  listKeys,
  parseConfigValue,
  pingDevice,
  putConfig,
  removeFabric,
  removeMock,
  renameDevice,
  deleteKey,
  rotateAdminCredential,
} from "../admin-api.js";
import path from "node:path";
import { files } from "../paths.js";
import { errorMessage, pretty } from "./format.js";
import { Menu } from "./menu.js";
import { Busy, Prompt, Result } from "./prompt.js";

type Group = "devices" | "mocks" | "fabrics" | "keys" | "config" | "local";

interface MenuScreen {
  k: "menu";
  id: "home" | Group;
}

interface BusyScreen {
  k: "busy";
}

interface ResultScreen {
  k: "result";
  title: string;
  body: string;
  returnTo: "home" | Group;
}

interface PickScreen {
  k: "pick";
  title: string;
  items: Array<{ id: string; label: string }>;
  returnTo: "home" | Group;
  then: (id: string) => void;
}

interface PromptScreen {
  k: "prompt";
  title: string;
  label: string;
  hidden?: boolean;
  returnTo: "home" | Group;
  then: (value: string) => void;
}

type Screen = MenuScreen | BusyScreen | ResultScreen | PickScreen | PromptScreen;

const homeItems = [
  { id: "devices", label: "Devices" },
  { id: "mocks", label: "Mocks" },
  { id: "fabrics", label: "Fabrics" },
  { id: "keys", label: "API keys" },
  { id: "config", label: "Config" },
  { id: "local", label: "Init and credential" },
];

const groupItems: Record<Group, Array<{ id: string; label: string }>> = {
  devices: [
    { id: "list", label: "List" },
    { id: "show", label: "Show" },
    { id: "commission", label: "Commission" },
    { id: "rename", label: "Rename" },
    { id: "ping", label: "Ping" },
    { id: "endpoints", label: "Endpoints" },
    { id: "decommission-self", label: "Decommission self" },
    { id: "forget-local", label: "Forget local" },
  ],
  mocks: [
    { id: "list", label: "List" },
    { id: "add", label: "Add" },
    { id: "remove", label: "Remove" },
  ],
  fabrics: [
    { id: "list", label: "List" },
    { id: "remove", label: "Remove" },
  ],
  keys: [
    { id: "list", label: "List" },
    { id: "create", label: "Create" },
    { id: "delete", label: "Delete" },
  ],
  config: [
    { id: "show", label: "Show" },
    { id: "set", label: "Set" },
  ],
  local: [
    { id: "init", label: "Init" },
    { id: "rotate", label: "Rotate administrator credential" },
  ],
};

const titles: Record<"home" | Group, string> = {
  home: "Configure",
  devices: "Devices",
  mocks: "Mocks",
  fabrics: "Fabrics",
  keys: "API keys",
  config: "Config",
  local: "Init and credential",
};

export function Configure(props: { onBack: () => void }) {
  const [screen, setScreen] = useState<Screen>({ k: "menu", id: "home" });

  const fail = (returnTo: "home" | Group, error: unknown) => {
    setScreen({ k: "result", title: "Error", body: errorMessage(error), returnTo });
  };

  const succeed = (returnTo: "home" | Group, title: string, body: string) => {
    setScreen({ k: "result", title, body, returnTo });
  };

  const run = (returnTo: "home" | Group, title: string, work: () => Promise<string>) => {
    setScreen({ k: "busy" });
    void (async () => {
      try {
        succeed(returnTo, title, await work());
      } catch (error) {
        fail(returnTo, error);
      }
    })();
  };

  const pickDevice = (
    title: string,
    returnTo: Group,
    then: (slug: string) => void,
    filter?: (kind: string) => boolean,
  ) => {
    setScreen({ k: "busy" });
    void (async () => {
      try {
        const devices = await listDevices();
        const filtered = filter ? devices.filter((device) => filter(device.kind)) : devices;
        if (filtered.length === 0) {
          succeed(returnTo, title, "No devices registered.");
          return;
        }
        setScreen({
          k: "pick",
          title,
          returnTo,
          items: filtered.map((device) => ({
            id: device.slug,
            label: `${device.slug}  ${device.kind}`,
          })),
          then,
        });
      } catch (error) {
        fail(returnTo, error);
      }
    })();
  };

  const prompt = (
    title: string,
    label: string,
    returnTo: "home" | Group,
    then: (value: string) => void,
    hidden = false,
  ) => {
    setScreen({
      k: "prompt",
      title,
      label,
      returnTo,
      then,
      ...(hidden ? { hidden: true } : {}),
    });
  };

  const onHomeSelect = (id: string) => {
    setScreen({ k: "menu", id: id as Group });
  };

  const onGroupSelect = (group: Group, id: string) => {
    if (group === "devices") {
      if (id === "list") {
        run("devices", "Devices", async () => {
          const devices = await listDevices();
          if (devices.length === 0) return "No devices registered.";
          return devices
            .map(
              (device) =>
                `${device.slug.padEnd(24)} ${device.kind.padEnd(7)} ${device.endpoints.length} endpoint(s)  node=${device.nodeId ?? "—"}`,
            )
            .join("\n");
        });
        return;
      }
      if (id === "show") {
        pickDevice("Show device", "devices", (slug) => {
          run("devices", slug, async () => {
            const devices = await listDevices();
            const found = devices.find((device) => device.slug === slug);
            if (!found) throw new Error(`Device '${slug}' was not found`);
            return pretty(found);
          });
        });
        return;
      }
      if (id === "commission") {
        prompt("Commission", "Device slug:", "devices", (slug) => {
          prompt(
            "Commission",
            "Temporary Matter setup code:",
            "devices",
            (setupCode) => {
              run("devices", `Commissioned '${slug}'`, async () =>
                pretty(await commissionDevice({ slug, setupCode })),
              );
            },
            true,
          );
        });
        return;
      }
      if (id === "rename") {
        pickDevice("Rename device", "devices", (slug) => {
          prompt("Rename", "New slug:", "devices", (newSlug) => {
            run("devices", "Renamed", async () => pretty(await renameDevice(slug, newSlug)));
          });
        });
        return;
      }
      if (id === "ping") {
        pickDevice("Ping device", "devices", (slug) => {
          run("devices", `Ping ${slug}`, async () => pretty(await pingDevice(slug)));
        });
        return;
      }
      if (id === "endpoints") {
        pickDevice("Endpoints", "devices", (slug) => {
          run("devices", `${slug} endpoints`, async () => {
            const devices = await listDevices();
            const found = devices.find((device) => device.slug === slug);
            if (!found) throw new Error(`Device '${slug}' was not found`);
            return pretty(found.endpoints);
          });
        });
        return;
      }
      if (id === "decommission-self") {
        pickDevice(
          "Decommission self",
          "devices",
          (slug) => {
            prompt(
              "Decommission self",
              `Remove the Matter Switchboard fabric from '${slug}'? Type '${slug}':`,
              "devices",
              (entered) => {
                run("devices", "Decommissioned", async () => {
                  if (entered !== slug)
                    throw new Error("Confirmation did not match; device was not changed");
                  await decommissionSelf(slug);
                  return `Decommissioned '${slug}' from the Switchboard fabric.`;
                });
              },
            );
          },
          (kind) => kind === "matter",
        );
        return;
      }
      if (id === "forget-local") {
        pickDevice(
          "Forget local",
          "devices",
          (slug) => {
            prompt(
              "Forget local",
              `Forget '${slug}' locally? The Matter fabric may remain on the device. Type '${slug}':`,
              "devices",
              (entered) => {
                run("devices", "Forgot locally", async () => {
                  if (entered !== slug)
                    throw new Error("Confirmation did not match; local state was not changed");
                  await forgetLocal(slug);
                  return `Forgot '${slug}' locally. The device may still hold this Matter fabric.`;
                });
              },
            );
          },
          (kind) => kind === "matter",
        );
        return;
      }
    }
    if (group === "mocks") {
      if (id === "list") {
        run("mocks", "Mocks", async () => {
          const devices = (await listDevices()).filter((device) => device.kind === "mock");
          if (devices.length === 0) return "No devices registered.";
          return devices
            .map(
              (device) =>
                `${device.slug.padEnd(24)} ${device.kind.padEnd(7)} ${device.endpoints.length} endpoint(s)  node=${device.nodeId ?? "—"}`,
            )
            .join("\n");
        });
        return;
      }
      if (id === "add") {
        prompt("Add mock", "Slug:", "mocks", (slug) => {
          run("mocks", "Mock added", async () => pretty(await addMock(slug)));
        });
        return;
      }
      if (id === "remove") {
        pickDevice(
          "Remove mock",
          "mocks",
          (slug) => {
            run("mocks", "Removed", async () => {
              await removeMock(slug);
              return `Removed mock '${slug}'.`;
            });
          },
          (kind) => kind === "mock",
        );
        return;
      }
    }
    if (group === "fabrics") {
      if (id === "list") {
        pickDevice(
          "List fabrics",
          "fabrics",
          (slug) => {
            run("fabrics", `${slug} fabrics`, async () => pretty(await listFabrics(slug)));
          },
          (kind) => kind === "matter",
        );
        return;
      }
      if (id === "remove") {
        pickDevice(
          "Remove fabric",
          "fabrics",
          (slug) => {
            setScreen({ k: "busy" });
            void (async () => {
              try {
                const fabrics = await listFabrics(slug);
                if (fabrics.length === 0) {
                  succeed("fabrics", "Fabrics", "No fabrics reported.");
                  return;
                }
                setScreen({
                  k: "pick",
                  title: `Fabrics on ${slug}`,
                  returnTo: "fabrics",
                  items: fabrics.map((fabric) => ({
                    id: String(fabric.fabricIndex),
                    label: `${fabric.fabricIndex}  ${fabric.label}  vendor ${fabric.vendorId}`,
                  })),
                  then: (index) => {
                    const target = fabrics.find((fabric) => String(fabric.fabricIndex) === index);
                    if (!target) {
                      fail("fabrics", new Error(`Fabric index ${index} was not found`));
                      return;
                    }
                    prompt(
                      "Remove fabric",
                      target.label.length > 0
                        ? `Target fabric '${target.label}' (vendor ${target.vendorId}). Type the exact label to remove it:`
                        : `Target fabric has no label (index ${target.fabricIndex}, vendor ${target.vendorId}). Type ${fabricRemovalConfirmation(target)} to remove it:`,
                      "fabrics",
                      (entered) => {
                        run("fabrics", "Removed fabric", async () => {
                          const expected = fabricRemovalConfirmation(target);
                          if (entered !== expected)
                            throw new Error("Confirmation did not match; fabric was not removed");
                          await removeFabric(slug, target.fabricIndex, entered);
                          return `Removed fabric ${target.fabricIndex} from '${slug}'.`;
                        });
                      },
                    );
                  },
                });
              } catch (error) {
                fail("fabrics", error);
              }
            })();
          },
          (kind) => kind === "matter",
        );
        return;
      }
    }
    if (group === "keys") {
      if (id === "list") {
        run("keys", "API keys", async () => pretty(await listKeys()));
        return;
      }
      if (id === "create") {
        prompt("Create API key", "Name:", "keys", (name) => {
          setScreen({
            k: "pick",
            title: "Scope",
            returnTo: "keys",
            items: [
              { id: "read", label: "read" },
              { id: "control", label: "control" },
            ],
            then: (scope) => {
              prompt(
                "Create API key",
                "Devices (space or comma separated, empty for all):",
                "keys",
                (devicesText) => {
                  run("keys", "Copy this key now; it is shown only once", async () => {
                    const created = await createKey({
                      name,
                      scope: scope as "read" | "control",
                      devices: deviceAllowlist([devicesText]),
                    });
                    return `${created.token}\n\n${pretty({ ...created, token: "[shown above]" })}`;
                  });
                },
              );
            },
          });
        });
        return;
      }
      if (id === "delete") {
        setScreen({ k: "busy" });
        void (async () => {
          try {
            const keys = await listKeys();
            if (keys.length === 0) {
              succeed("keys", "Delete", "No API keys.");
              return;
            }
            setScreen({
              k: "pick",
              title: "Delete key",
              returnTo: "keys",
              items: keys.map((key) => ({
                id: key.name,
                label: `${key.name}  ${key.scope}`,
              })),
              then: (keyName) => {
                run("keys", "Deleted", async () => {
                  await deleteKey(keyName);
                  return `Deleted key '${keyName}'.`;
                });
              },
            });
          } catch (error) {
            fail("keys", error);
          }
        })();
        return;
      }
    }
    if (group === "config") {
      if (id === "show") {
        run("config", "Config", async () => pretty(await getConfig()));
        return;
      }
      if (id === "set") {
        prompt("Set config", "Setting name:", "config", (name) => {
          prompt("Set config", "Value:", "config", (value) => {
            run("config", "Config updated", async () => {
              const current = await getConfig();
              const parsed = parseConfigValue(name, value, current);
              const updated = await putConfig({ ...current, [name]: parsed });
              const note =
                name === "logLevel"
                  ? "Log level applied to the running service."
                  : "Restart Matter Switchboard for listener or Matter-network changes to take effect.";
              return `${pretty(updated)}\n\n${note}`;
            });
          });
        });
        return;
      }
    }
    if (group === "local") {
      if (id === "init") {
        run("local", "Init", async () => {
          const result = await initConfig();
          if (result.created) {
            return [
              "Matter Switchboard initialized for the current user.",
              `Configuration: ${files.config}`,
              `Persistent data: ${path.dirname(files.state)}`,
              "Administrator credential created and saved with mode 0600.",
            ].join("\n");
          }
          const lines = ["Matter Switchboard is already initialized; existing state was kept."];
          if (result.adminToken)
            lines.push(`A replacement administrator credential was created: ${result.adminToken}`);
          return lines.join("\n");
        });
        return;
      }
      if (id === "rotate") {
        run("local", "Credential rotated", async () => {
          await rotateAdminCredential();
          return "Rotated administrator credential. Existing user API keys were not changed.";
        });
        return;
      }
    }
  };

  if (screen.k === "busy") return <Busy />;
  if (screen.k === "result") {
    return (
      <Result
        title={screen.title}
        body={screen.body}
        onBack={() => setScreen({ k: "menu", id: screen.returnTo })}
      />
    );
  }
  if (screen.k === "prompt") {
    return (
      <Prompt
        title={screen.title}
        label={screen.label}
        hidden={screen.hidden === true}
        onSubmit={screen.then}
        onCancel={() => setScreen({ k: "menu", id: screen.returnTo })}
      />
    );
  }
  if (screen.k === "pick") {
    return (
      <Menu
        title={screen.title}
        items={screen.items}
        onSelect={screen.then}
        onBack={() => setScreen({ k: "menu", id: screen.returnTo })}
      />
    );
  }
  const groupId = screen.id;
  if (groupId === "home") {
    return (
      <Menu
        title={titles.home}
        items={homeItems}
        onSelect={onHomeSelect}
        onBack={props.onBack}
        hint="arrows move   enter select   esc dashboard"
      />
    );
  }
  return (
    <Menu
      title={titles[groupId]}
      items={groupItems[groupId]}
      onSelect={(id) => onGroupSelect(groupId, id)}
      onBack={() => setScreen({ k: "menu", id: "home" })}
    />
  );
}
