#![cfg(test)]
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
fn full_suite_accepts_legitimate_output_and_refuses_excess() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let action = semctx_gates::receipt::local_verification("base", true, "", "gate", ".")
        .into_iter()
        .find(|action| action.label == "tests")
        .unwrap();
    let accepted = run("suite-output", 5000, action.output_cap, &["2097152"]);
    assert_eq!(accepted.kind, "success");
    assert_eq!(accepted.stdout_bytes, 2 * 1024 * 1024);
    assert_eq!(accepted.stderr_bytes, 2 * 1024 * 1024);
    assert_eq!(accepted.stdout_hash, semctx_gates::digest(&accepted.stdout));
    assert_eq!(accepted.stderr_hash, semctx_gates::digest(&accepted.stderr));
    let excess = (action.output_cap + 65536).to_string();
    let refused = run("suite-output", 5000, action.output_cap, &[&excess]);
    assert_eq!(refused.kind, "output_limit");
    assert_eq!(refused.stdout.len(), action.output_cap);
}

#[test]
fn live_progress_arrives_before_completion_and_stdout_remains_json() {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let marker = std::env::temp_dir().join(format!("semctx-live-progress-{}", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    let mut supervisor = Command::new(env!("CARGO_BIN_EXE_semctx-gates-fixture"))
        .args(["live-supervisor", env!("CARGO_BIN_EXE_semctx-gates")])
        .arg(&marker)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stderr = supervisor.stderr.take().unwrap();
    let (send, receive) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            send.send(line.unwrap()).unwrap();
        }
    });
    let progress = receive.recv_timeout(Duration::from_secs(2));
    std::fs::write(&marker, "complete").unwrap();
    let output = supervisor.wait_with_output().unwrap();
    reader.join().unwrap();
    std::fs::remove_file(marker).unwrap();
    assert_eq!(progress.unwrap(), "progress ready");
    assert!(output.status.success());
    let outcome: semctx_gates::process::Outcome = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(outcome.kind, "success");
    assert_eq!(outcome.stdout, "progress ready\n");
    assert_eq!(outcome.stderr, "progress finished\n");
    assert_eq!(outcome.stdout_hash, semctx_gates::digest(&outcome.stdout));
    assert_eq!(outcome.stderr_hash, semctx_gates::digest(&outcome.stderr));
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
