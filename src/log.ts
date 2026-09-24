import { Environment, Logger } from "@matter/general";
import type { LogLevelName } from "./config.js";

export const switchboardLog = Logger.get("Switchboard");

export function applyLogLevel(level: LogLevelName): void {
  Environment.default.vars.set("log.level", level);
  Logger.level = level;
}
