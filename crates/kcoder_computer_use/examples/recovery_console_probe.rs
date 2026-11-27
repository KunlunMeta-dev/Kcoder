//! Native Windows acceptance: exercise the real scheduled recovery launch without desktop input.
//! Run through the GUI carrier in an interactive session, with an owned output directory.
#[cfg(windows)]
fn main() {
    use anyhow::{Context, Result, ensure};
    use kcoder_computer_use::windows_recovery_task;
    use std::{path::PathBuf, time::Duration};

    fn run() -> Result<()> {
        let args: Vec<_> = std::env::args_os().collect();
        if args.len() == 4 && args[1] == "--internal-desktop-recovery" {
            let marker = PathBuf::from(&args[2]);
            let no_console =
                unsafe { windows_sys::Win32::System::Console::GetConsoleWindow().is_null() };
            let temporary = marker.with_extension("tmp");
            std::fs::write(
                &temporary,
                serde_json::to_vec(&serde_json::json!({
                    "noConsole": no_console,
                    "pipe": args[3].to_str().context("invalid pipe argument")?,
                }))?,
            )?;
            std::fs::rename(temporary, marker)?;
            ensure!(no_console, "recovery allocated a console");
            return Ok(());
        }
        ensure!(
            args.len() == 2,
            "usage: recovery_console_probe OWNED_DIRECTORY"
        );
        let root = PathBuf::from(&args[1]);
        ensure!(
            root.is_absolute() && root.is_dir(),
            "owned directory required"
        );
        let marker = root.join("recovery-bootstrap.json");
        ensure!(!marker.exists(), "probe marker already exists");
        let pipe = format!(r"\\.\pipe\kcoder-desktop-{}", uuid::Uuid::new_v4());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let result = runtime.block_on(async {
            let launched =
                windows_recovery_task::start(&std::env::current_exe()?, &marker, &pipe).await;
            let checked = async {
                launched?;
                tokio::time::timeout(Duration::from_secs(10), async {
                    while !marker.is_file() {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                })
                .await?;
                let observed: serde_json::Value = serde_json::from_slice(&std::fs::read(&marker)?)?;
                ensure!(
                    observed["noConsole"] == true,
                    "recovery allocated a console"
                );
                ensure!(observed["pipe"] == pipe, "recovery arguments changed");
                Ok::<_, anyhow::Error>(())
            }
            .await;
            let cleanup = windows_recovery_task::unregister(&pipe).await;
            checked?;
            cleanup
        });
        std::fs::write(
            root.join("result.json"),
            serde_json::to_vec(&serde_json::json!({
                "passed": result.is_ok(), "error": result.as_ref().err().map(|error| format!("{error:#}")),
            }))?,
        )?;
        result
    }
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("recovery_console_probe requires an interactive Windows session");
    std::process::exit(1);
}
