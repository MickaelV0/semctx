import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  evaluateAgentLifecycleCheckpointV1,
  type AgentLifecycleCheckpointRequestV1,
  type AgentLifecycleReportV1,
  type AgentLifecycleRepositoryStateV1,
} from "@semantic-context/control-model";
import { isSemctxError, SemctxError } from "@semantic-context/core";
import {
  configPath,
  loadConfig,
} from "@semantic-context/repository-store";
import { openReadyRepository } from "./readiness";

function canonicalDirectory(root: string): string {
  if (!isAbsolute(root)) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "repository root must be absolute",
      { root },
    );
  }

  const canonical = realpathSync.native(root);
  if (!lstatSync(canonical).isDirectory()) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "repository root must be a directory",
      { root },
    );
  }
  return canonical;
}

function pathKind(path: string): "directory" | "other" | "missing" {
  try {
    return lstatSync(path).isDirectory() ? "directory" : "other";
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return "missing";
    }
    throw error;
  }
}

function repositoryState(root: string): AgentLifecycleRepositoryStateV1 {
  const configuration = pathKind(configPath(root));
  const semanticDirectory = pathKind(join(root, ".semctx", "semantic"));
  if (configuration === "missing" && semanticDirectory !== "directory") {
    return "non_semctx";
  }

  try {
    if (configuration !== "missing") loadConfig(root);
    const reader = openReadyRepository(root);
    reader.close();
    return "semctx_ready";
  } catch (error) {
    if (
      isSemctxError(error)
      && (error.code === "CONFIG_NOT_FOUND" || error.code === "REPO_NOT_INDEXED")
    ) {
      return "semctx_unready";
    }
    throw error;
  }
}

/**
 * Evaluate an advisory lifecycle checkpoint against repository-derived Semctx readiness.
 * This query reads only readiness metadata and never creates or mutates repository state.
 */
export function controlAgentLifecycleCheckpoint(
  root: string,
  request: AgentLifecycleCheckpointRequestV1,
): AgentLifecycleReportV1 {
  const canonicalRoot = canonicalDirectory(root);
  return evaluateAgentLifecycleCheckpointV1(repositoryState(canonicalRoot), request);
}
