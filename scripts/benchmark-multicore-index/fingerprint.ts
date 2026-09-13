import { CONTROL_OBSERVED_HUNK_INDEX_META_KEY, UNRESOLVED_REFERENCE_INDEX_META_KEY,
  indexHealth, type RepositoryIndex } from "@semantic-context/app-services";
import { digestCanonical } from "@semantic-context/plane-a-internal";
import { openReader } from "@semantic-context/repository-store";
import { CONTROL_INDEX_SNAPSHOT_META_KEY, PLANE_A_INDEX_SNAPSHOT_META_KEY } from "../../packages/app-services/src/freshness";

/**
 * Graph and seal equality alone do not demonstrate claim, diagnostic or persisted-index
 * equivalence (ADR 0026). Each named component below independently fingerprints one of those
 * facts, split across what the run *returned* in memory and what it *persisted* to the store —
 * read back through the existing readonly store port, never by hashing database file bytes.
 */
export interface SampleFingerprint {
  seal: string;
  returnedGraph: string;
  returnedClaims: string;
  returnedDiagnostic: string;
  returnedEvidence: string;
  persistedGraph: string;
  persistedClaims: string;
  persistedEvidence: string;
  persistedIndexHealth: string;
  persistedMetadata: string;
}

export const FINGERPRINT_COMPONENTS = [
  "seal",
  "returnedGraph",
  "returnedClaims",
  "returnedDiagnostic",
  "returnedEvidence",
  "persistedGraph",
  "persistedClaims",
  "persistedEvidence",
  "persistedIndexHealth",
  "persistedMetadata",
] as const satisfies readonly (keyof SampleFingerprint)[];

export type FingerprintComponent = (typeof FINGERPRINT_COMPONENTS)[number];

const FINGERPRINT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * A fingerprint missing or malformed in one sample can equal an identically missing/malformed
 * fingerprint in another sample; that coincidence must never be read as proven equivalence
 * (ADR 0026). Reject before comparing instead of letting `undefined === undefined` pass silently.
 */
function assertCompleteFingerprint(fingerprint: SampleFingerprint, label: string): void {
  for (const component of FINGERPRINT_COMPONENTS) {
    const value = fingerprint[component];
    if (typeof value !== "string" || !FINGERPRINT_DIGEST_PATTERN.test(value)) {
      throw new Error(
        `${label}: fingerprint component "${component}" is missing or malformed (received ${JSON.stringify(value)})`,
      );
    }
  }
}

export function buildReturnedFingerprintComponents(
  index: RepositoryIndex,
): Pick<SampleFingerprint, "seal" | "returnedGraph" | "returnedClaims" | "returnedDiagnostic" | "returnedEvidence"> {
  return {
    seal: index.freshnessSeal.sealHash,
    returnedGraph: digestCanonical(index.analysis.graph),
    returnedClaims: digestCanonical(index.claims),
    returnedDiagnostic: digestCanonical(index.analysis.unresolvedReferences),
    returnedEvidence: digestCanonical(index.analysis.evidence),
  };
}

/** Exact logical metadata written by indexRepository/replaceIndex; physical SQLite bytes are excluded. */
const STRUCTURED_METADATA_KEYS = [
  PLANE_A_INDEX_SNAPSHOT_META_KEY,
  UNRESOLVED_REFERENCE_INDEX_META_KEY,
  CONTROL_OBSERVED_HUNK_INDEX_META_KEY,
  CONTROL_INDEX_SNAPSHOT_META_KEY,
] as const;
const SCALAR_METADATA_KEYS = [
  "schema_version", "node_count", "edge_count", "indexed_at", "indexed_commit", "indexed_repository_graph_hash",
] as const;

/** Health validates bindings; exact metadata separately catches differences lost by that projection. */
export function buildPersistedFingerprintComponents(
  repositoryRoot: string,
): Pick<SampleFingerprint, "persistedGraph" | "persistedClaims" | "persistedEvidence" | "persistedIndexHealth" | "persistedMetadata"> {
  const reader = openReader(repositoryRoot);
  try {
    const requiredMeta = (key: string): string => {
      const value = reader.getMeta(key);
      if (value === undefined) throw new Error(`persisted index metadata is missing: ${key}`);
      return value;
    };
    const metadata = {
      ...Object.fromEntries(STRUCTURED_METADATA_KEYS.map((key) => [key, JSON.parse(requiredMeta(key)) as unknown])),
      ...Object.fromEntries(SCALAR_METADATA_KEYS.map((key) => [key, requiredMeta(key)])),
    };
    return {
      persistedGraph: digestCanonical(reader.loadGraph()),
      persistedClaims: digestCanonical(reader.loadClaims()),
      persistedEvidence: digestCanonical(reader.loadEvidence()),
      persistedIndexHealth: digestCanonical(indexHealth(repositoryRoot)),
      persistedMetadata: digestCanonical(metadata),
    };
  } finally {
    reader.close();
  }
}

export function findFirstDivergence(
  baseline: SampleFingerprint,
  candidate: SampleFingerprint,
): FingerprintComponent | null {
  assertCompleteFingerprint(baseline, "baseline");
  assertCompleteFingerprint(candidate, "candidate");
  for (const component of FINGERPRINT_COMPONENTS) {
    if (baseline[component] !== candidate[component]) return component;
  }
  return null;
}

export type FingerprintComparison =
  | { equivalent: true }
  | { equivalent: false; divergentSampleIndex: number; component: FingerprintComponent };

/**
 * Compares every sample against the first: a single equivalence class is claimed per corpus.
 * An empty sample set proves nothing and is rejected rather than reported as trivially equivalent.
 */
export function compareFingerprints(samples: readonly SampleFingerprint[]): FingerprintComparison {
  if (samples.length === 0) {
    throw new Error("compareFingerprints requires at least one sample; an empty set cannot prove equivalence");
  }
  const baseline = samples[0]!;
  assertCompleteFingerprint(baseline, "sample 0");
  for (let index = 1; index < samples.length; index += 1) {
    const component = findFirstDivergence(baseline, samples[index]!);
    if (component !== null) return { equivalent: false, divergentSampleIndex: index, component };
  }
  return { equivalent: true };
}
