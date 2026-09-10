/**
 * Read-only prerequisite inspection (ADR 0022 "inspect").
 *
 * Every function here is pure: it turns an already-gathered observation into a diagnosis. The
 * gathering itself (probing `PATH`, spawning `--version`, reading manifests) lives in
 * `scripts/contributor.ts`, which is the only place real environment access happens. Keeping the
 * split lets every absent/incompatible/missing case be a deterministic unit test instead of a
 * live probe of the machine running the suite.
 *
 * Bun's own presence is deliberately never a status this module can report: a Bun helper cannot
 * run at all without Bun already on `PATH`. That bootstrap requirement is documented in
 * docs/contributing/first-check.md, not diagnosed here — self-diagnosis without a runtime is not
 * a thing a Bun script can honestly claim.
 */

export type PrerequisiteStatus = "ok" | "absent" | "incompatible" | "unknown";

export interface PrerequisiteResult {
  readonly id: string;
  readonly label: string;
  readonly status: PrerequisiteStatus;
  /** What the product/tooling requires, stated exactly (a range, a pin, or a plain description). */
  readonly required: string;
  /** What was actually observed, or `null` when nothing could be observed. */
  readonly observed: string | null;
  readonly detail: string;
  /** The exact existing recovery command, or `null` when the prerequisite is already satisfied. */
  readonly recovery: string | null;
}

// --- Version comparison ---------------------------------------------------------------------

/** Parses only the one range shape every `engines.bun` field in this repository actually uses. */
export function parseBunEngineRange(range: string): { version: string } | undefined {
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
  return match === null ? undefined : { version: match[1]! };
}

/** Three-part numeric compare. Negative/zero/positive, like `Array.prototype.sort`'s comparator. */
export function compareSemver(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// --- Bun (product requirement) ------------------------------------------------------------------

export interface BunObservation {
  /** `Bun.version` of the interpreter that is executing this very script. */
  readonly version: string;
  /** `apps/cli/package.json`'s `engines.bun`, the product's own declared minimum. */
  readonly requiredRange: string;
}

export function evaluateBunRuntime(observation: BunObservation): PrerequisiteResult {
  const id = "bun";
  const label = "Bun runtime (product requirement)";
  const range = parseBunEngineRange(observation.requiredRange);
  if (range === undefined) {
    return {
      id,
      label,
      status: "unknown",
      required: observation.requiredRange,
      observed: observation.version,
      detail: "apps/cli/package.json engines.bun is not a recognised '>=x.y.z' pin; cannot compare.",
      recovery: null,
    };
  }
  const observedVersion = /^\d+\.\d+\.\d+/.exec(observation.version)?.[0];
  if (observedVersion === undefined) {
    return {
      id,
      label,
      status: "unknown",
      required: observation.requiredRange,
      observed: observation.version,
      detail: "the running Bun did not report a parseable semantic version.",
      recovery: null,
    };
  }
  const ok = compareSemver(observedVersion, range.version) >= 0;
  return {
    id,
    label,
    status: ok ? "ok" : "incompatible",
    required: observation.requiredRange,
    observed: observation.version,
    detail: ok
      ? "the running Bun meets semctx's minimum."
      : `semctx requires Bun ${observation.requiredRange}; the running Bun is older.`,
    recovery: ok ? null : "install a newer Bun (https://bun.sh, or your version manager), then re-run this script.",
  };
}

// --- JS workspace dependencies (bun install state) -----------------------------------------------

export interface JsDependencyObservation {
  readonly nodeModulesPresent: boolean;
  /** Representative packages `verify:pr`'s quality step actually depends on. */
  readonly checkedPackages: readonly string[];
  readonly missingPackages: readonly string[];
  readonly versions?: Readonly<Record<string, string>>;
}

export function evaluateJsDependencies(observation: JsDependencyObservation): PrerequisiteResult {
  const id = "js-dependencies";
  const label = "JS workspace dependencies";
  const required = `readable installed package manifests (checked: ${observation.checkedPackages.join(", ")})`;
  if (!observation.nodeModulesPresent) {
    return {
      id,
      label,
      status: "absent",
      required,
      observed: "no root node_modules directory",
      detail: "workspace dependencies were never installed.",
      recovery: "bun install --frozen-lockfile",
    };
  }
  if (observation.missingPackages.length > 0) {
    return {
      id,
      label,
      status: "incompatible",
      required,
      observed: `missing: ${observation.missingPackages.join(", ")}`,
      detail: "node_modules exists but is incomplete or stale.",
      recovery: "bun install --frozen-lockfile",
    };
  }
  return {
    id,
    label,
    status: "ok",
    required,
    observed: JSON.stringify(observation.versions ?? {}),
    detail: "Representative packages are present. This does not prove the complete install matches bun.lock; use bun install --frozen-lockfile.",
    recovery: null,
  };
}

// --- Contributor-only Python quality tools (requirements-quality.txt) ---------------------------

/** Pure parse of `requirements-quality.txt`'s `name==version` pins, lower-cased by name. */
export function parseRequirementsQualityPins(text: string): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+)==([0-9][0-9A-Za-z.+-]*)\s*$/.exec(line.trim());
    if (match !== null) pins[match[1]!.toLowerCase()] = match[2]!;
  }
  return pins;
}

