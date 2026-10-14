import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

let stallingGitDirectory: string | undefined;

/**
 * PATH value whose `git` never answers (it sleeps past the 15 s guard budget), so a hook or
 * in-process evaluation observes a stalled Git probe. POSIX uses a shell script. Windows cannot spawn
 * shell scripts or `.cmd` shims without a shell, so one native stub is compiled with the running Bun;
 * System32 stays on PATH for the hook's `taskkill`.
 */
export function stallingGitPath(): string {
  if (stallingGitDirectory === undefined) {
    const directory = mkdtempSync(join(tmpdir(), "semctx-stalling-git-"));
    try {
      if (process.platform === "win32") {
        const source = join(directory, "stall.ts");
        writeFileSync(source, "await Bun.sleep(30_000);\n");
        const built = spawnSync(process.execPath, ["build", "--compile", source, "--outfile", join(directory, "git.exe")], {
          encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
        });
        if (built.status !== 0) throw new Error(`cannot compile the stalling git stub: ${built.stderr}${built.error ?? ""}`);
      } else {
        writeFileSync(join(directory, "git"), "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
      }
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    stallingGitDirectory = directory;
  }
  return process.platform === "win32"
    ? `${stallingGitDirectory}${delimiter}${join(process.env.SystemRoot ?? "C:\\Windows", "System32")}`
    : stallingGitDirectory;
}

export async function removeStallingGit(): Promise<void> {
  if (stallingGitDirectory === undefined) return;
  const directory = stallingGitDirectory;
  stallingGitDirectory = undefined;
  await removeFixture(directory);
}

/**
 * Remove a fixture directory. A killed Git or worker tree can still hold it as its working directory for
 * a moment on Windows (the stub itself exits after 30 s at the latest), so retry on a deadline instead of
 * failing the test on a cleanup race.
 */
export async function removeFixture(directory: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  for (;;) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (performance.now() >= deadline) throw error;
      await Bun.sleep(100);
    }
  }
}
