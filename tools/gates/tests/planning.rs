#![cfg(test)]
use semctx_gates::plan::Plan;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Repo {
    outer: PathBuf,
    root: PathBuf,
    base: String,
}
impl Repo {
    fn new() -> Self {
        let outer = std::env::temp_dir().join(format!(
            "semctx-gates-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let root = outer.join("repo");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "fixture@example.invalid"]);
        git(&root, &["config", "user.name", "Fixture"]);
        let mut repo = Self {
            outer,
            root,
            base: String::new(),
        };
        for (component, name, dependencies) in [
            ("packages/core", "@s/core", "{}"),
            (
                "packages/service",
                "@s/service",
                r#"{"@s/core":"workspace:*"}"#,
            ),
            ("apps/cli", "semctx", r#"{"@s/service":"workspace:*"}"#),
        ] {
            repo.write(
                &format!("{component}/package.json"),
                &format!(r#"{{"name":"{name}","dependencies":{dependencies}}}"#),
            );
            repo.write(
                &format!("{component}/test/example.test.ts"),
                "test fixture\n",
            );
            repo.write(
                &format!("{component}/src/index.ts"),
                "export const value = 1;\n",
            );
        }
        repo.write("plugins/example.test.ts", "fixture\n");
        for path in semctx_gates::os_boundaries::TESTS {
            repo.write(path, "test fixture\n");
        }
        repo.write("README.md", "baseline\n");
        repo.commit();
        repo.base = git(&repo.root, &["rev-parse", "HEAD"]).trim().into();
        repo
    }
    fn write(&self, path: &str, value: &str) {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }
    fn commit(&self) {
        git(&self.root, &["add", "."]);
        git(&self.root, &["commit", "-qm", "fixture"]);
    }
    fn cli(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_semctx-gates"))
            .arg(args[0])
            .arg("--root")
            .arg(&self.root)
            .args(&args[1..])
            .output()
            .unwrap()
    }
    fn verify_pr(&self, root: &Path) -> Output {
        let tools = self.outer.join("tools");
        fs::create_dir_all(&tools).unwrap();
        for tool in ["bun", "python", "cargo"] {
            fs::copy(
                env!("CARGO_BIN_EXE_semctx-gates-fixture"),
                tools.join(format!("{tool}{}", std::env::consts::EXE_SUFFIX)),
            )
            .unwrap();
        }
        let path = std::env::join_paths(
            std::iter::once(tools).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
        )
        .unwrap();
        Command::new(env!("CARGO_BIN_EXE_semctx-gates"))
            .current_dir(&self.outer)
            .args(["verify-pr", "--root"])
            .arg(root)
            .args(["--base", &self.base])
            .env("PATH", path)
            .env("SEMCTX_TEST_TOOL_LOG", self.outer.join("tools.log"))
            .output()
            .unwrap()
    }
    fn plan_output(&self, base: &str, head: &str) -> Output {
        self.cli(&[
            "ci-plan",
            "--base",
            base,
            "--head",
            head,
            "--output",
            self.outer.join("plan.json").to_str().unwrap(),
        ])
    }
    fn plan(&self) -> Plan {
        let output = self.plan_output(&self.base, "HEAD");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.outer);
    }
}
fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
#[test]
fn docs_keep_contract_and_plan_is_deterministic() {
    let r = Repo::new();
    r.write("README.md", "changed\n");
    r.commit();
    let p = r.plan();
    assert_eq!(p.mode, "docs");
    assert_eq!(p.matrix.include.len(), 1);
    assert_eq!(p, r.plan());
    assert_eq!(p.subject.head, git(&r.root, &["rev-parse", "HEAD"]).trim());
    assert_eq!(
        p.subject.tree,
        git(&r.root, &["rev-parse", "HEAD^{tree}"]).trim()
    );
}
#[test]
fn source_change_keeps_linux_complete_and_selects_native_os_boundaries() {
    assert_eq!(semctx_gates::os_boundaries::TESTS.len(), 72);
    assert!(
        semctx_gates::os_boundaries::TESTS
            .windows(2)
            .all(|pair| pair[0] < pair[1])
    );
    let r = Repo::new();
    r.write("packages/core/src/index.ts", "export const value = 2;\n");
    r.commit();
    let p = r.plan();
    assert_eq!(p.mode, "affected");
    assert_eq!(p.matrix.include.len(), 8);
    for (os, count, profile) in [
        ("ubuntu-latest", 4, "full"),
        ("windows-latest", 2, "os-boundary"),
        ("macos-15", 1, "os-boundary"),
    ] {
        let lanes = p
            .matrix
            .include
            .iter()
            .filter(|l| l.os == os && l.profile == profile)
            .collect::<Vec<_>>();
        assert_eq!(lanes.len(), count);
        for (index, lane) in lanes.iter().enumerate() {
            assert_eq!(lane.shard, format!("{}/{count}", index + 1));
            if profile == "os-boundary" {
                for witness in [
                    "packages/app-services/test/cli-compatibility.test.ts",
                    "packages/app-services/test/verify-base-tree.test.ts",
                    "packages/ts-analyzer/test/parallel-extraction.test.ts",
                    "packages/app-services/test/bounded-process.test.ts",
                    "packages/app-services/test/codex-plugin-metadata.test.ts",
                    "packages/app-services/test/codex-plugin-production-boundary.test.ts",
                    "packages/repository-store/test/store-process-crash.test.ts",
                    "apps/cli/test/package-runtime.test.ts",
                    "packages/mcp-server/test/mcp-modern-stdio.test.ts",
                    "apps/cli/test/init-preset.test.ts",
                    "apps/cli/test/local-reports.test.ts",
                    "apps/cli/test/ordinary-reserved-report.test.ts",
                    "apps/cli/test/plugin-status-attestation.test.ts",
                    "apps/cli/test/qualified-output.test.ts",
                    "apps/cli/test/setup-dry-run.test.ts",
                    "packages/app-services/test/config-migration.test.ts",
                    "packages/app-services/test/control-handoff-v2.test.ts",
                    "packages/app-services/test/plugin-delivery.test.ts",
                    "packages/app-services/test/qualified-analysis.test.ts",
                    "packages/app-services/test/readiness-link-safety.test.ts",
                    "packages/app-services/test/setup-scope.test.ts",
                    "packages/app-services/test/setup.test.ts",
                    "packages/app-services/test/qualified-build-directory-probe.test.ts",
                    "packages/mcp-server/test/mcp-2026-contract.test.ts",
                    "packages/mcp-server/test/setup-scope-tools.test.ts",
                    "packages/semantic-engine/test/anchor-migration.test.ts",
                    "packages/semantic-engine/test/targets.test.ts",
                    "packages/ts-analyzer/test/discovery-missing-import-alias.test.ts",
                    "packages/ts-analyzer/test/discovery-selection.test.ts",
                    "packages/ts-analyzer/test/retained-directory-alias.test.ts",
                    "packages/ts-analyzer/test/semantic-context-memory.test.ts",
                    "packages/change-authorization-verifier/test/architecture.test.ts",
                ] {
                    assert!(
                        lane.targets.split(',').any(|p| p == witness),
                        "{os} missing native boundary witness {witness}"
                    );
                }
                assert!(!lane.targets.contains("packages/service/test"));
            }
        }
    }
}
#[test]
fn git_symlink_witness_materialized_as_regular_file_keeps_full_coverage() {
    let r = Repo::new();
    let path = "apps/cli/test/package-runtime.test.ts";
    git(&r.root, &["config", "core.symlinks", "false"]);
    r.write(path, "../../../README.md");
    git(&r.root, &["add", path]);
    let blob = git(&r.root, &["rev-parse", &format!(":{path}")]);
    git(
        &r.root,
        &[
            "update-index",
            "--cacheinfo",
            &format!("120000,{},{}", blob.trim(), path),
        ],
    );
    git(
        &r.root,
        &["commit", "-qm", "tracked symlink with regular checkout"],
    );
    assert!(
        fs::symlink_metadata(r.root.join(path))
            .unwrap()
            .file_type()
            .is_file()
    );
    assert_eq!(r.plan().mode, "fallback");
}
#[test]
fn physical_symlink_witness_keeps_full_coverage() {
    let r = Repo::new();
    let path = "apps/cli/test/package-runtime.test.ts";
    fs::remove_file(r.root.join(path)).unwrap();
    #[cfg(windows)]
    let result = std::os::windows::fs::symlink_file(r.root.join("README.md"), r.root.join(path));
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(r.root.join("README.md"), r.root.join(path));
    if let Err(error) = result {
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        eprintln!("native symlink unavailable: {error}");
        return;
    }
    git(&r.root, &["update-index", "--assume-unchanged", path]);
    r.write("packages/core/src/index.ts", "changed\n");
    r.commit();
    assert_eq!(r.plan().mode, "fallback");
}
#[test]
fn affected_target_must_be_a_committed_physical_directory() {
    let r = Repo::new();
    fs::remove_dir_all(r.root.join("packages/service/test")).unwrap();
    r.write("packages/service/test", "not a test directory\n");
    r.write("packages/core/src/index.ts", "changed\n");
    r.commit();
    assert_eq!(r.plan().mode, "fallback");
}
#[test]
fn physical_symlink_affected_directory_keeps_full_coverage() {
    let r = Repo::new();
    let path = "packages/service/test";
    let destination = r.outer.join("external-tests");
    fs::rename(r.root.join(path), &destination).unwrap();
    #[cfg(windows)]
    let result = std::os::windows::fs::symlink_dir(&destination, r.root.join(path));
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(&destination, r.root.join(path));
    if let Err(error) = result {
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        eprintln!("native directory symlink unavailable: {error}");
        return;
    }
    git(
        &r.root,
        &[
            "update-index",
            "--assume-unchanged",
            "packages/service/test/example.test.ts",
        ],
    );
    r.write("packages/core/src/index.ts", "changed\n");
    r.commit();
    assert_eq!(r.plan().mode, "fallback");
}
#[test]
fn physical_symlink_witness_parent_keeps_full_coverage() {
    linked_witness_parent_keeps_full_coverage(false);
}
#[cfg(windows)]
#[test]
fn physical_junction_witness_parent_keeps_full_coverage() {
    linked_witness_parent_keeps_full_coverage(true);
}
fn linked_witness_parent_keeps_full_coverage(junction: bool) {
    let r = Repo::new();
    let path = "packages/ts-analyzer/test";
    let tracked = git(&r.root, &["ls-files", path]);
    let destination = r.outer.join("external-witnesses");
    fs::rename(r.root.join(path), &destination).unwrap();
    #[cfg(windows)]
    let result = if junction {
        let output = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(r.root.join(path).to_str().unwrap().replace('/', "\\"))
            .arg(&destination)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        Ok(())
    } else {
        std::os::windows::fs::symlink_dir(&destination, r.root.join(path))
    };
    #[cfg(unix)]
    let result = {
        assert!(!junction);
        std::os::unix::fs::symlink(&destination, r.root.join(path))
    };
    if let Err(error) = result {
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        eprintln!("native parent symlink unavailable: {error}");
        return;
    }
    let mut args = vec!["update-index", "--assume-unchanged"];
    args.extend(tracked.lines());
    git(&r.root, &args);
    r.write(".git/info/exclude", &format!("{path}\n"));
    r.write("packages/core/src/index.ts", "changed\n");
    git(&r.root, &["add", "packages/core/src/index.ts"]);
    git(
        &r.root,
        &["commit", "-qm", "source change with physical parent link"],
    );
    assert_eq!(r.plan().mode, "fallback");
}
#[test]
fn os_boundary_commands_execute_selected_files_and_surface_failures() {
    let mut r = Repo::new();
    let observed = r.outer.join("observed.jsonl");
    let destination = serde_json::to_string(observed.to_str().unwrap()).unwrap();
    for path in semctx_gates::os_boundaries::TESTS {
        let marker = serde_json::to_string(&format!("{path}\n")).unwrap();
        r.write(path, &format!("import {{ test }} from 'bun:test'; import {{ appendFileSync }} from 'node:fs'; test('native witness', () => appendFileSync({destination}, {marker}));\n"));
    }
    r.commit();
    r.base = git(&r.root, &["rev-parse", "HEAD"]).trim().into();
    r.write("packages/core/src/index.ts", "export const value = 2;\n");
    r.commit();
    let plan = r.plan();
    let os = if cfg!(windows) {
        "windows-latest"
    } else {
        "macos-15"
    };
    let actions = plan
        .matrix
        .include
        .iter()
        .filter(|lane| lane.os == os)
        .map(|lane| {
            semctx_gates::receipt::commands(lane, &r.base)
                .unwrap()
                .remove(0)
        })
        .collect::<Vec<_>>();
    assert!(!actions.is_empty());
    let run = || {
        actions
            .iter()
            .map(|action| {
                Command::new(&action.argv[0])
                    .args(&action.argv[1..])
                    .current_dir(&r.root)
                    .output()
                    .unwrap()
            })
            .collect::<Vec<_>>()
    };
    let results = run();
    assert!(results.iter().all(|r| r.status.success()), "{results:?}");
    let mut seen = fs::read_to_string(&observed)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    seen.sort();
    let mut expected = semctx_gates::os_boundaries::TESTS
        .iter()
        .map(|p| (*p).to_owned())
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(seen, expected);
    let witness = "apps/cli/test/package-runtime.test.ts";
    let original = fs::read_to_string(r.root.join(witness)).unwrap();
    r.write(witness, "import { test, expect } from 'bun:test'; test('broken package boundary', () => expect(1).toBe(2));\n");
    let rejected = run();
    assert!(rejected.iter().any(|r| !r.status.success()));
    assert!(
        rejected
            .iter()
            .any(|r| String::from_utf8_lossy(&r.stderr).contains("broken package boundary"))
    );
    r.write(witness, &original);
    assert!(run().iter().all(|r| r.status.success()));
}
#[test]
fn dependency_changes_keep_full_cross_platform_coverage() {
    let r = Repo::new();
    r.write(
        "packages/core/package.json",
        r#"{"name":"@s/core","dependencies":{"external":"1.0.0"}}"#,
    );
    r.commit();
    assert_eq!(r.plan().mode, "fallback");
}
#[test]
fn absent_or_nonfile_os_witness_keeps_full_cross_platform_coverage() {
    for replacement in ["deleted", "directory"] {
        let r = Repo::new();
        let path = "apps/cli/test/package-runtime.test.ts";
        fs::remove_file(r.root.join(path)).unwrap();
        if replacement == "directory" {
            r.write(&format!("{path}/nested.test.ts"), "nested\n");
        }
        r.commit();
        assert_eq!(r.plan().mode, "fallback", "{replacement}");
    }
}
#[test]
fn shared_plugin_runtime_keeps_full_consumer_coverage_on_every_os() {
    let r = Repo::new();
    r.write(
        "plugins/shared/hooks/process-budget.mjs",
        "export const budget = 1;\n",
    );
    r.commit();
    let p = r.plan();
    assert_eq!(
        p.mode, "fallback",
        "shared plugin code has consumers outside package manifests"
    );
    for os in ["ubuntu-latest", "windows-latest", "macos-15"] {
        assert!(
            p.matrix
                .include
                .iter()
                .any(|lane| lane.os == os && lane.profile == "full")
        );
    }
}
#[test]
fn unknown_path_and_empty_diff_keep_full_cross_platform_coverage() {
    let r = Repo::new();
    assert_eq!(r.plan().mode, "fallback");
    r.write("unknown/runtime.rs", "unknown\n");
    r.commit();
    let p = r.plan();
    assert_eq!(p.mode, "fallback");
    assert_eq!(
        p.matrix
            .include
            .iter()
            .filter(|l| l.profile == "full")
            .count(),
        10
    );
}
#[test]
fn rename_keeps_removed_path_and_new_path_in_obligations() {
    let r = Repo::new();
    fs::rename(
        r.root.join("packages/core/src/index.ts"),
        r.root.join("packages/service/src/moved.ts"),
    )
    .unwrap();
    r.commit();
    let p = r.plan();
    assert!(p.paths.contains(&"packages/core/src/index.ts".into()));
    assert!(p.paths.contains(&"packages/service/src/moved.ts".into()));
}
#[test]
fn dirty_and_untracked_subject_refused() {
    let r = Repo::new();
    r.write("README.md", "dirty\n");
    let output = r.cli(&[
        "ci-plan",
        "--base",
        &r.base,
        "--head",
        "HEAD",
        "--output",
        r.outer.join("plan.json").to_str().unwrap(),
    ]);
    assert!(!output.status.success());
    git(&r.root, &["checkout", "--", "README.md"]);
    r.write("untracked.rs", "new\n");
    let output = r.cli(&[
        "ci-plan",
        "--base",
        &r.base,
        "--head",
        "HEAD",
        "--output",
        r.outer.join("plan.json").to_str().unwrap(),
    ]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("untracked"));
}
#[test]
fn cleanliness_refuses_index_and_worktree_changes_despite_status_configuration() {
    for state in [
        "staged",
        "reverted",
        "added",
        "deleted",
        "renamed",
        "untracked",
    ] {
        let r = Repo::new();
        git(&r.root, &["config", "status.showUntrackedFiles", "no"]);
        match state {
            "staged" | "reverted" => {
                r.write("README.md", "staged\n");
                git(&r.root, &["add", "README.md"]);
                if state == "reverted" {
                    r.write("README.md", "baseline\n");
                }
            }
            "added" => {
                r.write("new & file.md", "added\n");
                git(&r.root, &["add", "new & file.md"]);
            }
            "deleted" => fs::remove_file(r.root.join("README.md")).unwrap(),
            "renamed" => {
                git(&r.root, &["mv", "README.md", "renamed & file.md"]);
            }
            "untracked" => r.write("nested/new & file.md", "untracked\n"),
            _ => unreachable!(),
        }
        assert!(
            !r.plan_output(&r.base, "HEAD").status.success(),
            "accepted {state} source"
        );
    }
}
#[test]
fn cleanliness_preserves_ignored_files_and_submodule_configuration() {
    let source = Repo::new();
    let r = Repo::new();
    r.write(".gitignore", "ignored/\n");
    git(
        &r.root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "--quiet",
            source.root.to_str().unwrap(),
            "module",
        ],
    );
    r.commit();
    r.write("ignored/file", "ignored\n");
    r.write("module/untracked", "untracked\n");
    r.plan();
    git(&r.root, &["config", "diff.ignoreSubmodules", "none"]);
    assert!(!r.plan_output(&r.base, "HEAD").status.success());
    git(&r.root, &["config", "--unset", "diff.ignoreSubmodules"]);
    r.write("module/README.md", "modified\n");
    assert!(!r.plan_output(&r.base, "HEAD").status.success());
    git(&r.root, &["config", "submodule.module.ignore", "all"]);
    r.plan();
    git(
        &r.root.join("module"),
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qam",
            "changed module",
        ],
    );
    git(&r.root, &["add", "module"]);
    r.plan();
}
#[test]
fn cleanliness_refuses_failed_git_inspection() {
    let r = Repo::new();
    git(&r.root, &["config", "diff.algorithm", "invalid-algorithm"]);
    let output = r.plan_output(&r.base, "HEAD");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("invalid-algorithm"));
}
#[test]
fn subject_resolves_annotated_tags_to_immutable_commits_and_tree() {
    let r = Repo::new();
    git(&r.root, &["tag", "-am", "base tag", "base-tag"]);
    r.write("README.md", "changed\n");
    r.commit();
    git(&r.root, &["tag", "-am", "head tag", "head-tag"]);
    let output = r.plan_output("base-tag", "head-tag");
    assert!(output.status.success(), "{output:?}");
    let p: Plan = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(p.subject.base, r.base);
    assert_eq!(p.subject.head, git(&r.root, &["rev-parse", "HEAD"]).trim());
    assert_eq!(
        p.subject.tree,
        git(&r.root, &["rev-parse", "HEAD^{tree}"]).trim()
    );
}
#[test]
fn subject_refuses_missing_noncommit_expanded_and_noncheckout_revisions() {
    let r = Repo::new();
    r.write("README.md", "changed\n");
    r.commit();
    for invalid in [
        "absent-ref",
        "HEAD^{tree}",
        "HEAD:README.md",
        "HEAD~1..HEAD",
        "HEAD~1...HEAD",
        "^HEAD",
        "HEAD^@",
        "HEAD\nHEAD",
        "--all",
    ] {
        assert!(
            !r.plan_output(invalid, "HEAD").status.success(),
            "accepted invalid base {invalid:?}"
        );
        assert!(
            !r.plan_output(&r.base, invalid).status.success(),
            "accepted invalid head {invalid:?}"
        );
    }
    assert!(!r.plan_output(&r.base, &r.base).status.success());
}
#[test]
fn subject_refuses_checkout_whose_head_names_an_annotated_tag_object() {
    let r = Repo::new();
    git(&r.root, &["tag", "-am", "head tag", "head-tag"]);
    git(&r.root, &["symbolic-ref", "HEAD", "refs/tags/head-tag"]);
    let output = r.plan_output(&r.base, "head-tag");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("checkout"));
}
#[test]
fn tampered_plan_is_refused_and_failure_receipt_written() {
    let r = Repo::new();
    r.write("README.md", "changed\n");
    r.commit();
    let mut p = r.plan();
    p.mode = "forged".into();
    let plan = r.outer.join("plan.json");
    fs::write(&plan, serde_json::to_vec(&p).unwrap()).unwrap();
    let receipt = r.outer.join("receipt.json");
    let output = r.cli(&[
        "ci-run",
        "--plan",
        plan.to_str().unwrap(),
        "--lane",
        "0",
        "--receipt",
        receipt.to_str().unwrap(),
    ]);
    assert!(!output.status.success());
    let receipt: serde_json::Value = serde_json::from_slice(&fs::read(receipt).unwrap()).unwrap();
    assert_eq!(receipt["status"], "failed");
    assert!(receipt["error"].as_str().unwrap().contains("recomputed"));
    assert_eq!(receipt["steps"].as_array().unwrap().len(), 0);
}
#[test]
fn aggregate_rejects_missing_receipts() {
    let r = Repo::new();
    r.plan();
    let receipts = r.outer.join("receipts");
    fs::create_dir(&receipts).unwrap();
    let output = r.cli(&[
        "aggregate",
        "--plan",
        r.outer.join("plan.json").to_str().unwrap(),
        "--receipts",
        receipts.to_str().unwrap(),
    ]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("missing"));
}

