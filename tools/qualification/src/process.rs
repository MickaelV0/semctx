pub use semctx_gates::process::{OwnedChild, cancellation_requested};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt,
    io::{self, Read, Write},
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

#[derive(Debug)]
pub enum Error {
    Io {
        operation: &'static str,
        source: io::Error,
    },
    Supervisor(semctx_gates::process::ProcessError),
    MissingPipe(&'static str),
    InvalidArgument,
    MissingHelper,
    ReaderPanic(&'static str),
    CaptureFailed(&'static str),
    InvalidUtf8 {
        stream: &'static str,
        source: std::string::FromUtf8Error,
    },
    Json(serde_json::Error),
    Cancelled,
    OutputExceeded(&'static str),
}
impl Error {
    pub(crate) fn io(operation: &'static str, source: io::Error) -> Self {
        Self::Io { operation, source }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { operation, source } => write!(formatter, "{operation}: {source}"),
            Self::Supervisor(message) => write!(formatter, "process supervisor: {message}"),
            Self::MissingPipe(stream) => write!(formatter, "missing {stream}"),
            Self::InvalidArgument => formatter.write_str("non UTF-8 process argument"),
            Self::MissingHelper => {
                formatter.write_str("build the qualification binary before process tests")
            }
            Self::ReaderPanic(stream) => write!(formatter, "{stream} reader panicked"),
            Self::CaptureFailed(stream) => write!(formatter, "{stream} capture failed"),
            Self::InvalidUtf8 { stream, source } => {
                write!(formatter, "non UTF-8 {stream}: {source}")
            }
            Self::Json(source) => write!(formatter, "JSON write: {source}"),
            Self::Cancelled => formatter.write_str("qualification cancelled"),
            Self::OutputExceeded(stream) => write!(formatter, "{stream} output exceeded"),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::InvalidUtf8 { source, .. } => Some(source),
            Self::Json(source) => Some(source),
            Self::Supervisor(source) => Some(source),
            _ => None,
        }
    }
}

fn helper_path() -> Result<PathBuf, Error> {
    let exe = std::env::current_exe().map_err(|source| Error::io("current executable", source))?;
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
            .ok_or(Error::MissingHelper)?
            .join(format!(
                "semctx-qualification{}",
                std::env::consts::EXE_SUFFIX
            ));
        if !helper.is_file() {
            return Err(Error::MissingHelper);
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
pub fn spawn(command: &Command, cwd: &Path) -> Result<OwnedChild, Error> {
    if cancellation_requested() {
        return Err(Error::Cancelled);
    }
    let argv = std::iter::once(command.get_program())
        .chain(command.get_args())
        .map(|arg| {
            arg.to_str()
                .map(str::to_owned)
                .ok_or(Error::InvalidArgument)
        })
        .collect::<Result<Vec<_>, _>>()?;
    semctx_gates::process::spawn_owned_with_env(&argv, cwd, &exact_environment(), &helper_path()?)
        .map_err(Error::Supervisor)
}

pub struct Capture {
    stream: &'static str,
    failed: Arc<AtomicBool>,
    exceeded: Arc<AtomicBool>,
    reader: thread::JoinHandle<io::Result<Vec<u8>>>,
}
impl Capture {
    pub fn check(&self) -> Result<(), Error> {
        if self.exceeded.load(Ordering::SeqCst) {
            return Err(Error::OutputExceeded(self.stream));
        }
        if self.failed.load(Ordering::SeqCst) {
            return Err(Error::CaptureFailed(self.stream));
        }
        Ok(())
    }
    pub fn finish_checked(self) -> Result<Vec<u8>, Error> {
        let exceeded = self.exceeded.clone();
        let stream = self.stream;
        let bytes = self.finish()?;
        if exceeded.load(Ordering::SeqCst) {
            return Err(Error::OutputExceeded(stream));
        }
        Ok(bytes)
    }
    pub fn finish(self) -> Result<Vec<u8>, Error> {
        self.reader
            .join()
            .map_err(|_| Error::ReaderPanic(self.stream))?
            .map_err(|source| Error::io(self.stream, source))
    }
}
pub fn drain(mut stream: impl Read + Send + 'static, name: &'static str) -> Capture {
    let exceeded = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(false));
    let (reader_exceeded, reader_failed) = (exceeded.clone(), failed.clone());
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stream.by_ref().take(LIMIT + 1).read_to_end(&mut bytes);
        if bytes.len() as u64 > LIMIT {
            reader_exceeded.store(true, Ordering::SeqCst);
        }
        match result {
            Ok(_) => Ok(bytes),
            Err(error) => {
                reader_failed.store(true, Ordering::SeqCst);
                Err(error)
            }
        }
    });
    Capture {
        stream: name,
        exceeded,
        failed,
        reader,
    }
}
pub fn run(command: &mut Command, cwd: &Path, budget: Duration) -> Result<Observation, Error> {
    let started = Instant::now();
    let mut owned = spawn(command, cwd)?;
    drop(owned.take_stdin());
    let stdout = drain(
        owned.take_stdout().ok_or(Error::MissingPipe("stdout"))?,
        "stdout",
    );
    let stderr = drain(
        owned.take_stderr().ok_or(Error::MissingPipe("stderr"))?,
        "stderr",
    );
    let mut timed_out = false;
    let mut output_exceeded = false;
    let code = loop {
        if cancellation_requested() {
            break Err(Error::Cancelled);
        }
        if let Err(error) = stdout.check().and_then(|()| stderr.check()) {
            if matches!(error, Error::OutputExceeded(_)) {
                output_exceeded = true;
                break Ok(None);
            }
            break Err(error);
        }
        match owned.try_wait() {
            Ok(Some(status)) => break Ok(status.code()),
            Ok(None) => {}
            Err(source) => break Err(Error::io("wait for child", source)),
        }
        if started.elapsed() > budget {
            timed_out = true;
            break Ok(None);
        }
        thread::sleep(Duration::from_millis(10));
    };
    let cleanup = owned.cleanup().map_err(Error::Supervisor);
    output_exceeded |=
        stdout.exceeded.load(Ordering::SeqCst) || stderr.exceeded.load(Ordering::SeqCst);
    let stdout_exceeded = stdout.exceeded.clone();
    let stderr_exceeded = stderr.exceeded.clone();
    let stdout = stdout.finish();
    let stderr = stderr.finish();
    output_exceeded |=
        stdout_exceeded.load(Ordering::SeqCst) || stderr_exceeded.load(Ordering::SeqCst);
    cleanup?;
    let stdout = String::from_utf8(stdout?).map_err(|source| Error::InvalidUtf8 {
        stream: "stdout",
        source,
    })?;
    let stderr = String::from_utf8(stderr?).map_err(|source| Error::InvalidUtf8 {
        stream: "stderr",
        source,
    })?;
    Ok(Observation {
        code: code?,
        timed_out,
        output_exceeded,
        duration_ms: started.elapsed().as_millis(),
        stdout,
        stderr,
    })
}
pub fn write_json(writer: &mut impl Write, value: &serde_json::Value) -> Result<(), Error> {
    serde_json::to_writer(&mut *writer, value).map_err(Error::Json)?;
    writer
        .write_all(b"\n")
        .and_then(|()| writer.flush())
        .map_err(|source| Error::io("write JSON", source))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    struct InterruptedCapture(bool);
    impl Read for InterruptedCapture {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            if self.0 {
                return Err(std::io::Error::other("injected read failure"));
            }
            self.0 = true;
            bytes[..2].copy_from_slice(b"{}");
            Ok(2)
        }
    }
    #[test]
    fn partial_capture_is_not_returned_as_complete_after_read_error() {
        let captured = drain(InterruptedCapture(false), "stdout")
            .finish()
            .unwrap_err();
        assert!(matches!(
            captured,
            Error::Io {
                operation: "stdout",
                ..
            }
        ));
        assert_eq!(
            std::error::Error::source(&captured).unwrap().to_string(),
            "injected read failure"
        );
    }
}
