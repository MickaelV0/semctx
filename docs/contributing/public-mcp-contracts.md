# Public MCP contracts

Guidance for changes that touch the **public agent surface**: tool registration,
error normalization, structured output schemas, readiness/verdict signals, and
skill/description success gates.

semctx is fail-closed. A green suite does not prove that a public contract is
safe. Prefer **narrow, allowlisted exceptions** over global relaxations of the
error boundary.

## Blast-radius classes

Classify every commit (or the PR as a whole) before coding the fix:

| Class | Examples | Bar |
|-------|----------|-----|
| **A — Public contract** | `ToolRegistrar`, MCP output schemas, wire error codes, agent `verdict` / READY signals, skill text that defines success | Fail-closed default; adversarial tests; treat as security-class |
| **B — Domain / feature** | Shared app-services mutation (e.g. setup), preflight, policy refuse | Unit tests on the SSoT + happy + negative cases |
| **C — Transport / DX** | CLI progress lines, human messages, CLI-only presets | Integration tests as needed |

**Rule:** if a class-B need requires changing a class-A file, the change **is**
class A. Do not land it as a “nit polish” on a feature PR without the class-A
bar below.

## Prefer local exceptions over global openings

When a single tool needs a richer domain-failure wire shape (e.g. `isError: true`
with a structured body):

- **Do:** allowlist by tool name and discriminant (`kind` / `verdict`), keep the
  default path catalogue-normalized.
- **Do not:** accept any handler-authored `isError: true` whose body merely
  validates against the tool’s ordinary success schema for every tool.

Schema validity is not trust. Opaque forged errors and **schema-valid** forged
success-shaped bodies are different attacks; regression tests must cover both.

## Agent success gates vs CLI exit codes

CLI bootstrap and MCP agent readiness are not automatically the same signal.

- Extracting a shared mutation path (CLI + MCP) is good.
- Promoting a historical CLI “exit 0 / ready” short-circuit into an agent gate
  (`SETUP_READY`, skill “success only if…”) requires re-proving **fail-closed**
  semantics for every config version the default path can write.
- If CLI needs looser bootstrap compatibility, model that separately from the
  MCP analysis-readiness signal agents use to continue.

Any phrase in a tool description or skill of the form “success only if X” must
have an automated assert that fails when X becomes too wide.

## Tests that enforce the contract

| Avoid | Prefer |
|-------|--------|
| Happy-path only on small fixtures | Cross-assert success signal vs health/sub-fields (e.g. coverage insufficient) |
| `if (kind === "…") { expects… }` | Force the fixture (explicit config version / layout), then unconditional `expect(kind)` |
| Only opaque forged-error cases | Also: schema-valid forged `isError` on a **non-target** tool still hits the catalogue |
| Tests written after a global relaxation | Adversarial probe **before** opening a gate (red → narrow fix → green) |

A conditional skip around contract asserts makes the advertised contract vacuous.

## PR self-check (public MCP / wire)

Copy into the PR body when the diff touches class A:

```markdown
## Public contract self-check
- [ ] No global relaxation of ToolRegistrar / public error normalization
- [ ] Domain `isError` (if any) allowlisted by tool + kind/verdict discriminant
- [ ] Adversarial: schema-valid forged `isError` on a non-target tool → catalogue
- [ ] Agent success gate fail-closed for all config versions the default path writes
- [ ] Cross-assert: success signal vs indexHealth / coverage (or equivalent)
- [ ] Negative contract tests unconditional (no if-skip around asserts)
- [ ] Fixture forces the policy case (explicit v1 / insufficient / …)
- [ ] Skill/description success rule has a matching automated assert
- [ ] Class-A changes are not buried as “nit polish” on an unrelated feature commit
```

## Suggested commit order for hybrid work

1. Domain SSoT + unit tests (class B).
2. Transport wiring with **default** fail-closed errors.
3. If a richer domain-error wire is required: **separate** class-A commit —
   allowlist + adversarial non-target test first, then the allowlisted path.
4. Skill/description updates only after the automated gate matches the prose.
5. Packaged/child-process smoke for new public tools when practical.

## Related code

- `packages/mcp-server/src/tool-contract.ts` — registration and error boundary
- `packages/mcp-server/src/tool-output-schemas.ts` — public structured shapes
- `packages/mcp-server/test/mcp-2026-contract.test.ts` — public error contract
