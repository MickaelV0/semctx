import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseArgs } from "../src/args";
import {
  executeInstall,
  type CommandResult,
  type InstallRuntime,
  type SetupExecution,
} from "../src/commands/install";

const SEMCTX_SOURCE = "https://github.com/hoklims/semctx.git";

interface FakeOptions {
  codex?: boolean;
  claude?: boolean;
  git?: boolean;
  codexMarketplaces?: unknown;
  codexPlugins?: unknown;
  codexPluginsAfter?: unknown;
  claudeMarketplaces?: unknown;
  claudePlugins?: unknown;
  claudePluginsAfter?: unknown;
  gitRoot?: string;
  failCommand?: string;
  failError?: string;
  deferFailure?: string;
  setup?: SetupExecution;
}

function fakeRuntime(
  options: FakeOptions = {},
): InstallRuntime & {
  commands: string[][];
  deferredCodexCleanups: string[][];
  setupRoots: string[];
} {
  const commands: string[][] = [];
  const deferredCodexCleanups: string[][] = [];
  const setupRoots: string[] = [];
  let codexPluginReads = 0;
  let claudePluginReads = 0;
  const ok = (out = ""): CommandResult => ({ code: 0, out, err: "" });
  const missing = (name: string): CommandResult => ({
    code: 1,
    out: "",
    err: `${name} not found`,
  });

  return {
    commands,
    run(command, _cwd) {
      const argv = [...command];
      commands.push(argv);
      const [program, ...args] = argv;

      if (program === "codex" && args[0] === "--version") {
        return options.codex === false ? missing("codex") : ok("codex-cli 0.144.6\n");
      }
      if (program === "claude" && args[0] === "--version") {
        return options.claude === true ? ok("2.1.220\n") : missing("claude");
      }
      if (program === "git" && args[0] === "rev-parse") {
        return options.git === false
          ? missing("git repository")
          : ok(`${options.gitRoot ?? "C:\\work\\project"}\n`);
      }
      if (argv.join(" ") === "codex plugin marketplace list --json") {
        return ok(JSON.stringify(options.codexMarketplaces ?? { marketplaces: [] }));
      }
      if (argv.join(" ") === "codex plugin list --json") {
        codexPluginReads += 1;
        const state = codexPluginReads === 1
          ? options.codexPlugins ?? { installed: [], available: [] }
          : options.codexPluginsAfter ?? {
            installed: [{
              pluginId: "semctx-control@semctx-stable",
              installed: true,
              enabled: true,
              version: "0.1.16",
            }],
            available: [],
          };
        return ok(JSON.stringify(state));
      }
      if (argv.join(" ") === "claude plugin marketplace list --json") {
        return ok(JSON.stringify(options.claudeMarketplaces ?? []));
      }
      if (argv.join(" ") === "claude plugin list --json") {
        claudePluginReads += 1;
        const state = claudePluginReads === 1
          ? options.claudePlugins ?? []
          : options.claudePluginsAfter ?? [{
            id: "semctx@semctx-stable",
            scope: "user",
            enabled: true,
            version: "0.1.16",
          }];
        return ok(JSON.stringify(state));
      }
      if (argv.join(" ") === options.failCommand) {
        return { code: 1, out: "", err: options.failError ?? "injected command failure" };
      }
      return ok("{}\n");
    },
    setup(root, dryRun) {
      if (dryRun) throw new Error("dry-run must not invoke setup");
      setupRoots.push(root);
      return options.setup ?? {
        code: 0,
        report: { check: { ok: true }, nodes: 12, claims: 4 },
        err: "",
      };
    },
    deferCodexCleanup(marketplaceNames) {
      deferredCodexCleanups.push([...marketplaceNames]);
      return options.deferFailure === undefined
        ? ok('{"pid":1234}\n')
        : { code: 1, out: "", err: options.deferFailure };
    },
    deferredCodexCleanups,
    setupRoots,
  };
}

