/**
 * Shared writer for the explicit `--output`/export path of local reports (feedback aggregate,
 * support diagnostics). Default preview writes nothing; this only runs when the user opts in.
 * Refuses an existing destination or a symlink instead of overwriting it: `wx` makes file creation
 * atomic (no check-then-write race), and POSIX/Windows both fail `O_CREAT|O_EXCL` with `EEXIST`
 * when the path already names a symlink, so a dangling symlink is refused rather than followed.
 */
import { lstatSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SemctxError } from "@semantic-context/core";

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function writeNewLocalReportFile(path: string, content: string): void {
  for (let current = resolve(path);; current = dirname(current)) {
    if (isSymlink(current)) throw new SemctxError("IO_ERROR", `refusing to write through an existing symlink: ${current}`, { path });
    if (current === dirname(current)) break;
  }
  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SemctxError("IO_ERROR", `refusing to overwrite an existing file: ${path}`, { path });
    }
    throw error;
  }
}
