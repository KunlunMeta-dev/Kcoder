//! Runs the real internal recovery entry in a separate scheduled process.
//! No worker, screenshot, clipboard or keyboard/mouse input is started.
#[cfg(windows)]
#[path = "../src/desktop_recovery.rs"]
mod desktop_recovery;

#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    use anyhow::ensure;
    use kcoder_computer_use::{
        recovery_bootstrap::RecoveryBootstrap, windows_pipe::PipeEndpoint, windows_recovery_task,
    };
    use std::{ffi::OsStr, path::Path, time::Duration};
    let args: Vec<_> = std::env::args_os().collect();
    if args
        .get(1)
        .is_some_and(|arg| arg == "--internal-desktop-recovery")
    {
        ensure!(args.len() == 4, "invalid recovery child invocation");
        return desktop_recovery::run(Path::new(&args[2]), args[3].to_str().unwrap());
    }
    ensure!(args.len() == 2, "output JSON path required");
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(async {
        let endpoint = PipeEndpoint::create()?;
        let bootstrap = RecoveryBootstrap::new(endpoint.name().into(), std::process::id())?;
        let task_name = windows_recovery_task::task_name(bootstrap.pipe())?;
        let temporary = kcoder_config::create_private_temp_dir("kcoder-desktop-recovery")?;
        let directory = kcoder_config::PrivateDirectory::open_existing(temporary.path())?;
        directory.atomic_replace(
            OsStr::new("recovery-bootstrap.json"),
            &bootstrap.encode_private()?,
        )?;
        let file = temporary.path().join("recovery-bootstrap.json");
        let launch =
            windows_recovery_task::start(&std::env::current_exe()?, &file, bootstrap.pipe()).await;
        let connected = match launch {
            Ok(()) => endpoint.accept_recovery(&bootstrap).await,
            Err(error) => Err(error),
        };
        let (pipe, peer) = match connected {
            Ok(value) => value,
            Err(error) => {
                let _ = windows_recovery_task::unregister(bootstrap.pipe()).await;
                return Err(error);
            }
        };
        ensure!(
            peer.process_id != std::process::id(),
            "recovery was not independent"
        );
        let session = peer.session_id;
        drop(pipe); // No Observe/Attach: end at startup authentication only.
        tokio::time::timeout(Duration::from_secs(20), peer.wait_for_exit())
            .await?
            .map_err(|_| anyhow::anyhow!("recovery exit could not be verified"))?;
        ensure!(!file.exists(), "private bootstrap was not consumed");
        let temporary_path = temporary.path().to_path_buf();
        drop(directory);
        drop(temporary);
        ensure!(
            !temporary_path.exists(),
            "private bootstrap directory was not removed"
        );
        Ok::<_, anyhow::Error>(
            serde_json::json!({"status":"passed", "independentProcess":true,
            "bootstrapConsumed":true,"temporaryDirectoryRemoved":true,"session":session,
            "taskName":task_name,"desktopInputSent":false}),
        )
    });
    let report = match &result {
        Ok(value) => value.clone(),
        Err(error) => {
            serde_json::json!({"status":"failed","error":format!("{error:#}"),"desktopInputSent":false})
        }
    };
    std::fs::write(&args[1], serde_json::to_vec_pretty(&report)?)?;
    result.map(|_| ())
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows interactive logon session required");
}
