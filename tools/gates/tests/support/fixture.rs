use std::{io::Write, process::Command, thread, time::Duration};
#[allow(clippy::zombie_processes)] // The orphan is intentional: the supervisor must reap/kill its tree.
fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("success") => {
            println!("fixture stdout");
            eprintln!("fixture stderr");
        }
        Some("nonzero") => std::process::exit(7),
        #[cfg(windows)]
        Some("native-crash-code") => unsafe {
            windows_sys::Win32::System::Threading::ExitProcess(0xC0000005);
        },
        Some("overflow") => {
            let bytes = vec![b'x'; 1024 * 1024];
            let _ = std::io::stdout().write_all(&bytes);
        }
        Some("malformed") => {
            let _ = std::io::stdout().write_all(&[255]);
        }
        Some("stdin-roundtrip") => {
            use std::io::{BufRead, Write};
            for line in std::io::stdin().lock().lines() {
                println!("{}", line.unwrap());
                std::io::stdout().flush().unwrap();
            }
        }
        Some("write-marker") => {
            std::fs::write(std::env::args().nth(2).unwrap(), "launched").unwrap();
        }
        Some("env-probe") => {
            println!(
                "{}",
                std::env::var("SEMCTX_TEST_EXACT_VALUE").unwrap_or_default()
            );
            println!(
                "git={}",
                std::env::var("GIT_CONFIG_GLOBAL").unwrap_or_default()
            );
            println!("home={}", std::env::var("USERPROFILE").unwrap_or_default());
        }
        Some("sleep") => thread::sleep(Duration::from_secs(30)),
        Some("cancel-supervisor") => {
            semctx_gates::process::install_cancellation();
            let helper = std::env::args().nth(2).unwrap();
            thread::spawn(|| {
                thread::sleep(Duration::from_millis(250));
                #[cfg(unix)]
                unsafe {
                    libc::raise(libc::SIGINT);
                }
                #[cfg(windows)]
                semctx_gates::process::request_cancellation();
            });
            let argv = vec![
                std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                "sleep".into(),
            ];
            let result = semctx_gates::process::run_with_helper(
                &argv,
                &std::env::current_dir().unwrap(),
                5000,
                1024,
                std::path::Path::new(&helper),
            )
            .unwrap();
            println!("{}", result.kind);
        }
        Some("grandchild") => {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .arg("sleep")
                .spawn()
                .unwrap();
            println!("grandchild {}", child.id());
            std::io::stdout().flush().unwrap();
            if std::env::args().nth(2).as_deref() == Some("wait") {
                let _ = child.wait();
            }
        }
        _ => panic!("unknown fixture mode"),
    }
}
