//! Bounded process-tree ownership. This is lifecycle control, not a sandbox.
use crate::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

static CANCELLED: AtomicBool = AtomicBool::new(false);
pub fn request_cancellation() {
    CANCELLED.store(true, Ordering::SeqCst);
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outcome {
    pub kind: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub stdout_hash: String,
    pub stderr_hash: String,
}
struct Capture {
    bytes: Vec<u8>,
    count: u64,
    hash: sha2::Sha256,
    error: bool,
}
impl Capture {
    fn new() -> Self {
        use sha2::Digest;
        Self {
            bytes: vec![],
            count: 0,
            hash: sha2::Sha256::new(),
            error: false,
        }
    }
}
fn drain(
    mut reader: impl Read + Send + 'static,
    cap: usize,
) -> (Arc<Mutex<Capture>>, thread::JoinHandle<()>) {
    use sha2::Digest;
    let data = Arc::new(Mutex::new(Capture::new()));
    let result = data.clone();
    let handle = thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let mut d = data.lock().unwrap();
                    d.count += n as u64;
                    d.hash.update(&buffer[..n]);
                    let keep = n.min(cap.saturating_sub(d.bytes.len()));
                    d.bytes.extend_from_slice(&buffer[..keep]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    data.lock().unwrap().error = true;
                    break;
                }
            }
        }
    });
    (result, handle)
}

#[cfg(unix)]
struct Tree {
    group: i32,
}
#[cfg(unix)]
impl Tree {
    fn attach(child: &Child) -> Result<Self> {
        Ok(Self {
            group: child.id() as i32,
        })
    }
    fn kill(&self) {
        unsafe {
            libc::kill(-self.group, libc::SIGKILL);
        }
    }
}
#[cfg(unix)]
impl Drop for Tree {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(windows)]
struct Tree {
    job: windows_sys::Win32::Foundation::HANDLE,
}
#[cfg(windows)]
impl Tree {
    fn attach(child: &Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(format!(
                    "CreateJobObject: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(format!("assign JobObject: {error}"));
            }
            Ok(Self { job })
        }
    }
    fn kill(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 124);
        }
    }
}
#[cfg(windows)]
impl Drop for Tree {
    fn drop(&mut self) {
        self.kill();
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

pub fn install_cancellation() {
    #[cfg(unix)]
    unsafe {
        extern "C" fn handler(_: i32) {
            CANCELLED.store(true, Ordering::SeqCst);
        }
        libc::signal(libc::SIGINT, handler as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, handler as *const () as libc::sighandler_t);
    }
    #[cfg(windows)]
    unsafe {
        unsafe extern "system" fn handler(event: u32) -> i32 {
            if event == 0 || event == 1 {
                CANCELLED.store(true, Ordering::SeqCst);
                1
            } else {
                0
            }
        }
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(handler), 1);
    }
}

// The helper cannot execute the requested command until its parent has assigned its process tree.
pub fn helper(argv: &[String]) -> Result<i32> {
    helper_mode(argv, false)
}

/// Internal executable entrypoint for streaming transports. The parent owns the helper's
/// process tree before sending the acknowledgement, so no product process can escape the
/// Windows job assignment race. stdin's persistent buffer retains bytes read with the ACK.
pub fn helper_stream(argv: &[String]) -> Result<i32> {
    helper_mode(argv, true)
}

fn helper_mode(argv: &[String], streaming: bool) -> Result<i32> {
    let mut ack = [0u8; 1];
    std::io::stdin()
        .read_exact(&mut ack)
        .map_err(|e| e.to_string())?;
    if ack != [b'!'] {
        return Err("missing supervisor acknowledgement".into());
    }
    let (program, args) = argv.split_first().ok_or("empty command")?;
    let mut child = Command::new(program)
        .args(args)
        .stdin(if streaming {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .spawn()
        .map_err(|e| e.to_string())?;
    if streaming {
        let mut input = child.stdin.take().ok_or("missing streaming stdin")?;
        // Stdin owns one shared BufReader. Taking its lock in this thread preserves any
        // protocol bytes prefetched while reading the ACK in the calling thread.
        thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut input);
        });
        // Do not join an input thread waiting for EOF when the real child has already exited.
        // The helper's exit closes that thread and the owned process tree contains its child.
    }
    finish_status(child.wait().map_err(|e| e.to_string())?)
}

fn finish_status(status: ExitStatus) -> Result<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            // Preserve signal termination through the helper rather than converting a crash
            // into an ordinary success or expected refusal.
            unsafe {
                libc::signal(signal, libc::SIG_DFL);
                libc::raise(signal);
            }
            return Err(format!("child terminated by signal {signal}"));
        }
    }
    Ok(status.code().unwrap_or(125))
}

/// An acknowledged process with lifetime ownership. Call cleanup before joining pipe readers;
/// a descendant may retain a pipe after the direct child exits. This is not a sandbox.
pub struct OwnedChild {
    pub child: Child,
    tree: Tree,
}

