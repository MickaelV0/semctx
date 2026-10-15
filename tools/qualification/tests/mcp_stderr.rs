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