#[test]
fn verify_pr_resolves_relative_root_once_for_all_actions() {
    let repository = Repo::new();
    let absolute = repository.verify_pr(&repository.root);
    assert!(
        absolute.status.success(),
        "absolute root: {}",
        String::from_utf8_lossy(&absolute.stderr)
    );
    fs::remove_file(repository.outer.join("tools.log")).unwrap();
    let relative = repository.verify_pr(Path::new("repo"));
    assert!(
        relative.status.success(),
        "relative root exited {:?}: {}",
        relative.status.code(),
        String::from_utf8_lossy(&relative.stderr)
    );
    assert_eq!(relative.stdout, absolute.stdout);
    assert_eq!(relative.stdout, b"[verify:pr] PASS  all checks\n");
    let tools = fs::read_to_string(repository.outer.join("tools.log")).unwrap();
    for tool in ["bun", "python", "cargo"] {
        assert!(tools.lines().any(|line| line == tool), "{tools}");
    }
}

#[test]
fn verify_pr_refuses_missing_root_before_launching_tools() {
    let repository = Repo::new();
    let output = repository.verify_pr(Path::new("absent"));
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["status"], "refused");
    assert!(!repository.outer.join("tools.log").exists());
}

#[test]
fn verify_pr_piped_failure_preserves_the_action_diagnostic_and_exit_status() {
    let repository = Repo::new();
    fs::write(repository.outer.join("tools.fail-tool7"), "fail").unwrap();
    let output = repository.verify_pr(&repository.root);
    assert_eq!(
        output.status.code(),
        Some(7),
        "original tool status must survive"
    );
    assert!(
        output.stdout.is_empty(),
        "failed verification cannot print PASS"
    );
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("[verify:pr] FAIL compatibility (nonzero, exit=7)"),
        "PIPED_VERIFY_FAILURE_DIAGNOSTIC_MISSING: {stderr:?}"
    );
    assert_eq!(
        stderr.lines().count(),
        1,
        "only a bounded failure summary is emitted"
    );
    assert!(
        !stderr.contains("fixture tool failure"),
        "bulk child output stays captured"
    );
}
