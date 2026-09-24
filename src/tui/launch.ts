export function shouldLaunchTui(argv: string[], isTTY: boolean): boolean {
  const args = argv.slice(2);
  if (args.length === 0) return isTTY;
  return args.length === 1 && args[0] === "tui";
}
