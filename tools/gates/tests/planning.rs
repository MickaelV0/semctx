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
    fn plan(&self) -> Plan {
        let output = self.cli(&[
            "ci-plan",
            "--base",
            &self.base,
            "--head",
            "HEAD",
            "--output",
            self.outer.join("plan.json").to_str().unwrap(),
        ]);
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
fn source_change_selects_transitive_consumers_on_every_os() {
    let r = Repo::new();
    r.write("packages/core/src/index.ts", "export const value = 2;\n");
    r.commit();
    let p = r.plan();
    assert_eq!(p.mode, "affected");
    assert_eq!(p.matrix.include.len(), 9);
    for lane in &p.matrix.include {
        if lane.profile == "focused" {
            assert!(lane.targets.contains("packages/service/test"));
            assert!(lane.targets.contains("apps/cli/test"));
            assert!(lane.targets.contains("plugins"));
        }
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
        8
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
