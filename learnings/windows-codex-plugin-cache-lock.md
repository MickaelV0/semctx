# Windows Codex plugin cache lock during migration

## Symptom

`codex plugin remove semctx-control@personal --json` can fail with `os error 32` after the stable
replacement has already installed and verified successfully.

## Trigger

An active Codex task keeps the legacy plugin runtime open from the old cache directory. Windows
therefore refuses the CLI's recursive cache removal even though the marketplace and replacement
registration are otherwise healthy.

## Why the mapping was not obvious

The failing command is a configuration migration, but the blocked resource is a runtime file held
by the host process. Unit tests and fresh-host installs do not reproduce that lifecycle overlap.

## Detection and handling

Treat only the exact Codex cache-removal shape containing `os error 32` as a deferrable lock. The
replacement must be installed, enabled, and version-verified first. Retry the allowlisted legacy
plugin and marketplace removals in a detached helper; keep every other cleanup error blocking.
