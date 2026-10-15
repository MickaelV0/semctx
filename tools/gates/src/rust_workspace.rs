//! Discover native product tests from tracked manifests, including crates added after this gate.
//! Cargo owns workspace membership; no hand-maintained product-crate allowlist is authoritative.
use crate::{
    Result, plan, process,
    receipt::{Action, OUTPUT_CAP, STEP_BUDGET_MS, Step},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

const TOOL_MANIFESTS: &[&str] = &["tools/gates/Cargo.toml", "tools/qualification/Cargo.toml"];
#[derive(Serialize)]
pub struct Report {
    pub schema: u32,
    pub status: String,
    pub message: String,
    pub manifests: Vec<String>,
    pub discovery: Vec<Step>,
    pub runs: Vec<Step>,
}
fn tracked(root: &Path) -> Result<BTreeSet<String>> {
    let bytes = plan::git(root, &["ls-files", "-z"])?;
    if !bytes.is_empty() && bytes.last() != Some(&0) {
        return Err("malformed tracked file list".into());
    }
    String::from_utf8(bytes)
        .map_err(|_| "non-UTF8 tracked paths".into())
        .map(|s| {
            s.split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
}
fn confined(root: &Path, path: &Path) -> Result<PathBuf> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !canonical.starts_with(root) {
        return Err(format!(
            "Cargo path escapes source root: {}",
            path.display()
        ));
    }
    Ok(canonical)
}
fn relative(root: &Path, path: &Path) -> Result<String> {
    path.strip_prefix(root)
        .map_err(|_| "Cargo path escapes source root".to_owned())?
        .components()
        .map(|p| p.as_os_str().to_str().ok_or("non-UTF8 Cargo path"))
        .collect::<std::result::Result<Vec<_>, _>>()
        .map(|parts| parts.join("/"))
        .map_err(str::to_owned)
}
fn require_tracked(root: &Path, path: &Path, tracked: &BTreeSet<String>) -> Result<PathBuf> {
    let path = confined(root, path)?;
    let relative = relative(root, &path)?;
    if !tracked.contains(&relative) {
        return Err(format!("Cargo path must be tracked: {relative}"));
    }
    Ok(path)
}
fn has_ancestor_lock(root: &Path, manifest: &Path, tracked: &BTreeSet<String>) -> bool {
    let mut parent = manifest.parent();
    while let Some(directory) = parent {
        if !directory.starts_with(root) {
            break;
        }
        if relative(root, &directory.join("Cargo.lock")).is_ok_and(|p| tracked.contains(&p)) {
            return true;
        }
        parent = directory.parent();
    }
    false
}
fn command(label: String, argv: Vec<String>, timeout_ms: u64) -> Action {
    Action {
        label,
        argv,
        timeout_ms,
        output_cap: OUTPUT_CAP,
    }
}

pub fn test(root: &Path) -> Result<Report> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let tracked = tracked(&root)?;
    let manifests = tracked
        .iter()
        .filter(|p| {
            (p.as_str() == "Cargo.toml" || p.ends_with("/Cargo.toml"))
                && !TOOL_MANIFESTS.contains(&p.as_str())
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut report = Report {
        schema: 1,
        status: "no_product".into(),
        message: "no native product crates yet".into(),
        manifests: manifests.clone(),
        discovery: vec![],
        runs: vec![],
    };
    if manifests.is_empty() {
        return Ok(report);
    }
    let mut covered = BTreeSet::new();
    let mut workspaces: BTreeMap<PathBuf, Vec<String>> = BTreeMap::new();
    for manifest in &manifests {
        // Git paths are passed as argv, never interpreted as shell or Cargo options.
        if Path::new(manifest).is_absolute()
            || manifest.contains('\\')
            || manifest.split('/').any(|p| p == ".." || p.is_empty())
        {
            return Err("invalid tracked Cargo path".into());
        }
        let manifest_path = require_tracked(&root, &root.join(manifest), &tracked)?;
        if covered.contains(&manifest_path) {
            continue;
        }
        if !has_ancestor_lock(&root, &manifest_path, &tracked) {
            return Err(format!("missing tracked Cargo.lock for {manifest}"));
        }
        let action = command(
            format!("Cargo workspace discovery: {manifest}"),
            vec![
                "cargo".into(),
                "metadata".into(),
                "--no-deps".into(),
                "--locked".into(),
                "--format-version".into(),
                "1".into(),
                "--manifest-path".into(),
                manifest_path.to_string_lossy().into_owned(),
            ],
            60_000,
        );
        let outcome = process::run(&action.argv, &root, action.timeout_ms, action.output_cap)?;
        if outcome.kind != "success" || outcome.exit_code != Some(0) {
            return Err(format!(
                "Cargo workspace discovery failed for {manifest}: {}\n{}{}",
                outcome.kind, outcome.stdout, outcome.stderr
            ));
        }
        let metadata: serde_json::Value = serde_json::from_str(&outcome.stdout)
            .map_err(|e| format!("malformed cargo metadata for {manifest}: {e}"))?;
        report.discovery.push(Step { action, outcome });
        let workspace = metadata["workspace_root"]
            .as_str()
            .ok_or("cargo metadata missing workspace_root")?;
        let owner = require_tracked(&root, &Path::new(workspace).join("Cargo.toml"), &tracked)?;
        require_tracked(
            &root,
            &owner
                .parent()
                .ok_or("workspace has no directory")?
                .join("Cargo.lock"),
            &tracked,
        )?;
        let members = metadata["workspace_members"]
            .as_array()
            .ok_or("cargo metadata missing workspace_members")?;
        let packages = metadata["packages"]
            .as_array()
            .ok_or("cargo metadata missing packages")?;
        let mut exclusions = vec![];
        let mut product_members = 0;
        for member in members {
            let package = packages
                .iter()
                .find(|p| &p["id"] == member)
                .ok_or("unresolved Cargo workspace member")?;
            let package_manifest = package["manifest_path"]
                .as_str()
                .ok_or("Cargo member missing manifest")?;
            let path = require_tracked(&root, Path::new(package_manifest), &tracked)?;
            let relative_path = relative(&root, &path)?;
            if TOOL_MANIFESTS.contains(&relative_path.as_str()) {
                exclusions.push(
                    package["name"]
                        .as_str()
                        .ok_or("Cargo tool member missing name")?
                        .to_owned(),
                );
            } else {
                product_members += 1;
            }
            covered.insert(path);
        }
        covered.insert(owner.clone());
        if !covered.contains(&manifest_path) {
            return Err(format!("Cargo workspace does not account for {manifest}"));
        }
        if product_members > 0
            && let Some(previous) = workspaces.insert(owner, exclusions.clone())
            && previous != exclusions
        {
            return Err("ambiguous Cargo workspace membership".into());
        }
    }
    if workspaces.is_empty() {
        return Ok(report);
    }
    report.status = "passed".into();
    report.message = "native product test suites executed; tooling suites are separate".into();
    for (manifest, exclusions) in workspaces {
        let relative = relative(&root, &manifest)?;
        let mut argv = vec![
            "cargo".into(),
            "test".into(),
            "--workspace".into(),
            "--locked".into(),
            "--manifest-path".into(),
            manifest.to_string_lossy().into_owned(),
        ];
        for exclusion in exclusions {
            argv.extend(["--exclude".into(), exclusion]);
        }
        let action = command(
            format!("native product tests: {relative}"),
            argv,
            STEP_BUDGET_MS,
        );
        eprintln!("[semctx-gates] START {}", action.label);
        let outcome = process::run(&action.argv, &root, action.timeout_ms, action.output_cap)?;
        eprint!("{}{}", outcome.stdout, outcome.stderr);
        let executed_tests = outcome.stdout.lines().any(|line| {
            line.strip_prefix("test result: ok. ")
                .and_then(|summary| summary.split_once(" passed;"))
                .and_then(|(count, _)| count.parse::<u64>().ok())
                .is_some_and(|count| count > 0)
        });
        let passed = outcome.kind == "success" && outcome.exit_code == Some(0) && executed_tests;
        report.runs.push(Step { action, outcome });
        if !passed {
            report.status = "failed".into();
            report.message = if executed_tests {
                format!("native product tests failed: {relative}")
            } else {
                format!(
                    "native product test execution unproven (no passing libtest cases): {relative}"
                )
            };
            break;
        }
    }
    Ok(report)
}
