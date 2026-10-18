# B06 curated Rust workspace, macOS arm64

This is a local performance observation for the accepted bounded Rust profile, not an accepted budget or a claim of complete Rust coverage. The [corpus recipe](CORPUS_RECIPE.json) pins five upstream source trees byte-for-byte and records the locally authored manifests, lockfile, probe and Semctx configuration. The [measurements](MEASUREMENTS.json) retain each command, exit code, timing, descendant RSS, output byte count and SHA-256, source-state digest, coverage and freshness.

| Upstream crate | Version | Source commit | `src` lines |
| --- | --- | --- | ---: |
| `byteorder` | `1.5.0` | `ec068eefa042d494475db125c4b034bd8e9e34dd` | 5,567 |
| `proc-macro2` | `1.0.107` | `ed8a5497669cd63db33bf24646f261b012bbbc4a` | 6,029 |
| `unicode-ident` | `1.0.27` | `c1ac3afb721f3cea6527bc2255340a04d0de3ca0` | 976 |
| `ryu` | `1.0.23` | `f0b52bb194befe6fd242154f2182fafd43a819b8` | 2,763 |
| `once_cell` | `1.21.4` | `80fe900b21f6d76c1a2ed74d3343e8a3a88c46d0` | 2,589 |

The 17,924 upstream source lines are unchanged; the recipe gives their tree hashes and license files. The workspace adds a small consumer with exact local `path` dependencies. Offline Cargo metadata found six packages, all active dependencies local, and `cargo test --locked --offline -p b06-probe` passed. Optional and dev dependencies from upstream manifests are outside this bounded projection. In particular, running upstream `byteorder` inline tests with `cargo test --workspace` fails because `quickcheck` and `rand` are not part of this profile. The probe does not assert upstream build or test equivalence.

The recorded host was macOS 27.0.1 on Apple M4 Max, 16 cores, 64 GiB RAM, Bun 1.4.3, Rust 1.98.1 (`48a229ceaefd4985c50990b14116b6d856af0985`), target `aarch64-apple-darwin`, and rust-analyzer release `2026-10-12`, binary SHA-256 `c863e967a7244fa3687d7bd6235ac7abae5a7ce44bcbf8307eb1dc80aa85f397`. The bound toolchain identity was `sha256:3e56cc83e0a58f53ff7d578cac48ffc2ea44486a1c9a8a58677c82dc725eda7a`. The measured Semctx code commit was `deadf208c33c67c9d7ad91af45615d7bf5669b09`. No disk cache was cleared; repetitions ran sequentially.

## Admission and observations

The selected world had 44 files and 18,217 lines including the probe and build script. Rust analyzed 23 files and 10,672 lines; 20 files and 6,266 lines were unsupported, and `proc-macro2/src/fallback.rs` failed parsing (1,279 lines). `index-health` therefore reports **insufficient** coverage, while the binding remains valid. The source index is `FRESH` after cold and stable indexing, then `DIRTY_KNOWN` after each indexed working-tree change. These outcomes do not establish negative completeness or task authority.

Navigation is positive within the admitted files: `inspect symbol decode_and_count --json` returns concrete cross-crate calls into `byteorder` and `proc-macro2`. The persisted sidecar has `rust-navigation-test-v1` profiles, 321 reference edges and 296 call edges. Unknown targets and the failed/unsupported files remain outside that positive claim.

Each repetition used a fresh Git clone of the same pinned workspace. `cold` indexed it once; `stable` reindexed unchanged bytes; `edit` appended one function to `byteorder/src/lib.rs`; `add` introduced `probe/src/b06_added.rs` and its module declaration; `delete` removed that module and file after indexing the addition. All five stages rebuilt the persistent index. Ten known-present `inspect symbol` queries then ran sequentially, followed by the same ten with concurrency bounded at four processes. Every observed query returned at least one matching symbol; the `decode_and_count` query also retained both cross-crate calls.

| Index operation | Three wall samples, ms | Median, ms | Largest descendant process RSS, bytes |
| --- | --- | ---: | ---: |
| Cold | 5,858.7 / 7,522.9 / 6,206.5 | 6,206.5 | 668,893,184 |
| Stable | 5,868.8 / 7,958.1 / 6,152.1 | 6,152.1 | 649,609,216 |
| Edit | 6,152.8 / 9,315.9 / 6,170.1 | 6,170.1 | 610,844,672 |
| Add | 6,498.3 / 8,707.1 / 6,153.7 | 6,498.3 | 662,913,024 |
| Delete | 5,935.3 / 7,571.6 / 6,178.7 | 6,178.7 | 640,040,960 |

The 30 sequential CLI queries took 181.8–253.1 ms, median 201.4 ms. One `identifier_start` query exceeded the proposed 250 ms foreground budget. The three four-process fan-outs completed in 650.1 / 617.0 / 635.4 ms, with 30 successful queries and a maximum individual response of 230.7 ms. The largest observed descendant process RSS across index stages was 668,893,184 bytes, below the proposed 1 GiB per-child target. The 60 s cold deadline was not approached. These are observations of this host and workload, not a p95, SLO or cross-platform guarantee; the 250 ms proposal is not established as a hard CLI cap.

Wall time uses `time.perf_counter_ns` around each public CLI process. A fresh Python supervisor per index command records macOS `RUSAGE_CHILDREN.ru_maxrss`, which observed a test grandchild in a separate local probe. This is a maximum for a descendant process, not the sum of concurrent RSS. The fan-out measurements use a four-worker thread pool to launch separate CLI processes. No Linux or native Windows performance run was made for these local commits.

## Reproduction boundary

For each pin in `CORPUS_RECIPE.json`, check out the exact source commit, verify the declared `src` tree digest, copy `src` and the declared extra files into the named workspace member, and write every `files` entry as raw UTF-8. Copy the named upstream licenses. The recipe's measured `.semctx/config.json` contains local absolute tool paths; on another host, substitute trusted local paths and verify the pinned rust-analyzer binary digest, Rust version, target and toolchain identity before indexing. The lockfile contains only exact local package versions and no registry package. Recreate the Git baseline before each repetition, then use the stage edits and public CLI calls described above. The raw JSON gives the exact observed commands, source digests and result hashes. Its `sourceFixtureCommit` identifies the temporary assembled repository; the portable pins are the upstream commits and recipe bytes.

The proposed 250 ms / 60 s / 1 GiB budgets in the discovery remain unapproved. This candidate also leaves a parser failure and broad unsupported source visible. Budget acceptance must account for those limits and the missing native Linux/Windows measurements.