export interface PythonToolObservation {
  readonly id: string;
  readonly label: string;
  readonly requiredVersion: string;
  /** Resolved absolute path, or `null` when the tool is not on `PATH`. */
  readonly which: string | null;
  /** Whether the `--version` child process itself completed (independent of what it printed). */
  readonly queryOk: boolean;
  /** Raw combined stdout+stderr of `--version`, kept verbatim for the diagnostic. */
  readonly rawVersion: string | null;
}

const PYTHON_QUALITY_RECOVERY = "python -m pip install --requirement requirements-quality.txt";

export function evaluatePythonTool(observation: PythonToolObservation): PrerequisiteResult {
  const base = { id: observation.id, label: observation.label, required: `${observation.id}==${observation.requiredVersion}` };
  if (observation.which === null) {
    return {
      ...base,
      status: "absent",
      observed: null,
      detail: `${observation.label} was not found on PATH.`,
      recovery: PYTHON_QUALITY_RECOVERY,
    };
  }
  if (!observation.queryOk) {
    return {
      ...base,
      status: "unknown",
      observed: observation.which,
      detail: `${observation.label} did not answer --version.`,
      recovery: PYTHON_QUALITY_RECOVERY,
    };
  }
  const observedVersion = observation.rawVersion === null ? undefined : /\d+\.\d+\.\d+/.exec(observation.rawVersion)?.[0];
  if (observedVersion === undefined) {
    return {
      ...base,
      status: "unknown",
      observed: observation.rawVersion,
      detail: `${observation.label} printed no recognisable version.`,
      recovery: PYTHON_QUALITY_RECOVERY,
    };
  }
  if (observedVersion !== observation.requiredVersion) {
    return {
      ...base,
      status: "incompatible",
      observed: observedVersion,
      detail: `requirements-quality.txt pins ${observation.requiredVersion}; found ${observedVersion}.`,
      recovery: PYTHON_QUALITY_RECOVERY,
    };
  }
  return {
    ...base,
    status: "ok",
    observed: observedVersion,
    detail: "matches the pinned version in requirements-quality.txt.",
    recovery: null,
  };
}

// --- Python interpreter (needed by verify:pr's own steps, not version-pinned) --------------------

export interface PythonInterpreterObservation {
  readonly which: string | null;
  readonly queryOk: boolean;
  readonly rawVersion: string | null;
}

export function evaluatePythonInterpreter(observation: PythonInterpreterObservation): PrerequisiteResult {
  const id = "python-interpreter";
  const label = "Python interpreter (verify:pr's compileall/smoke steps)";
  const required = "a `python` executable on PATH";
  if (observation.which === null) {
    return {
      id,
      label,
      status: "absent",
      required,
      observed: null,
      detail: "verify:pr runs `python -m compileall` and a benchmark smoke test; neither can run without one.",
      recovery: "install Python 3 and ensure `python` resolves on PATH",
    };
  }
  if (!observation.queryOk || !/^Python 3\.\d+\.\d+/.test(observation.rawVersion?.trim() ?? "")) return {
    id, label, status: "unknown", required, observed: observation.rawVersion,
    detail: "python resolved but did not report a working Python 3 interpreter.", recovery: "ensure python --version succeeds with Python 3",
  };
  return {
    id,
    label,
    status: "ok",
    required,
    observed: observation.rawVersion?.trim() ?? null,
    detail: "python --version completed successfully.",
    recovery: null,
  };
}