describe("semctx install — no-brain host + repository bootstrap", () => {
  test("installs the Codex marketplace and plugin, then prepares the current repository", () => {
    const runtime = fakeRuntime({ codex: true, claude: false });
    const report = executeInstall("C:\\work\\project", parseArgs(["install"]), runtime);

    expect(report.ok).toBe(true);
    expect(report.hosts.codex.status).toBe("installed");
    expect(report.hosts.claude.status).toBe("not-detected");
    expect(report.workspace.status).toBe("ready");
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "add",
      "hoklims/semctx",
      "--ref",
      "stable",
      "--json",
    ]);
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "add",
      "semctx-control@semctx-stable",
      "--json",
    ]);
  });

  test("updates an existing Codex installation and reloads the plugin registration", () => {
    const runtime = fakeRuntime({
      codex: true,
      codexMarketplaces: {
        marketplaces: [
          {
            name: "semctx-stable",
            marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
          },
        ],
      },
      codexPlugins: {
        installed: [{ pluginId: "semctx-control@semctx-stable", installed: true, version: "0.1.10" }],
      },
    });
    const report = executeInstall("C:\\work\\project", parseArgs(["install"]), runtime);

    expect(report.ok).toBe(true);
    expect(report.hosts.codex.status).toBe("updated");
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "upgrade",
      "semctx-stable",
      "--json",
    ]);
    expect(runtime.commands).not.toContainEqual([
      "codex",
      "plugin",
      "remove",
      "semctx-control@semctx-stable",
      "--json",
    ]);
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "add",
      "semctx-control@semctx-stable",
      "--json",
    ]);
  });

  test("migrates the legacy Codex marketplace name from personal to semctx-stable", () => {
    const runtime = fakeRuntime({
      codex: true,
      codexMarketplaces: {
        marketplaces: [
          {
            name: "personal",
            marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
          },
        ],
      },
      codexPlugins: {
        installed: [{ pluginId: "semctx-control@personal", installed: true, version: "0.1.10" }],
      },
    });
    const report = executeInstall("C:\\work\\project", parseArgs(["install"]), runtime);

    expect(report.ok).toBe(true);
    expect(report.hosts.codex.status).toBe("migrated");
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "remove",
      "semctx-control@personal",
      "--json",
    ]);
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "remove",
      "personal",
      "--json",
    ]);
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "add",
      "semctx-control@semctx-stable",
      "--json",
    ]);
    const installNew = runtime.commands.findIndex(
      (command) => command.join(" ") === "codex plugin add semctx-control@semctx-stable --json",
    );
    const removeLegacy = runtime.commands.findIndex(
      (command) => command.join(" ") === "codex plugin remove semctx-control@personal --json",
    );
    expect(installNew).toBeGreaterThanOrEqual(0);
    expect(removeLegacy).toBeGreaterThan(installNew);
  });

  test("finishes a partial Codex migration when legacy and stable registrations both exist", () => {
    const runtime = fakeRuntime({
      codex: true,
      codexMarketplaces: {
        marketplaces: [
          {
            name: "semctx",
            marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
          },
          {
            name: "semctx-stable",
            marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
          },
        ],
      },
      codexPlugins: {
        installed: [
          {
            pluginId: "semctx-control@semctx",
            installed: true,
            enabled: true,
            version: "0.1.10",
          },
          {
            pluginId: "semctx-control@semctx-stable",
            installed: true,
            enabled: true,
            version: "0.1.10",
          },
        ],
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.hosts.codex.status).toBe("migrated");
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "upgrade",
      "semctx-stable",
      "--json",
    ]);
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "remove",
      "semctx-control@semctx",
      "--json",
    ]);
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "remove",
      "semctx",
      "--json",
    ]);
  });

  test("does not remove a legacy Codex marketplace while another installed plugin still uses it", () => {
    const runtime = fakeRuntime({
      codex: true,
      codexMarketplaces: {
        marketplaces: [
          {
            name: "personal",
            marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
          },
        ],
      },
      codexPlugins: {
        installed: [
          { pluginId: "semctx-control@personal", installed: true, version: "0.1.10" },
          { pluginId: "another-plugin@personal", installed: true, version: "1.0.0" },
        ],
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("conflict");
    expect(report.hosts.codex.error).toContain("another-plugin@personal");
    expect(runtime.commands.some((command) => command.includes("remove"))).toBe(false);
  });

  test("keeps the working legacy Codex plugin when replacement installation fails", () => {
    const runtime = fakeRuntime({
      codex: true,
      codexMarketplaces: {
        marketplaces: [{
          name: "personal",
          marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
        }],
      },
      codexPlugins: {
        installed: [{
          pluginId: "semctx-control@personal",
          installed: true,
          enabled: true,
          version: "0.1.10",
        }],
      },
      failCommand: "codex plugin add semctx-control@semctx-stable --json",
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("failed");
    expect(runtime.commands).not.toContainEqual([
      "codex",
      "plugin",
      "remove",
      "semctx-control@personal",
      "--json",
    ]);
    expect(runtime.commands).not.toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "remove",
      "personal",
      "--json",
    ]);
  });

  test("defers a locked legacy Codex cleanup after the replacement verifies", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      codexMarketplaces: {
        marketplaces: [{
          name: "personal",
          marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
        }],
      },
      codexPlugins: {
        installed: [{
          pluginId: "semctx-control@personal",
          installed: true,
          enabled: true,
          version: "0.1.10",
        }],
      },
      failCommand: "codex plugin remove semctx-control@personal --json",
      failError:
        "failed to remove existing plugin cache entry: file is used by another process (os error 32)",
    });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.hosts.codex.status).toBe("migrated");
    expect(report.hosts.codex.restartRequired).toBe(true);
    expect(report.hosts.codex.steps).toContainEqual(expect.objectContaining({
      action: "remove legacy Codex plugin",
      status: "deferred",
    }));
    expect(runtime.deferredCodexCleanups).toEqual([["personal"]]);
    expect(runtime.commands).not.toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "remove",
      "personal",
      "--json",
    ]);
  });

  test("keeps unexpected legacy cleanup failures blocking", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      codexMarketplaces: {
        marketplaces: [{
          name: "personal",
          marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
        }],
      },
      codexPlugins: {
        installed: [{
          pluginId: "semctx-control@personal",
          installed: true,
          enabled: true,
          version: "0.1.10",
        }],
      },
      failCommand: "codex plugin remove semctx-control@personal --json",
      failError: "permission denied",
    });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("failed");
    expect(runtime.deferredCodexCleanups).toEqual([]);
  });

  test("fails honestly when locked cleanup cannot be deferred", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      codexMarketplaces: {
        marketplaces: [{
          name: "personal",
          marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
        }],
      },
      codexPlugins: {
        installed: [{
          pluginId: "semctx-control@personal",
          installed: true,
          enabled: true,
          version: "0.1.10",
        }],
      },
      failCommand: "codex plugin remove semctx-control@personal --json",
      failError:
        "failed to remove existing plugin cache entry: file is used by another process (os error 32)",
      deferFailure: "cannot start background cleanup",
    });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("failed");
    expect(report.hosts.codex.error).toContain("cannot start background cleanup");
    expect(runtime.deferredCodexCleanups).toEqual([["personal"]]);
  });

  test("installs or updates Claude Code at user scope", () => {
    const fresh = fakeRuntime({ codex: false, claude: true });
    const freshReport = executeInstall("C:\\work\\project", parseArgs(["install"]), fresh);
    expect(freshReport.hosts.claude.status).toBe("installed");
    expect(fresh.commands).toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "add",
      "hoklims/semctx@stable",
      "--scope",
      "user",
    ]);
    expect(fresh.commands).toContainEqual([
      "claude",
      "plugin",
      "install",
      "semctx@semctx-stable",
      "--scope",
      "user",
    ]);

    const existing = fakeRuntime({
      codex: false,
      claude: true,
      claudeMarketplaces: [{ name: "semctx-stable", source: "github", repo: "hoklims/semctx" }],
      claudePlugins: [{ id: "semctx@semctx-stable", scope: "user", enabled: true, version: "0.1.10" }],
    });
    const existingReport = executeInstall("C:\\work\\project", parseArgs(["install"]), existing);
    expect(existingReport.hosts.claude.status).toBe("updated");
    expect(existing.commands).toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "update",
      "semctx-stable",
    ]);
    expect(existing.commands).toContainEqual([
      "claude",
      "plugin",
      "update",
      "semctx@semctx-stable",
      "--scope",
      "user",
    ]);
  });

  test("migrates Claude from the old marketplace only after the stable plugin verifies", () => {
    const runtime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMarketplaces: [{ name: "semctx", source: "github", repo: "hoklims/semctx" }],
      claudePlugins: [{
        id: "semctx@semctx",
        scope: "user",
        enabled: true,
        version: "0.1.10",
      }],
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.hosts.claude.status).toBe("migrated");
    const installStable = runtime.commands.findIndex(
      (command) => command.join(" ")
        === "claude plugin install semctx@semctx-stable --scope user",
    );
    const verifyStable = runtime.commands.findIndex(
      (command, index) => index > installStable
        && command.join(" ") === "claude plugin list --json",
    );
    const removeLegacy = runtime.commands.findIndex(
      (command) => command.join(" ")
        === "claude plugin marketplace remove semctx --scope user",
    );
    expect(installStable).toBeGreaterThanOrEqual(0);
    expect(verifyStable).toBeGreaterThan(installStable);
    expect(removeLegacy).toBeGreaterThan(verifyStable);
  });

  test("finishes a partial Claude migration when legacy and stable registrations both exist", () => {
    const runtime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMarketplaces: [
        { name: "semctx", source: "github", repo: "hoklims/semctx" },
        { name: "semctx-stable", source: "github", repo: "hoklims/semctx" },
      ],
      claudePlugins: [
        {
          id: "semctx@semctx",
          scope: "user",
          enabled: true,
          version: "0.1.10",
        },
        {
          id: "semctx@semctx-stable",
          scope: "user",
          enabled: true,
          version: "0.1.10",
        },
      ],
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.hosts.claude.status).toBe("migrated");
    expect(runtime.commands).toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "update",
      "semctx-stable",
    ]);
    expect(runtime.commands).toContainEqual([
      "claude",
      "plugin",
      "update",
      "semctx@semctx-stable",
      "--scope",
      "user",
    ]);
    expect(runtime.commands).toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "remove",
      "semctx",
      "--scope",
      "user",
    ]);
  });

  test("never removes a Claude marketplace declaration outside user scope", () => {
    const runtime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMarketplaces: [
        { name: "semctx", source: "github", repo: "hoklims/semctx" },
        { name: "semctx-stable", source: "github", repo: "hoklims/semctx" },
      ],
      claudePlugins: [
        {
          id: "semctx@semctx",
          scope: "project",
          enabled: true,
          version: "0.1.10",
        },
        {
          id: "semctx@semctx-stable",
          scope: "user",
          enabled: true,
          version: "0.1.10",
        },
      ],
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(runtime.commands).toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "remove",
      "semctx",
      "--scope",
      "user",
    ]);
    expect(runtime.commands).not.toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "remove",
      "semctx",
    ]);
    expect(runtime.commands.some(
      (command) => command[0] === "claude"
        && command[1] === "plugin"
        && command[2] === "uninstall",
    )).toBe(false);
  });

  test("re-enables an installed Claude plugin instead of leaving a successful-looking dead state", () => {
    const runtime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMarketplaces: [{ name: "semctx-stable", source: "github", repo: "hoklims/semctx" }],
      claudePlugins: [{ id: "semctx@semctx-stable", scope: "user", enabled: false, version: "0.1.10" }],
    });
    const report = executeInstall("C:\\work\\project", parseArgs(["install"]), runtime);

    expect(report.ok).toBe(true);
    expect(runtime.commands).toContainEqual([
      "claude",
      "plugin",
      "enable",
      "semctx@semctx-stable",
      "--scope",
      "user",
    ]);
  });

  test("fails closed when Codex still exposes an old plugin version after a successful command", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      codexPluginsAfter: {
        installed: [{
          pluginId: "semctx-control@semctx-stable",
          installed: true,
          enabled: true,
          version: "0.1.10",
        }],
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("failed");
    expect(report.hosts.codex.error).toContain("expected plugin v0.1.16");
  });

  test("fails closed when Claude remains disabled after the enable command succeeds", () => {
    const runtime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMarketplaces: [{ name: "semctx-stable", source: "github", repo: "hoklims/semctx" }],
      claudePlugins: [{
        id: "semctx@semctx-stable",
        scope: "user",
        enabled: false,
        version: "0.1.10",
      }],
      claudePluginsAfter: [{
        id: "semctx@semctx-stable",
        scope: "user",
        enabled: false,
        version: "0.1.16",
      }],
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.claude.status).toBe("failed");
    expect(report.hosts.claude.error).toContain("not enabled");
  });

  test("dry-run probes state but performs no mutation or repository setup", () => {
    const runtime = fakeRuntime({ codex: true, claude: true });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--dry-run"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(report.workspace.status).toBe("planned");
    expect(runtime.commands.some((command) => command.includes("add"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("install"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("update"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("upgrade"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("remove"))).toBe(false);
  });

  test("does not write workspace state when invoked outside a Git repository", () => {
    const runtime = fakeRuntime({ codex: true, git: false });
    const report = executeInstall("C:\\Users\\Ada", parseArgs(["install"]), runtime);

    expect(report.ok).toBe(true);
    expect(report.workspace.status).toBe("not-a-repository");
    expect(report.workspace.next).toContain("semctx setup");
  });

  test("prepares the repository root when invoked from a nested directory", () => {
    const runtime = fakeRuntime({
      codex: true,
      gitRoot: "C:\\work\\project",
    });
    const report = executeInstall(
      "C:\\work\\project\\packages\\api",
      parseArgs(["install"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.workspace.root).toBe("C:\\work\\project");
    expect(runtime.setupRoots).toEqual(["C:\\work\\project"]);
  });

  test("fails honestly when an explicitly requested host is unavailable", () => {
    const runtime = fakeRuntime({ codex: false, claude: false });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--host", "codex", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("missing");
    expect(report.hosts.claude.status).toBe("not-requested");
  });

  test("refuses to overwrite an unrelated Codex marketplace named semctx-stable", () => {
    const runtime = fakeRuntime({
      codex: true,
      codexMarketplaces: {
        marketplaces: [
          {
            name: "semctx-stable",
            marketplaceSource: {
              sourceType: "git",
              source: "https://github.com/someone-else/semctx.git",
            },
          },
        ],
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("conflict");
    expect(report.next.join(" ")).toContain("marketplace");
    expect(runtime.commands.some((command) => command.includes("remove"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("add"))).toBe(false);
  });

  test("keeps --json machine-readable for invalid installer input", () => {
    const entrypoint = resolve(import.meta.dir, "../src/index.ts");
    const process = Bun.spawnSync(
      ["bun", entrypoint, "install", "--host", "nope", "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = new TextDecoder().decode(process.stdout);

    expect(process.exitCode).toBe(1);
    expect(new TextDecoder().decode(process.stderr)).toBe("");
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      version: "0.1.16",
      error: { code: "INVALID_TASK_INPUT" },
    });
  });

  test("rejects a valueless --host instead of silently falling back to auto", () => {
    const entrypoint = resolve(import.meta.dir, "../src/index.ts");
    const process = Bun.spawnSync(
      ["bun", entrypoint, "install", "--host", "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = new TextDecoder().decode(process.stdout);

    expect(process.exitCode).toBe(1);
    expect(new TextDecoder().decode(process.stderr)).toBe("");
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      version: "0.1.16",
      error: {
        code: "INVALID_TASK_INPUT",
        message: "--host requires auto|codex|claude|all",
      },
    });
  });
});
