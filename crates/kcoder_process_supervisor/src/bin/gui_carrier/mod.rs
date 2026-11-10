//! Windowless foreground carrier for an OS-owned durable process.
use anyhow::{Context, Result, ensure};
use kcoder_process_supervisor::protocol::{
    GUI_CARRIER_CAPABILITY_V1, INTERNAL_GUI_CARRIER_PROBE_V1, INTERNAL_GUI_CARRIER_V1,
};
use std::{
    os::windows::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

pub(super) fn try_run() -> Result<Option<i32>> {
    let args = std::env::args_os().collect::<Vec<_>>();
    if args
        .get(1)
        .is_some_and(|value| value == INTERNAL_GUI_CARRIER_PROBE_V1)
    {
        ensure!(args.len() == 2, "invalid carrier probe");
        println!("{GUI_CARRIER_CAPABILITY_V1}");
        return Ok(Some(0));
    }
    if args
        .get(1)
        .is_none_or(|value| value != INTERNAL_GUI_CARRIER_V1)
    {
        return Ok(None);
    }
    ensure!(
        args.len() >= 4 && args.len() <= 68,
        "invalid carrier arguments"
    );
    let executable = Path::new(&args[2]);
    ensure!(
        executable.is_absolute() && executable.is_file(),
        "invalid carrier executable"
    );
    // The OS task owns the durable child. This carrier waits for that exact
    // child; it does not create a kill-on-close Job or grant any authority.
    let status = Command::new(executable)
        .args(&args[3..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .context("cannot start carried process")?;
    Ok(Some(status.code().unwrap_or(1)))
}
