import type { McpServer } from "@modelcontextprotocol/server";
import { isAbsolute } from "node:path";
import { z } from "zod-v4";
import type { RepositoryRootResolver } from "./repository-root";
import type { ToolRegistrar } from "./tool-contract";
import {
  CONTROL_EXPLORER_MAX_EDGES,
  CONTROL_EXPLORER_MAX_NODES,
  ControlExplorerOutputSchema,
  controlExplorerTool,
} from "./control-explorer";

export const CONTROL_EXPLORER_TOOL_NAME = "semctx_control_explorer";
export const CONTROL_EXPLORER_RESOURCE_URI =
  "ui://semctx/control-explorer-v1.html";
export const CONTROL_EXPLORER_RESOURCE_MIME = "text/html;profile=mcp-app";

export const CONTROL_EXPLORER_RESOURCE_META = {
  ui: {
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
  },
} as const;

export function registerControlExplorerApp(
  server: McpServer,
  tools: ToolRegistrar,
  rootResolver: RepositoryRootResolver,
): void {
  server.registerResource(
    "semctx_control_explorer_app",
    CONTROL_EXPLORER_RESOURCE_URI,
    {
      title: "Semctx Control Explorer",
      description:
        "Self-contained read-only view of freshness, coordinate coverage, evidence, and authority.",
      mimeType: CONTROL_EXPLORER_RESOURCE_MIME,
      _meta: CONTROL_EXPLORER_RESOURCE_META,
      cacheHint: { ttlMs: 86_400_000, cacheScope: "private" },
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: CONTROL_EXPLORER_RESOURCE_MIME,
        text: CONTROL_EXPLORER_HTML,
        _meta: CONTROL_EXPLORER_RESOURCE_META,
      }],
    }),
  );

  tools.registerTool(
    CONTROL_EXPLORER_TOOL_NAME,
    {
      title: "Open the read-only Control Explorer",
      description:
        "Returns one bounded, non-authorizing snapshot of control freshness, L6-L0 coordinate coverage, evidence, and required authority. It never executes or schedules a change.",
      inputSchema: {
        repositoryRoot: z.string().min(1).refine(
          isAbsolute,
          "repositoryRoot must be absolute",
        ),
        maxNodes: z.number().int().min(1).max(CONTROL_EXPLORER_MAX_NODES).optional(),
        maxEdges: z.number().int().min(1).max(CONTROL_EXPLORER_MAX_EDGES).optional(),
      },
      outputSchema: ControlExplorerOutputSchema,
      _meta: {
        ui: {
          resourceUri: CONTROL_EXPLORER_RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    ({ repositoryRoot, maxNodes, maxEdges }) => {
      const snapshot = controlExplorerTool(
        rootResolver.resolve(repositoryRoot),
        {
          ...(maxNodes === undefined ? {} : { maxNodes }),
          ...(maxEdges === undefined ? {} : { maxEdges }),
        },
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify(snapshot, null, 2),
        }],
        structuredContent: snapshot,
      };
    },
  );
}

