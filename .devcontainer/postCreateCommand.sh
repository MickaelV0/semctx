#!/usr/bin/env bash
# Idempotent contributor setup. Installs project dependencies only. It never publishes, never
# runs the private benchmark, never installs Claude Code, and never needs an API key. It does not
# modify any user configuration outside the workspace.
set -euo pipefail

# Move to the repository root (this script lives in .devcontainer/).
cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is not on PATH; the dev container image is expected to provide it." >&2
  exit 1
fi

if ! command -v ruff >/dev/null 2>&1; then
  echo "error: ruff is not on PATH; the dev container image is expected to provide it." >&2
  exit 1
fi

required_ruff_version="$(awk -F'==' '$1 == "ruff" { print $2 }' requirements-quality.txt)"
installed_ruff_version="$(ruff --version | awk '{ print $2 }')"
if [[ -z "$required_ruff_version" || "$installed_ruff_version" != "$required_ruff_version" ]]; then
  echo "error: ruff $installed_ruff_version is installed; requirements-quality.txt requires $required_ruff_version." >&2
  exit 1
fi

echo "==> bun --version: $(bun --version)"
echo "==> ruff --version: $(ruff --version)"
echo "==> bun install"
bun install

cat <<'EOF'

semctx dev container ready. Common tasks:

  bun run quality                                # strict TS, ESLint, and Ruff for maintained Python
  bun run build                                  # tsc build
  bun test                                       # full suite (packages, apps, plugins)

  # Try the CLI on the shipped fixture:
  cd examples/sample-typescript-repo && bun ../../apps/cli/src/index.ts index

  # Benchmark portability smoke test (no corpus needed):
  python3 benchmarks/change-impact-eval/scripts/smoke_test.py

See docs/contributing/devcontainer.md.
EOF
