use crate::{
    journeys::{self, Runner},
    json, process,
};
use serde_json::{Value, json as j};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::Path,
    process::ChildStdin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
    },
    thread,
};

struct Session {
    child: process::OwnedChild,
    input: ChildStdin,
    output: Receiver<Result<Value, String>>,
    stderr_exceeded: Arc<AtomicBool>,
    stderr_reader: Option<thread::JoinHandle<Vec<u8>>>,
    id: u64,
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}
impl Session {
    fn start(runner: &Runner, root: &Path) -> Result<Self, String> {
        let mut command = runner.runtime.command(&runner.mcp);
        Self::start_command(&mut command, root)
    }
    fn start_command(command: &mut std::process::Command, root: &Path) -> Result<Self, String> {
        let mut child = process::spawn(command, root)?;
        let input = child.child.stdin.take().ok_or("missing MCP stdin")?;
        let stdout = child.child.stdout.take().ok_or("missing MCP stdout")?;
        let stderr = child.child.stderr.take().ok_or("missing MCP stderr")?;
        let (tx, output) = mpsc::sync_channel(32);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut total = 0u64;
            loop {
                let mut bytes = Vec::new();
                let read = reader
                    .by_ref()
                    .take(process::LIMIT + 1)
                    .read_until(b'\n', &mut bytes);
                total += bytes.len() as u64;
                let message = match read {
                    Ok(0) => break,
                    Ok(_) if total > process::LIMIT => Err("MCP wire output exceeded".into()),
                    Ok(_) => {
                        serde_json::from_slice(&bytes).map_err(|e| format!("MCP invalid JSON: {e}"))
                    }
                    Err(e) => Err(e.to_string()),
                };
                let failed = message.is_err();
                if tx.send(message).is_err() || failed {
                    break;
                }
            }
        });
        let exceeded = Arc::new(AtomicBool::new(false));
        let stderr_reader = process::drain(stderr, exceeded.clone());
        Ok(Self {
            child,
            input,
            output,
            stderr_exceeded: exceeded,
            stderr_reader: Some(stderr_reader),
            id: 0,
        })
    }
    fn check_stderr(&self) -> Result<(), String> {
        if self.stderr_exceeded.load(Ordering::SeqCst) {
            Err("MCP stderr output exceeded".into())
        } else {
            Ok(())
        }
    }
    fn finish(&mut self) -> Result<(), String> {
        self.child.cleanup()?;
        if let Some(reader) = self.stderr_reader.take() {
            reader.join().map_err(|_| "MCP stderr reader panicked")?;
        }
        self.check_stderr()
    }
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.check_stderr()?;
        self.id += 1;
        let id = self.id;
        process::write_json(
            &mut self.input,
            &j!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        )?;
        let started = std::time::Instant::now();
        loop {
            self.check_stderr()?;
            let remaining = process::BUDGET
                .checked_sub(started.elapsed())
                .ok_or("MCP deadline exceeded")?;
            let value = match self
                .output
                .recv_timeout(remaining.min(std::time::Duration::from_millis(50)))
            {
                Ok(value) => value?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(error) => {
                    self.check_stderr()?;
                    return Err(format!("MCP wire: {error}"));
                }
            };
            self.check_stderr()?;
            if value["id"] != id {
                if value.get("id").is_some() {
                    return Err("unexpected MCP response identity".into());
                }
                continue;
            }
            if value["jsonrpc"] != "2.0" || value.get("error").is_some() {
                return Err(format!("MCP protocol error {value}"));
            }
            return value
                .get("result")
                .cloned()
                .ok_or("MCP response lacks result".into());
        }
    }
    fn tool(&mut self, name: &str, args: Value) -> Result<Value, String> {
        let value = self.request("tools/call", j!({"name":name,"arguments":args}))?;
        if value["isError"] == true {
            return Err(format!("MCP tool refused {value}"));
        }
        if let Some(structured) = value.get("structuredContent") {
            return Ok(structured.clone());
        }
        let text = value["content"]
            .as_array()
            .ok_or("MCP missing content")?
            .iter()
            .find(|c| c["type"] == "text")
            .and_then(|c| c["text"].as_str())
            .ok_or("MCP missing JSON text")?;
        serde_json::from_str(text).map_err(|e| e.to_string())
    }
}

