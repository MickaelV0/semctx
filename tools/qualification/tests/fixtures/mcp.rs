//! Test-only native wire peer. It deliberately exercises channel limits, not Semctx behavior.
use std::io::{BufRead, Write};
fn main() {
    let overflowing = std::env::args().any(|arg| arg == "--overflow");
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let request: serde_json::Value = serde_json::from_str(&line).expect("fixture request JSON");
        if request.get("id").is_none() {
            continue;
        }
        let bytes = if overflowing {
            vec![b'x'; semctx_qualification::process::LIMIT as usize + 1024]
        } else {
            b"fixture diagnostic\n".to_vec()
        };
        let _ = std::io::stderr().write_all(&bytes);
        println!(
            "{}",
            serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"native-wire-fixture"}}})
        );
        std::io::stdout().flush().unwrap();
    }
}
