//! The original local desktop's launch context, used only after offline completion.
use anyhow::{Context, Result, ensure};
use kcoder_types::{
    StorageLaunchIntent, StorageMigrationDisposition, StorageMigrationPhase,
    StorageMigrationReceipt,
};
use serde::Deserialize;
use std::{
    path::PathBuf,
    process::{Command, Stdio},
};

pub(super) const DESKTOP_RELAUNCH_ENV: &str = "KCODER_STORAGE_DESKTOP_RELAUNCH_V1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DesktopRelaunch {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
}

impl DesktopRelaunch {
    /// Capture before recording readiness, so an invalid context cannot end the UI.
    /// This private host fact is not accepted from a plan, RPC or model request.
    pub(super) fn capture(intent: StorageLaunchIntent) -> Result<Option<Self>> {
        if intent != StorageLaunchIntent::Desktop {
            return Ok(None);
        }
        let value =
            std::env::var_os(DESKTOP_RELAUNCH_ENV).context("STORAGE_DESKTOP_RELAUNCH_REQUIRED")?;
        let value = value.to_str().context("STORAGE_DESKTOP_RELAUNCH_INVALID")?;
        ensure!(value.len() <= 65536, "STORAGE_DESKTOP_RELAUNCH_INVALID");
        let launch: Self =
            serde_json::from_str(value).context("STORAGE_DESKTOP_RELAUNCH_INVALID")?;
        ensure!(
            launch.cwd.is_absolute()
                && launch.cwd.is_dir()
                && launch.args.len() <= 16
                && launch.args.iter().all(|arg| !arg.contains('\0')),
            "STORAGE_DESKTOP_RELAUNCH_INVALID"
        );
        kcoder_host_transport::process::verify_program_path(&launch.program)
            .context("STORAGE_DESKTOP_RELAUNCH_INVALID")?;
        Ok(Some(launch))
    }

    /// The phase driver has returned and dropped its coordinator before this call.
    /// Starting the application is separate from the already completed migration.
    pub(super) fn start(self, receipt: &StorageMigrationReceipt) -> Result<()> {
        ensure!(
            receipt.plan.launch_intent == StorageLaunchIntent::Desktop
                && receipt.phase == StorageMigrationPhase::Verified
                && receipt.disposition == StorageMigrationDisposition::Complete,
            "STORAGE_DESKTOP_RELAUNCH_NOT_READY"
        );
        let mut command = Command::new(&self.program);
        command
            .args(self.args)
            .current_dir(self.cwd)
            .env_remove(DESKTOP_RELAUNCH_ENV)
            // Resolve the committed location again; do not inherit the old frozen paths.
            .env_remove(kcoder_types::STORAGE_STARTUP_ENV)
            .env_remove("KCODER_STORAGE_OWNER_RUNTIME_V1")
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        command.spawn().context("STORAGE_DESKTOP_RELAUNCH_FAILED")?;
        Ok(())
    }
}
