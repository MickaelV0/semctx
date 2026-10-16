//! Test-only native wire peer. It deliberately exercises channel limits, not Semctx behavior.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::{
    io::{BufRead, Write},
    path::Path,
    process::Command,
    thread,
    time::Duration,
};
fn main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    match arguments.get(1).map(String::as_str) {
        Some("__exec-stream") => {
            let code = semctx_gates::process::helper_stream(&arguments[2..]).unwrap();
            std::process::exit(code);
        }
        Some("__exec") => {
            let code = semctx_gates::process::helper(&arguments[2..]).unwrap();
            std::process::exit(code);
        }
        Some("--heartbeat") => {
            let mut marker = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&arguments[2])
                .unwrap();
            loop {
                marker.write_all(b".").unwrap();
                marker.flush().unwrap();
                thread::sleep(Duration::from_millis(10));
            }
        }
        Some("--hang" | "setup") => {
            let marker = arguments
                .get(2)
                .filter(|arg| !arg.starts_with("--"))
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::current_exe()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .join("heartbeat")
                });
            let mut child = Command::new(std::env::current_exe().unwrap())
                .arg("--heartbeat")
                .arg(marker)
                .spawn()
                .unwrap();
            child.wait().unwrap();
            return;
        }
        Some("--cancel-cli" | "--cancel-mcp") => {
            semctx_gates::process::install_cancellation();
            let marker = std::path::PathBuf::from(&arguments[2]);
            let awaited = marker.clone();
            thread::spawn(move || {
                for _ in 0..300 {
                    if awaited.exists() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                semctx_gates::process::request_cancellation();
            });
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.arg("--hang").arg(&marker);
            let result = if arguments[1] == "--cancel-cli" {
                semctx_qualification::process::run(
                    &mut command,
                    Path::new("."),
                    Duration::from_secs(3),
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            } else {
                semctx_qualification::mcp::probe_initialize(&mut command, Path::new("."))
                    .map(|_| ())
            };
            match result {
                Err(error) if error.contains("cancelled") => println!("{error}"),
                other => panic!("cancellation was not refused: {other:?}"),
            }
            return;
        }
        _ => {}
    }
    let mut input = std::io::BufReader::new(std::io::stdin().lock());
    let delayed = arguments.iter().any(|arg| arg == "--delayed-request");
    if delayed {
        println!(
            "{}",
            serde_json::json!({"jsonrpc":"2.0","method":"notifications/ready"})
        );
        std::io::stdout().flush().unwrap();
        input.fill_buf().unwrap();
        thread::sleep(Duration::from_millis(600));
    }
    let crash = arguments.iter().any(|arg| arg == "--crash");
    let persistent = arguments.iter().any(|arg| arg == "--persist");
    let pipe_holder = arguments.iter().any(|arg| arg == "--pipe-holder");
    let crash_on_eof = arguments.iter().any(|arg| arg == "--crash-on-eof");
    let overflowing = std::env::args().any(|arg| arg == "--overflow");
    for line in input.lines() {
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
        if delayed {
            thread::sleep(Duration::from_millis(600));
        }
        println!(
            "{}",
            serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"native-wire-fixture"}}})
        );
        std::io::stdout().flush().unwrap();
        if arguments.iter().any(|arg| arg.starts_with("--backlog-")) {
            for sequence in 0..50 {
                println!(
                    "{}",
                    serde_json::json!({"jsonrpc":"2.0","method":"notifications/message","params":{"sequence":sequence}})
                );
            }
            if arguments.iter().any(|arg| arg == "--backlog-malformed") {
                println!("NOT JSON");
            }
            if arguments.iter().any(|arg| arg == "--backlog-overflow") {
                let bytes = serde_json::to_vec(&serde_json::json!({"jsonrpc":"2.0","method":"notifications/message","params":{"padding":"x".repeat(semctx_qualification::process::LIMIT as usize)}})).unwrap();
                let _ = std::io::stdout().write_all(&bytes);
                let _ = std::io::stdout().write_all(b"\n");
            }
            let _ = std::io::stdout().flush();
            return;
        }
        if crash {
            std::process::exit(42);
        }
    }
    if persistent {
        thread::sleep(Duration::from_secs(30));
    }
    if pipe_holder {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--persist")
            .spawn()
            .unwrap();
        child.wait().unwrap();
    }
    if crash_on_eof {
        std::process::exit(42);
    }
}
