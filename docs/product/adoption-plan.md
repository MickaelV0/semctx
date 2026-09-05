# Adoption plan and decision record

> Adopted 2026-09-05 under the maintainer's delegated roadmap authority.
> Baseline: v0.1.19 / `0349a9ca242d3be22305b6438676b711bcf074a9`.
> Planning only: no new runtime, installation or enforcement capability is delivered here.

## Pre-action governance record

LATENT_COMPASS_ROUTING_NOTE_V1

- decision_id: semctx-adoption-roadmap-2026-09-05
- objective: make adoption and useful outcomes measurable while keeping future index claims bounded.
- authority: maintainer delegated roadmap and tooling choices to Codex in this session.
- candidates: A, extend control/authorization first; B, adoption and impact evidence first, then index operations; C, prioritize native retrieval/index replacement.
- pre_action_evidence:
  - A — SUCCESS: existing contracts/replay foundation. VIOLATION: execution remains gated. COST: more workflow concepts. INFORMATION: P4 and measured lifecycle open. REVERSIBILITY: read-only work reversible; enforcement needs a separate decision.
  - B — SUCCESS: released analyzer/installers support a narrower first-use path. VIOLATION: static links cannot become coverage; pilot cannot become P4. COST: demo and measurement tooling needed. INFORMATION: onboarding friction observed; retention/benefit UNKNOWN. REVERSIBILITY: opt-in pilots and roadmap reversible, no provider removal.
  - C — SUCCESS: content-first protocol exists. VIOLATION: replacement blocked before CONTINUE and REPLACEMENT_READY. COST: index lifecycle/migration scope. INFORMATION: historical retrieval result negative; new advantage UNKNOWN. REVERSIBILITY: parallel pilot reversible, removal needs verified restore/cutover.
- result: RECORD
- claim_boundary: records alternatives and known facts; predicts neither adoption nor success.
- handoff: Codex lead within the maintainer's delegated authority.

Decision: choose B. Preserve A as an advanced use case and C as conditional research.

## Audience and progressive disclosure

Start with TypeScript maintainers using CLI, Codex or Claude. Their first task is reviewing a diff,
not configuring semantic levels. A useful first report needs no authored marker. Offer three depths:
concise impact advice; optional authored contracts; independent replay/provider integration. Each
depth remains useful without the next.

The front door needs one promise, a reproducible before/after example, prerequisites, one starting
route, capability limits and evidence. Separate current/planned/experimental features. Recipes cover
an exported-contract change, an invariant change and an unsupported/stale scope.

## Product measurements

Targets below are decisions, not measurements. Freeze the protocol before scoring. Changing a target
starts a new experiment and retains previous outcomes.

| Question | Initial measurement/target |
| --- | --- |
| First value | Five independent maintainers without author coaching during scored attempts; four correctly interpret a report within ten minutes on the demo. Separate download, setup, indexing and reading time; retain failures. |
| Return use | Three of the same five use it on a second real change within fourteen days. Record non-return reasons. This is exploratory, not evidence of broad market fit. |
| Useful impact | Thirty real changes across three independent repositories, including benign moves and meaningful regressions. Compare changed-files-only and bounded import-neighborhood baselines; predeclare labels, unknowns, exclusions and budgets. |
| Worth the cost | Target 20% lower median time to select relevant checks against the stronger simple baseline, without lower recall of adjudicated critical risks. Report per repository, misses, dispersion and uncertainty; skipping checks cannot create a gain. |
| Useful warnings | Target 80% precision among adjudicated actionable findings. Report critical misses and unknown scope separately. Zero stale/invalid inputs reported as current in the hostile suite. |
| Affordable indexes | Cold/warm/update time, peak process-tree RSS, disk, rebuild count and context bytes. Hardware and corpus budgets fixed before optimization; compare exact versions/source states. |

Include time resolving false alerts, writing optional declarations, maintaining indexes and updating.
Stars/downloads indicate reach, not activation or retention. Consent-based local events suffice;
no source code, paths, prompts or repository identifiers are uploaded automatically.