export const CONTROL_EXPLORER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Semctx Control Explorer</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
      background: var(--color-background-primary, #111418);
      color: var(--color-text-primary, #edf1f4);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 280px; }
    header, main { padding: 1rem; }
    header {
      display: flex;
      gap: 1rem;
      align-items: flex-start;
      justify-content: space-between;
      border-bottom: 1px solid var(--color-border-primary, #39414a);
    }
    h1, h2 { margin: 0; font-weight: 650; }
    h1 { font-size: 1.15rem; }
    h2 { font-size: .95rem; margin-bottom: .65rem; }
    p { margin: .35rem 0; }
    .eyebrow {
      color: var(--color-text-secondary, #aab4be);
      font-size: .75rem;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .authority {
      border: 1px solid var(--color-border-primary, #7b5a1d);
      border-radius: .45rem;
      color: var(--color-text-primary, #ffd98c);
      padding: .45rem .6rem;
      white-space: nowrap;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
      gap: .75rem;
    }
    section {
      min-width: 0;
      border: 1px solid var(--color-border-primary, #39414a);
      border-radius: .55rem;
      padding: .8rem;
      background: var(--color-background-secondary, #171b20);
    }
    dl { display: grid; grid-template-columns: auto 1fr; gap: .35rem .65rem; margin: 0; }
    dt { color: var(--color-text-secondary, #aab4be); }
    dd { margin: 0; overflow-wrap: anywhere; }
    ol { margin: 0; padding-left: 1.25rem; }
    li { margin: .3rem 0; overflow-wrap: anywhere; }
    code { font-family: var(--font-mono, ui-monospace, monospace); }
    .empty { color: var(--color-text-secondary, #aab4be); }
    .error { color: var(--color-text-danger, #ff9c9c); }
    :focus-visible { outline: 3px solid var(--color-ring-primary, #e5a83b); outline-offset: 2px; }
    @media (max-width: 520px) {
      header { display: block; }
      .authority { display: inline-block; margin-top: .75rem; white-space: normal; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <p class="eyebrow">Plane C · read only</p>
      <h1>Semctx Control Explorer</h1>
      <p id="repository" class="empty">Waiting for the control snapshot…</p>
    </div>
    <div class="authority">Execution authority: none</div>
  </header>
  <main>
    <p id="status" aria-live="polite">Initializing the MCP App…</p>
    <div class="grid">
      <section aria-labelledby="freshness-title">
        <h2 id="freshness-title">Freshness</h2>
        <dl id="freshness"></dl>
      </section>
      <section aria-labelledby="coverage-title">
        <h2 id="coverage-title">Coordinate coverage</h2>
        <dl id="coverage"></dl>
      </section>
      <section aria-labelledby="authority-title">
        <h2 id="authority-title">Required authority</h2>
        <dl id="authority"></dl>
      </section>
      <section aria-labelledby="graph-title">
        <h2 id="graph-title">L6 → L0 coordinates</h2>
        <ol id="nodes"></ol>
        <p id="bounds" class="empty"></p>
      </section>
    </div>
  </main>
  <script>
    (() => {
      "use strict";
      const initializeId = "semctx-control-explorer-initialize";
      const status = document.getElementById("status");
      const repository = document.getElementById("repository");
      const freshness = document.getElementById("freshness");
      const coverage = document.getElementById("coverage");
      const authority = document.getElementById("authority");
      const nodes = document.getElementById("nodes");
      const bounds = document.getElementById("bounds");

      const appendPair = (target, label, value) => {
        const term = document.createElement("dt");
        const detail = document.createElement("dd");
        term.textContent = label;
        detail.textContent = String(value ?? "unavailable");
        target.append(term, detail);
      };

      const clear = (target) => {
        while (target.firstChild) target.removeChild(target.firstChild);
      };

      const isRecord = (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value);

      const render = (snapshot) => {
        if (
          !isRecord(snapshot)
          || snapshot.schemaVersion !== 1
          || snapshot.kind !== "control_explorer"
          || snapshot.executionAuthority !== "none"
          || !isRecord(snapshot.freshness)
          || !isRecord(snapshot.coverage)
          || !isRecord(snapshot.graph)
          || !isRecord(snapshot.authority)
          || !isRecord(snapshot.bounds)
        ) {
          status.textContent = "The host returned an invalid control snapshot.";
          status.className = "error";
          return;
        }

        repository.textContent = isRecord(snapshot.repository)
          ? String(snapshot.repository.name ?? "repository")
          : "repository";
        status.textContent = "Read-only snapshot loaded. No action was executed.";
        status.className = "";

        clear(freshness);
        appendPair(freshness, "Verdict", snapshot.freshness.verdict);
        appendPair(
          freshness,
          "High-risk control",
          snapshot.freshness.canRunHighRiskControl === true ? "eligible" : "blocked",
        );
        appendPair(
          freshness,
          "Reasons",
          Array.isArray(snapshot.freshness.reasons)
            ? snapshot.freshness.reasons.join(", ") || "none"
            : "unavailable",
        );

        clear(coverage);
        appendPair(coverage, "Status", snapshot.coverage.status);
        appendPair(coverage, "Levels", snapshot.coverage.levels);
        appendPair(coverage, "Unsupported", snapshot.coverage.unsupported);
        appendPair(coverage, "Unmapped", snapshot.coverage.unmapped);

        clear(authority);
        appendPair(authority, "Regime", snapshot.authority.regime);
        appendPair(authority, "Altitude", snapshot.authority.requiredAltitude);
        appendPair(
          authority,
          "Obligations",
          Array.isArray(snapshot.authority.obligations)
            ? snapshot.authority.obligations.join(", ") || "none"
            : "unavailable",
        );

        clear(nodes);
        const graphNodes = Array.isArray(snapshot.graph.nodes)
          ? snapshot.graph.nodes
          : [];
        for (const node of graphNodes) {
          const item = document.createElement("li");
          if (isRecord(node)) {
            const level = node.appliesAtLevel === null
              ? "unmapped"
              : "L" + String(node.appliesAtLevel);
            item.textContent =
              level + " · " + String(node.label ?? node.id ?? "coordinate");
          } else {
            item.textContent = "invalid coordinate";
          }
          nodes.append(item);
        }
        if (graphNodes.length === 0) {
          const item = document.createElement("li");
          item.textContent = "No coordinates available for this snapshot.";
          item.className = "empty";
          nodes.append(item);
        }
        bounds.textContent =
          String(snapshot.bounds.returnedNodes ?? 0)
          + " / " + String(snapshot.bounds.maxNodes ?? 0)
          + " nodes · " + String(snapshot.bounds.returnedEdges ?? 0)
          + " / " + String(snapshot.bounds.maxEdges ?? 0)
          + " edges";
        if (snapshot.truncated === true && isRecord(snapshot.graph.omissions)) {
          const omissions = snapshot.graph.omissions;
          bounds.textContent +=
            " · omitted: "
            + String(omissions.nodesByNodeLimit ?? 0) + " nodes by node limit, "
            + String(omissions.structuralEdgesByNodeLimit ?? 0)
            + " structural edges by node limit, "
            + String(omissions.structuralEdgesByEdgeLimit ?? 0)
            + " structural edges by edge limit, "
            + String(omissions.refinementRelationsByMissingEndpoint ?? 0)
            + " refinements with missing endpoints, "
            + String(omissions.refinementRelationsByNodeLimit ?? 0)
            + " refinements by node limit, "
            + String(omissions.refinementRelationsByEdgeLimit ?? 0)
            + " refinements by edge limit";
        } else {
          bounds.textContent += " · no omissions";
        }
      };

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!isRecord(message) || message.jsonrpc !== "2.0") return;

        if (message.id === initializeId && isRecord(message.result)) {
          window.parent.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/initialized",
          }, "*");
          return;
        }

        if (
          message.method === "ui/notifications/tool-result"
          && isRecord(message.params)
        ) {
          render(message.params.structuredContent);
          return;
        }

        if (message.method === "ui/notifications/tool-cancelled") {
          status.textContent = "The control snapshot was cancelled.";
          status.className = "error";
          return;
        }

        if (message.method === "ui/resource-teardown" && message.id !== undefined) {
          window.parent.postMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {},
          }, "*");
        }
      });

      window.parent.postMessage({
        jsonrpc: "2.0",
        id: initializeId,
        method: "ui/initialize",
        params: {
          protocolVersion: "2026-01-26",
          appInfo: { name: "Semctx Control Explorer", version: "1.0.0" },
          appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        },
      }, "*");
    })();
  </script>
</body>
</html>`;
