//! Fixed internal OS-service entry. Arguments locate an already signed native lease.
use super::diagnostics::{self, Stage};
use anyhow::{Context, Result, ensure};
use std::ffi::OsString;

pub(crate) const NATIVE_CODE_SERVICE_ENTRY: &str = "--internal-native-code-service-v1";

pub(crate) fn try_run(arguments: &[OsString]) -> Option<Result<()>> {
    if let Some(result) = super::manager::try_run(arguments) {
        return Some(result);
    }
    if arguments
        .get(1)
        .is_none_or(|argument| argument != NATIVE_CODE_SERVICE_ENTRY)
    {
        return None;
    }
    Some(run(arguments))
}
#[cfg(target_os = "linux")]
fn run(arguments: &[OsString]) -> Result<()> {
    ensure!(
        (5..=6).contains(&arguments.len()),
        "NATIVE_CODE_SERVICE_ENTRY_INVALID"
    );
    let mut ready = if let Some(raw) = arguments.get(5) {
        use std::os::fd::FromRawFd;
        let fd = raw
            .to_str()
            .and_then(|value| value.parse::<i32>().ok())
            .context("NATIVE_CODE_READY_PIPE_INVALID")?;
        ensure!((3..=1024).contains(&fd), "NATIVE_CODE_READY_PIPE_INVALID");
        let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
        ensure!(
            unsafe { libc::fstat(fd, &mut metadata) } == 0
                && metadata.st_mode & libc::S_IFMT == libc::S_IFIFO,
            "NATIVE_CODE_READY_PIPE_INVALID"
        );
        ensure!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == 0,
            "NATIVE_CODE_READY_PIPE_INVALID"
        );
        // SAFETY: the private launcher owns and transfers this inherited pipe.
        Some(unsafe { std::fs::File::from_raw_fd(fd) })
    } else {
        None
    };
    let profile = std::path::PathBuf::from(&arguments[2]);
    let workspace = std::path::PathBuf::from(&arguments[3]);
    let id = arguments[4]
        .to_str()
        .context("NATIVE_CODE_SERVICE_ENTRY_INVALID")?;
    ensure!(
        profile.is_absolute() && workspace.is_absolute() && !id.is_empty() && id.len() <= 256,
        "NATIVE_CODE_SERVICE_ENTRY_INVALID"
    );
    kcoder_native_scope::service_identity::verify_current_unix_account()?;
    let result = diagnostics::at(Stage::WorkerEntry, || {
        kcoder_config::PrivateDirectory::open_existing(&profile)?.verify_private_directory()?;
        // SAFETY: the synchronous entry has not created threads; locators remain
        // original signed source data, never caller authority.
        unsafe {
            std::env::set_var("KCODER_CONFIG_DIR", &profile);
            std::env::remove_var("KCODER_HISTORY_DIR");
        }
        std::env::set_current_dir(&workspace)?;
        let owner = diagnostics::mark(
            Stage::OwnerOpen,
            super::NativeCodeServiceOwner::open_existing(&profile, &workspace, id),
        )?;
        let result = diagnostics::mark(
            Stage::RuntimeWorker,
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?
                .block_on(super::worker::run(owner.clone(), &mut ready)),
        );
        let stopped = diagnostics::mark(Stage::OwnerStopped, owner.record_stopped_after_cleanup());
        result?;
        stopped
    });
    if let Err(error) = &result
        && let Some(mut pipe) = ready.take()
        && let Ok(mut bytes) =
            serde_json::to_vec(&serde_json::json!({"error":diagnostics::describe(error)}))
        && bytes.len() <= 8192
    {
        use std::io::Write;
        bytes.push(b'\n');
        let _ = pipe.write_all(&bytes);
    }
    result
}
#[cfg(not(target_os = "linux"))]
fn run(_arguments: &[OsString]) -> Result<()> {
    anyhow::bail!("SERVICE_NATIVE_PLATFORM_UNSUPPORTED")
}
