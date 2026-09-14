/** Tiny, dependency-free argument parser. No heavy CLI framework (by design). */

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
  /**
   * Flag names given more than once, sorted; present only when there is at least one. The shared
   * policy stays last-value-wins in `flags`: a command for which that is ambiguity refuses these.
   */
  duplicateFlags?: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  const duplicates = new Set<string>();
  const setFlag = (name: string, value: string | boolean): void => {
    if (flags.has(name)) duplicates.add(name);
    flags.set(name, value);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        setFlag(body.slice(0, eq), body.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          setFlag(body, next);
          i += 1;
        } else {
          setFlag(body, true);
        }
      }
    } else if (token.startsWith("-") && token.length > 1) {
      setFlag(token.slice(1), true);
    } else {
      positionals.push(token);
    }
  }

  return duplicates.size > 0 ? { positionals, flags, duplicateFlags: [...duplicates].sort() } : { positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === "true";
}
