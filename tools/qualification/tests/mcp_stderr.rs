#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::process::Command;
#[test]
fn valid_mcp_peer_with_bounded_stderr_is_accepted() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    let result = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap();
    assert_eq!(result["serverInfo"]["name"], "native-wire-fixture");
}
#[test]
fn valid_mcp_reply_cannot_hide_stderr_overflow() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--overflow");
    let error = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap_err();
    assert!(error.contains("MCP stderr output exceeded"), "{error}");
}

#[test]
fn valid_last_reply_cannot_hide_a_nonzero_mcp_exit() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--crash");
    let error = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap_err();
    assert!(error.contains("42"), "{error}");
}
#[test]
fn mcp_shutdown_observes_the_status_after_stdin_eof() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--crash-on-eof");
    let error = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap_err();
    assert!(error.contains("42"), "{error}");
}

#[test]
fn persistent_mcp_and_inherited_pipe_holders_are_stopped_within_a_bounded_shutdown() {
    for mode in ["--persist", "--pipe-holder"] {
        let root = tempfile::tempdir().unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
        command.arg(mode);
        let started = std::time::Instant::now();
        let value = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap();
        assert_eq!(value["serverInfo"]["name"], "native-wire-fixture");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "{mode}"
        );
    }
}

#[test]
fn valid_notifications_beyond_the_channel_capacity_are_drained_at_shutdown() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--backlog-valid");
    let result = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap();
    assert_eq!(result["serverInfo"]["name"], "native-wire-fixture");
}

#[test]
fn a_full_notification_channel_cannot_hide_trailing_invalid_json() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--backlog-malformed");
    let error = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap_err();
    assert!(error.contains("MCP invalid JSON"), "{error}");
}

#[test]
fn a_full_notification_channel_cannot_hide_trailing_wire_overflow() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--backlog-overflow");
    let started = std::time::Instant::now();
    let error = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap_err();
    assert!(error.contains("MCP wire output exceeded"), "{error}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}
