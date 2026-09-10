# importlinter — skipped

No `.importlinter` in this repo. Playbook Wave 1 structural check is N/A.

Layer contracts to enforce instead (architecture wave, `docs/architecture/overview.md`):

- `ts-analyzer` never persists, never ranks
- `repository-store` never parses, never ranks
- `context-engine` never touches filesystem AST
- CLI/MCP thin over `app-services`
- Plane C read-only, no executor
- `core` depends on Zod only
