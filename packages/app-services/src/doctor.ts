import { isInitialized, loadConfig } from "@semantic-context/repository-store";
import { indexHealth, indexHealthStatus, type IndexHealthStatus } from "./index-health";
import { openReadyRepository } from "./readiness";

export interface WorkspaceHealthCheck {
  name: string;
  ok: boolean;
  status?: IndexHealthStatus;
  detail: string;
}

/** Read-only composition for doctor; malformed or absent evidence is an issue, never repair. */
export function workspaceHealth(root: string): { healthy: boolean; checks: WorkspaceHealthCheck[] } {
  const initialized = isInitialized(root);
  const checks: WorkspaceHealthCheck[] = [{
    name: "workspace", ok: initialized,
    detail: initialized ? ".semctx/ present" : "run 'semctx init'",
  }];
  if (!initialized) return { healthy: false, checks };
  try {
    loadConfig(root);
    checks.push({ name: "config", ok: true, detail: "config.json valid" });
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: String(error) });
    return { healthy: false, checks };
  }
  try {
    const reader = openReadyRepository(root);
    let summary: string;
    try {
      summary = `${reader.getMeta("node_count") ?? "0"} nodes, ${reader.loadClaims().length} claims `
        + `(indexed ${reader.getMeta("indexed_at") ?? "?"})`;
    } finally {
      reader.close();
    }
    const health = indexHealth(root);
    const status = indexHealthStatus(health);
    checks.push({
      name: "index", ok: status === "healthy", status,
      detail: `${summary}; binding ${health.binding.status}, freshness ${health.freshness.verdict}, `
        + `coverage ${health.coverage.status}`
        + (health.freshness.reasons.length ? `; ${health.freshness.reasons.join(", ")}` : ""),
    });
  } catch (error) {
    checks.push({ name: "index", ok: false, status: "blocked", detail: String(error) });
  }
  return { healthy: checks.every((check) => check.ok), checks };
}