Before recruitment, freeze the scoring rubric: a correctly understood report means the participant
identifies the affected scope, one appropriate next check and the stated uncertainty without treating
PASS as executed proof. Time starts at the first documented command after prerequisites are checked;
report prerequisite/download time separately and include failed setup attempts in the denominator.
A second use is a distinct real diff with a saved report and a recorded next-check decision, not a
repeat run of the demo. An actionable finding identifies a relevant risk and a feasible verification
action accepted by independent adjudication. Classify unsupported cases separately; abandonment is
an activation failure, never silently excluded. Publish counts and reasons for every exclusion.

Record unmet context needs and the source a participant had to consult manually (symbol navigation,
dependency graph, tests/runtime or conceptual search). This optional, sanitized field informs provider
selection; it is not permission to collect repository source or private paths.

Pilot on a frozen packaged candidate or a supported opt-in prerelease. Record candidate source and
artifact digests and keep stable unchanged. Publish after the candidate satisfies its criteria, then
rerun delivery/demo smoke on the exact release artifact. Explicitly review version-only metadata
changes; behavioral changes invalidate affected measurements. Pilot and delivered-SHA evidence
remain distinct and linked, not asserted byte-identical without verification.

## Evaluation boundaries

The early impact pilot evaluates the shipped workflow. It can run before external providers or all
host checkpoints exist. It cannot authorize enforcement, establish competitive leadership or replace
the full P4 authorization comparison. Here A means static repository impact, B adds authored intent
and contracts, and C adds planning/control/replay. P4 compares A, A+B and A+B+C with simpler baselines
and adversarial evidence. Independent reviewers assess the protocol and results; the maintainer
accepts a scoped positive, negative or inconclusive verdict. It never grants execution authority.

Use redistributable public cases where possible. Pin corpus commits, versions, configs and runner
identity. Keep held-out cases, exclusions, raw output and reviewer adjudication. Authors do not label
their outputs as independent ground truth. The runner must reject altered labels/configuration,
mismatched sources and missing results. Include a wrong/no-op analyzer to falsify the scorer.

The retrieval corpus remains separate. P4 retains its protocol, held-out tasks, adversarial evidence
and independent review. Retrieval comparisons use localization metrics and content-first baselines.

## Version/support decisions

- 0.1.19 is released history; unshipped providers move forward.
- 0.1.20 corrects first-contact defects; 0.2 adds the first-value experience and impact pilot.
- 0.3 improves index lifecycle/resources; 0.4 connects measured providers and evaluates richer context.
- 1.0 stabilizes supported scope; it does not require replacement of every index.
- Replacement is a separate claim, first eligible at 1.0 after CONTINUE and REPLACEMENT_READY.
- P5 stays GO/DEFER/NO-GO after accepted P4 and authority/rollback contracts, with no promised date.
- Preserve current CLI/plugin lockstep policy. Machine schemas and artifact formats have their own versions and documented migrations.
- Publish minimum supported and currently tested host versions separately from historical compatibility, which may remain unknown.

## Execution order and WIP

Linear owns detailed issue order/status; ROADMAP.md is the self-contained public direction. One NOW
outcome, at most three executable tickets. Preserve Done evidence. Moving work to Backlog means
paused, not undone.

1. **NOW, 0.1.20:** reuse doctor and registry-availability fixes; add compatibility/docs consistency. Retain historical-host research separately.
2. **NEXT, 0.2:** reproducible demo/readable report, opt-in pilot and public evidence. Protocol preparation does not wait for P4 providers.
3. **LATER, 0.3:** reuse large-monorepo benchmarks/resource work; add generation-aware lifecycle and safe config migration.
4. **CONDITIONAL, 0.4:** reuse provider/replay and research tickets with their acceptance boundaries. Select integrations from observed need.

Keep source links and residual acceptance criteria on original tickets. Cosmetic cleanup never
closes a bug. Partial implementation stays distinct from remaining proof obligations. No public
announcement or GitHub issue/comment mutation is required by this strategy.

## Review and stop decisions

Each minor release explains outcome, example, compatibility/migration, evidence and limits. Review
the pilot after fourteen days of actual access, not fourteen days after planning. Failed activation
means improving first use; failed retention means investigating value/cost before broadening scope.
A missed impact target produces a public result and a narrower experiment, not a success claim.

Retrieval can stop independently with NULL RESULT. Providers adding cost/noise without measured
benefit remain optional or are rejected. Execution is not an inevitable destination. Existing
repository review, verification and release gates remain unchanged.