/// Probe the same supervised stdio initialization path used by product qualification.
pub fn probe_initialize(command: &mut std::process::Command, root: &Path) -> Result<Value, String> {
    let mut session = Session::start_command(command, root)?;
    let result=session.request("initialize",j!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"qualification-probe","version":"1"}}))?;
    session.finish()?;
    Ok(result)
}

fn symbol(value: &Value, name: &str) -> bool {
    value["matchedNodes"]
        .as_array()
        .is_some_and(|nodes| nodes.iter().any(|n| n["name"] == name))
}

pub fn run(runner: &mut Runner, root: &Path) -> Result<(), String> {
    let mut session = Session::start(runner, root)?;
    let initialized = session.request("initialize",j!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"semctx-rust-qualification","version":"1.0.0"}}))?;
    let raw = runner.record("mcp-initialize", &initialized)?;
    runner.case(
        "mcp.initialize",
        "supported",
        raw,
        if initialized["protocolVersion"].is_string()
            && initialized["serverInfo"]["name"].is_string()
        {
            Ok(())
        } else {
            Err("missing MCP negotiation".into())
        },
        false,
    );
    process::write_json(
        &mut session.input,
        &j!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )?;
    let tools = session.request("tools/list", j!({}))?;
    let raw = runner.record("mcp-tools", &tools)?;
    let names = tools["tools"].as_array().ok_or("missing tool inventory")?;
    runner.case(
        "mcp.tools",
        "supported",
        raw,
        if [
            "semctx_inspect",
            "semctx_control_status",
            "semctx_index_health",
        ]
        .iter()
        .all(|name| names.iter().any(|n| n["name"] == *name))
        {
            Ok(())
        } else {
            Err("required functional tools absent".into())
        },
        false,
    );
    let status = session.tool("semctx_control_status", j!({"repositoryRoot":root}))?;
    let raw = runner.record("mcp-control-status", &status)?;
    runner.case(
        "mcp.control-status",
        "supported",
        raw,
        if status["verdict"] == "FRESH" && status["canRunHighRiskControl"] == true {
            Ok(())
        } else {
            Err(format!("MCP control not fresh: {status}"))
        },
        false,
    );
    let old = session.tool(
        "semctx_inspect",
        j!({"repositoryRoot":root,"query":"oldSymbol","kind":"symbol"}),
    )?;
    let health = session.tool("semctx_index_health", j!({"repositoryRoot":root}))?;
    let raw = runner.record("mcp-inspect", &j!({"inspect":old,"health":health}))?;
    runner.case(
        "mcp.inspect",
        "supported",
        raw,
        if symbol(&old, "oldSymbol") && health["binding"]["status"] == "valid" {
            Ok(())
        } else {
            Err("MCP did not inspect frozen indexed symbol".into())
        },
        false,
    );

    // Keep the same child and connection alive while a separate CLI rebuild replaces facts.
    fs::remove_file(root.join("src/symbol.ts")).map_err(|e| e.to_string())?;
    journeys::write(
        root,
        "src/new.ts",
        "export function newSymbol(): number {\n  return 2;\n}\n",
    )?;
    journeys::commit(root)?;
    runner.index(root)?;
    let new_old = session.tool(
        "semctx_inspect",
        j!({"repositoryRoot":root,"query":"oldSymbol","kind":"symbol"}),
    )?;
    let new = session.tool(
        "semctx_inspect",
        j!({"repositoryRoot":root,"query":"newSymbol","kind":"symbol"}),
    )?;
    let new_health = session.tool("semctx_index_health", j!({"repositoryRoot":root}))?;
    let raw = runner.record(
        "mcp-refresh",
        &j!({"pid":session.child.child.id(),"old":new_old,"new":new,"health":new_health}),
    )?;
    runner.case(
        "mcp.refresh",
        "supported",
        raw,
        if !symbol(&new_old, "oldSymbol")
            && symbol(&new, "newSymbol")
            && new_health["binding"]["status"] == "valid"
        {
            Ok(())
        } else {
            Err("same MCP process retained stale facts".into())
        },
        false,
    );
    session.finish()?;
    // Verify a useful CLI query after the same external rebuild as a final transport cross-check.
    let (ob, _) = runner.cli(root, &["inspect", "symbol", "newSymbol", "--json"])?;
    let result = json(&ob, 0)?;
    if !symbol(&result, "newSymbol") {
        return Err("CLI refresh result lost the new symbol".into());
    }
    Ok(())
}