impl OwnedChild {
    pub fn kill(&self) {
        self.tree.kill();
    }
    pub fn cleanup(&mut self) -> Result<()> {
        self.kill();
        self.child.wait().map(|_| ()).map_err(|e| e.to_string())
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

pub fn spawn_owned(
    argv: &[String],
    root: &Path,
    env: Option<&BTreeMap<String, String>>,
    helper_path: &Path,
) -> Result<OwnedChild> {
    spawn_owned_mode(argv, root, env, helper_path, true, false)
}

/// Launch with exactly the supplied environment (plus no inherited variables). The caller
/// owns explicit Git configuration isolation; no host Git/GCM variables are imported.
pub fn spawn_owned_with_env(
    argv: &[String],
    root: &Path,
    exact_env: &BTreeMap<String, String>,
    helper_path: &Path,
) -> Result<OwnedChild> {
    spawn_owned_mode(argv, root, Some(exact_env), helper_path, true, true)
}

fn spawn_owned_mode(
    argv: &[String],
    root: &Path,
    env: Option<&BTreeMap<String, String>>,
    helper_path: &Path,
    streaming: bool,
    exact_env: bool,
) -> Result<OwnedChild> {
    if argv.is_empty() {
        return Err("empty owned command".into());
    }
    let mut command = Command::new(helper_path);
    command
        .arg(if streaming { "__exec-stream" } else { "__exec" })
        .args(argv)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if exact_env {
        command.env_clear();
    }
    if let Some(env) = env {
        command.envs(env);
    }
    let mut keys = std::env::vars_os().map(|(key, _)| key).collect::<Vec<_>>();
    if let Some(env) = env {
        keys.extend(env.keys().map(std::ffi::OsString::from));
    }
    for key in keys.into_iter().filter(|_| !exact_env) {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if name == "GIT" || name.starts_with("GIT_") || name.starts_with("GCM_") {
            command.env_remove(key);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000200 | 0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("spawn supervisor: {e}"))?;
    let tree = match Tree::attach(&child) {
        Ok(tree) => tree,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let mut owned = OwnedChild { child, tree };
    // This is the only release point. On attach failure the helper is killed without an ACK.
    owned
        .child
        .stdin
        .as_mut()
        .ok_or("missing supervisor stdin")?
        .write_all(b"!")
        .map_err(|e| format!("supervisor acknowledgement: {e}"))?;
    if !streaming {
        drop(owned.child.stdin.take());
    }
    Ok(owned)
}

pub fn run(argv: &[String], root: &Path, timeout_ms: u64, cap: usize) -> Result<Outcome> {
    run_with_helper(
        argv,
        root,
        timeout_ms,
        cap,
        &std::env::current_exe().map_err(|e| e.to_string())?,
    )
}

pub fn run_with_helper(
    argv: &[String],
    root: &Path,
    timeout_ms: u64,
    cap: usize,
    executable: &Path,
) -> Result<Outcome> {
    if argv.is_empty() || timeout_ms == 0 || cap == 0 {
        return Err("invalid process budget/command".into());
    }
    let start = Instant::now();
    let mut owned = spawn_owned_mode(argv, root, None, executable, false, false)?;
    let child = &mut owned.child;
    let tree = &owned.tree;
    let (out, out_thread) = drain(child.stdout.take().ok_or("missing stdout")?, cap);
    let (err, err_thread) = drain(child.stderr.take().ok_or("missing stderr")?, cap);
    let mut kind = "success";
    let exit_code;
    loop {
        if CANCELLED.load(Ordering::SeqCst) {
            kind = "cancelled";
            tree.kill();
        } else if start.elapsed() >= Duration::from_millis(timeout_ms) {
            kind = "timeout";
            tree.kill();
        } else if out.lock().unwrap().count > cap as u64 || err.lock().unwrap().count > cap as u64 {
            kind = "output_limit";
            tree.kill();
        }
        if kind != "success" {
            exit_code = child.wait().ok().and_then(|s| s.code());
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                if exit_code != Some(0) {
                    kind = "nonzero";
                }
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(_) => {
                kind = "wait_error";
                tree.kill();
                exit_code = child.wait().ok().and_then(|s| s.code());
                break;
            }
        }
    }
    // Descendants may retain inherited pipes after the direct process exits. Terminate the tree
    // before joining readers; joining first would make a timeout itself hang indefinitely.
    tree.kill();
    let out_failure = out_thread.join().is_err();
    let err_failure = err_thread.join().is_err();
    let reader_failure = out_failure || err_failure;
    use sha2::Digest;
    let out = out.lock().unwrap();
    let err = err.lock().unwrap();
    if out.count > cap as u64 || err.count > cap as u64 {
        kind = "output_limit";
    } else if reader_failure || out.error || err.error {
        kind = "capture_error";
    } else if std::str::from_utf8(&out.bytes).is_err() || std::str::from_utf8(&err.bytes).is_err() {
        kind = "malformed_output";
    }
    Ok(Outcome {
        kind: kind.into(),
        exit_code,
        duration_ms: start.elapsed().as_millis() as u64,
        stdout: String::from_utf8_lossy(&out.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&err.bytes).into_owned(),
        stdout_bytes: out.count,
        stderr_bytes: err.count,
        stdout_hash: format!("{:x}", out.hash.clone().finalize()),
        stderr_hash: format!("{:x}", err.hash.clone().finalize()),
    })
}
