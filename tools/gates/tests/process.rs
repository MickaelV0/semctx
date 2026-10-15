use semctx_gates::process::run_with_helper;
use std::{path::Path, sync::Mutex, time::Instant};

// Process-tree timing witnesses share the host's startup/console resources. Preserve their
// deadlines while keeping fixture launches from competing with one another.
static PROCESS_WITNESS: Mutex<()> = Mutex::new(());
fn run(mode: &str, timeout: u64, cap: usize, extra: &[&str]) -> semctx_gates::process::Outcome {
    let mut argv = vec![
        env!("CARGO_BIN_EXE_semctx-gates-fixture").to_owned(),
        mode.into(),
    ];
    argv.extend(extra.iter().map(|s| (*s).to_owned()));
    run_with_helper(
        &argv,
        &std::env::current_dir().unwrap(),
        timeout,
        cap,
        Path::new(env!("CARGO_BIN_EXE_semctx-gates")),
    )
    .unwrap()
}
#[test]
fn captures_success_and_both_streams() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let r = run("success", 5000, 1024, &[]);
    assert_eq!(r.kind, "success");
    assert_eq!(r.exit_code, Some(0));
    assert!(r.stdout.contains("fixture stdout"));
    assert!(r.stderr.contains("fixture stderr"));
}
#[test]
fn preserves_nonzero() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let r = run("nonzero", 5000, 1024, &[]);
    assert_eq!(r.kind, "nonzero");
    assert_eq!(r.exit_code, Some(7));
}
#[test]
fn bounds_and_drains_output() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let r = run("overflow", 5000, 1024, &[]);
    assert_eq!(r.kind, "output_limit");
    assert_eq!(r.stdout.len(), 1024);
    assert!(r.stdout_bytes > 1024);
}
#[test]
fn rejects_invalid_utf8() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    assert_eq!(run("malformed", 5000, 1024, &[]).kind, "malformed_output");
}
#[test]
fn enforces_timeout() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let start = Instant::now();
    assert_eq!(run("sleep", 150, 1024, &[]).kind, "timeout");
    assert!(start.elapsed().as_secs() < 5);
}
#[test]
fn timeout_kills_grandchild_holding_pipe() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let start = Instant::now();
    let r = run("grandchild", 1000, 1024, &["wait"]);
    assert_eq!(r.kind, "timeout");
    assert!(r.stdout.contains("grandchild"));
    assert!(start.elapsed().as_secs() < 5);
}
#[test]
fn exiting_parent_does_not_leave_pipe_reader_blocked() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let start = Instant::now();
    let r = run("grandchild", 5000, 1024, &[]);
    assert_eq!(r.kind, "success");
    assert!(r.stdout.contains("grandchild"));
    assert!(start.elapsed().as_secs() < 5);
}
#[test]
fn cancellation_terminates_an_active_tree() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_semctx-gates-fixture"))
        .args(["cancel-supervisor", env!("CARGO_BIN_EXE_semctx-gates")])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "cancelled"
    );
}
#[cfg(windows)]
#[test]
fn preserves_windows_native_crash_code_as_failure() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let r = run("native-crash-code", 5000, 1024, &[]);
    assert_eq!(r.kind, "nonzero");
    assert_eq!(r.exit_code, Some(0xC0000005u32 as i32));
}
