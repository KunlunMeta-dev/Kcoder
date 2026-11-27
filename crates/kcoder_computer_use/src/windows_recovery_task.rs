//! Start the recovery executable outside the caller's kill-on-close Job. Tasks
//! use the current interactive token at limited privilege and have no trigger.
use anyhow::{Result, ensure};
use kcoder_process_supervisor::protocol::INTERNAL_GUI_CARRIER_V1;
use std::{path::Path, process::Stdio, time::Duration};

pub fn task_name(pipe: &str) -> Result<String> {
    let id = pipe
        .strip_prefix(r"\\.\pipe\kcoder-desktop-")
        .ok_or_else(|| anyhow::anyhow!("invalid recovery task identity"))?;
    let id =
        uuid::Uuid::parse_str(id).map_err(|_| anyhow::anyhow!("invalid recovery task identity"))?;
    Ok(format!("KCoderDesktopRecovery-{}", id.simple()))
}
fn quote(value: &str) -> Result<String> {
    ensure!(!value.contains('\0'), "invalid recovery launch parameter");
    Ok(format!("'{}'", value.replace('\'', "''")))
}

pub async fn start(executable: &Path, bootstrap: &Path, pipe: &str) -> Result<()> {
    let mut session_id = 0;
    ensure!(
        unsafe {
            windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId(
                windows_sys::Win32::System::Threading::GetCurrentProcessId(),
                &mut session_id,
            )
        } != 0
            && session_id > 0,
        "recovery requires the caller's interactive Windows session"
    );
    ensure!(
        executable.is_absolute() && bootstrap.is_absolute(),
        "absolute recovery paths required"
    );
    let executable = executable
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid recovery executable path"))?;
    let bootstrap = bootstrap
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid recovery bootstrap path"))?;
    // Windows paths cannot contain a quote. Avoid introducing a second command
    // parser through the Task Scheduler Arguments string.
    ensure!(!bootstrap.contains('"'), "invalid recovery bootstrap path");
    let name = quote(&task_name(pipe)?)?;
    ensure!(
        !executable.contains('"'),
        "invalid recovery executable path"
    );
    let carrier = Path::new(executable).with_file_name("kcoder-process-supervisor.exe");
    let carrier = quote(
        carrier
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("invalid recovery carrier path"))?,
    )?;
    let arguments = quote(&format!(
        "{INTERNAL_GUI_CARRIER_V1} \"{executable}\" --internal-desktop-recovery \"{bootstrap}\" \"{pipe}\""
    ))?;
    let sid = quote(
        &crate::windows_peer::current_user_sid()
            .map_err(|_| anyhow::anyhow!("recovery user identity unavailable"))?,
    )?;
    // A console-subsystem task can activate Windows Terminal before PowerShell
    // handles WindowStyle Hidden. The pinned GUI carrier never allocates that
    // console and waits for the same authenticated recovery executable.
    let script = format!(
        r#"$ErrorActionPreference='Stop'
$scheduler=New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder=$scheduler.GetFolder('\')
$definition=$scheduler.NewTask(0)
$definition.Principal.UserId={sid}
$definition.Principal.LogonType=3
$definition.Principal.RunLevel=0
$definition.Settings.ExecutionTimeLimit='PT0S'
$definition.Settings.DisallowStartIfOnBatteries=$false
$definition.Settings.StopIfGoingOnBatteries=$false
$action=$definition.Actions.Create(0)
$action.Path={carrier}
$action.Arguments={arguments}
$registered=$folder.RegisterTaskDefinition({name},$definition,6,{sid},$null,3,$null)
try {{
 # TASK_RUN_USE_SESSION_ID: never guess between console/RDP sessions.
 $registered.RunEx($null,4,{session_id},$null) | Out-Null
}} catch {{ $folder.DeleteTask({name},0); throw }}
"#
    );
    run_script(script).await
}

/// Invoke only after cleanup in the recovery process, or after a failed launch
/// before any worker was authorized. Never stop a running recovery task to tidy
/// its registration while it may still own input cleanup.
pub async fn unregister(pipe: &str) -> Result<()> {
    let name = quote(&task_name(pipe)?)?;
    run_script(format!(
        r#"$ErrorActionPreference='Stop'
$scheduler=New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
try {{ $scheduler.GetFolder('\').DeleteTask({name},0) }} catch {{
 if ($_.Exception.HResult -ne -2147024894 -and $_.Exception.HResult -ne -2147024893) {{ throw }}
}}
"#
    ))
    .await
}

async fn run_script(script: String) -> Result<()> {
    let root = std::env::var_os("SystemRoot")
        .ok_or_else(|| anyhow::anyhow!("Windows system root unavailable"))?;
    let home = std::path::PathBuf::from(&root).join("System32/WindowsPowerShell/v1.0");
    let mut command = tokio::process::Command::new(home.join("powershell.exe"));
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .env_clear()
        .env("SystemRoot", &root)
        .env("WINDIR", &root)
        .env("PSModulePath", home.join("Modules"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    for key in [
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "ProgramData",
        "ProgramFiles",
        "SystemDrive",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let status = tokio::time::timeout(Duration::from_secs(15), command.status()).await??;
    ensure!(status.success(), "Windows recovery task operation failed");
    Ok(())
}
