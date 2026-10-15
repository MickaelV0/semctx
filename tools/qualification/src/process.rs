pub use semctx_gates::process::OwnedChild;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

pub const LIMIT: u64 = 8 * 1024 * 1024;
pub const BUDGET: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub code: Option<i32>,
    pub timed_out: bool,
    pub output_exceeded: bool,
    pub duration_ms: u128,
    pub stdout: String,
    pub stderr: String,
}

fn helper_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Cargo's test binaries live in deps/. The normal executable is built for the
    // integration tests; never invoke Cargo or resolve a global helper here.
    if exe
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|p| p == "deps")
    {
        let helper = exe
            .parent()
            .and_then(Path::parent)
            .ok_or("missing test binary parent")?
            .join(format!(
                "semctx-qualification{}",
                std::env::consts::EXE_SUFFIX
            ));
        if !helper.is_file() {
            return Err("build the qualification binary before process tests".into());
        }
        Ok(helper)
    } else {
        Ok(exe)
    }
}
fn exact_environment() -> BTreeMap<String, String> {
    let mut environment = [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "PATHEXT",
    ]
    .iter()
    .filter_map(|key| {
        std::env::var(key)
            .ok()
            .map(|value| ((*key).to_string(), value))
    })
    .collect::<BTreeMap<_, _>>();
    for (key, value) in [
        ("NO_COLOR", "1"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        (
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        ),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("SEMCTX_ROOT", ""),
    ] {
        environment.insert(key.into(), value.into());
    }
    environment
}

/// Only the gate crate's acknowledged process ownership primitive is reused here.
/// No gate planning, product oracle or acceptance policy is delegated to that crate.
pub fn spawn(command: &Command, cwd: &Path) -> Result<OwnedChild, String> {
    let argv = std::iter::once(command.get_program())
        .chain(command.get_args())
        .map(|arg| {
            arg.to_str()
                .map(str::to_owned)
                .ok_or("non UTF-8 process argument".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    semctx_gates::process::spawn_owned_with_env(&argv, cwd, &exact_environment(), &helper_path()?)
}

pub fn drain(
    mut stream: impl Read + Send + 'static,
    exceeded: Arc<AtomicBool>,
) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stream.by_ref().take(LIMIT + 1).read_to_end(&mut bytes);
        if bytes.len() as u64 > LIMIT {
            exceeded.store(true, Ordering::SeqCst);
        }
        bytes
    })
}
pub fn run(command: &mut Command, cwd: &Path, budget: Duration) -> Result<Observation, String> {
    let started = Instant::now();
    let mut owned = spawn(command, cwd)?;
    drop(owned.child.stdin.take());
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout = drain(
        owned.child.stdout.take().ok_or("missing stdout")?,
        exceeded.clone(),
    );
    let stderr = drain(
        owned.child.stderr.take().ok_or("missing stderr")?,
        exceeded.clone(),
    );
    let mut timed_out = false;
    let code = loop {
        if let Some(status) = owned.child.try_wait().map_err(|e| e.to_string())? {
            break status.code();
        }
        if started.elapsed() > budget || exceeded.load(Ordering::SeqCst) {
            timed_out = started.elapsed() > budget;
            owned.kill();
            break None;
        }
        thread::sleep(Duration::from_millis(10));
    };
    owned.cleanup()?;
    let stdout = String::from_utf8(stdout.join().map_err(|_| "stdout reader panicked")?)
        .map_err(|_| "non UTF-8 stdout")?;
    let stderr = String::from_utf8(stderr.join().map_err(|_| "stderr reader panicked")?)
        .map_err(|_| "non UTF-8 stderr")?;
    Ok(Observation {
        code,
        timed_out,
        output_exceeded: exceeded.load(Ordering::SeqCst),
        duration_ms: started.elapsed().as_millis(),
        stdout,
        stderr,
    })
}
pub fn write_json(writer: &mut impl Write, value: &serde_json::Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, value).map_err(|e| e.to_string())?;
    writer
        .write_all(b"\n")
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())
}
