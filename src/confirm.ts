/** Use a supplied positional, prompt for it on a terminal, or fail when there is no terminal. */
export async function requiredArgument(input: {
  provided: string | undefined;
  isTTY: boolean;
  name: string;
  read: () => Promise<string>;
}): Promise<string> {
  const provided = input.provided?.trim();
  if (provided) return provided;
  if (!input.isTTY) throw new Error(`Missing required argument '${input.name}'`);
  const entered = (await input.read()).trim();
  if (!entered) throw new Error(`Missing required argument '${input.name}'`);
  return entered;
}

/** Text the operator must retype before a fabric is removed. */
export function fabricRemovalConfirmation(fabric: { fabricIndex: number; label: string }): string {
  return fabric.label.length > 0 ? fabric.label : String(fabric.fabricIndex);
}

/** Prompt for a secret or destructive confirmation, or accept it from a flag. */
export async function confirmedValue(input: {
  provided: string | undefined;
  isTTY: boolean;
  flag: string;
  expected?: string;
  mismatch: string;
  read: () => Promise<string>;
}): Promise<string> {
  const entered =
    input.provided === undefined ? await readInteractive(input) : input.provided.trim();
  if (input.expected !== undefined) {
    if (entered !== input.expected) throw new Error(input.mismatch);
  } else if (!entered) {
    throw new Error(input.mismatch);
  }
  return entered;
}

async function readInteractive(input: {
  isTTY: boolean;
  flag: string;
  read: () => Promise<string>;
}): Promise<string> {
  if (!input.isTTY) {
    throw new Error(`Non-interactive use requires ${input.flag}`);
  }
  return (await input.read()).trim();
}
