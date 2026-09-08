/** Strict `--flag value` / `--flag` parser for the governed pilot CLI. */
export function parseFlags(
  args: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) throw new Error(`unexpected positional argument: ${argument}`);
    const name = argument.slice(2);
    if (!valueFlags.includes(name) && !booleanFlags.includes(name)) {
      throw new Error(`unknown option: --${name}`);
    }
    if (result.has(name)) throw new Error(`duplicate option: --${name}`);
    if (valueFlags.includes(name)) {
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error(`--${name} requires a non-empty value`);
      }
      result.set(name, value);
      index += 1;
    } else {
      result.set(name, true);
    }
  }
  return result;
}

export function requireFlag(flags: ReadonlyMap<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string") throw new Error(`--${name} is required`);
  return value;
}

export function optionalFlag(flags: ReadonlyMap<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function hasFlag(flags: ReadonlyMap<string, string | true>, name: string): boolean {
  return flags.has(name);
}
