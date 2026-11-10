//! Start the fixed same-image service under its real account, with an owned readiness pipe.
use super::diagnostics::{self, Stage};
use super::*;
use anyhow::{Context, ensure};
use std::process::{Child, Command, Stdio};

#[cfg(target_os = "linux")]
pub(super) fn spawn_owned(
    native: &NativeIntegrationContext,
    record: &NativeCodeServiceRecord,
    launch: &NativeCodeServiceLaunchSpec,
    budget: std::time::Duration,
) -> Result<(Child, Result<serde_json::Value>)> {
    use std::{
        io::Read,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::process::CommandExt,
        },
    };
    kcoder_native_scope::service_identity::verify_current_unix_account()?;
    let source = super::source::NativeSavedCodeSource::from_launch(
        native,
        launch,
        &tokio_util::sync::CancellationToken::new(),
    )?;
    let issuer = crate::app_server::integrations::core::NativePolicyService::load(native)?
        .context("NATIVE_CODE_ORIGINAL_ISSUER_REQUIRED")?;
    issuer.authorize_native_code_service(native, record, &source.snapshot()?, now()?)?;
    let mut descriptors = [-1i32; 2];
    ensure!(
        unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } == 0,
        "NATIVE_CODE_READY_PIPE_UNAVAILABLE"
    );
    // SAFETY: pipe2 returned two newly owned descriptors.
    let (mut reader, writer) = unsafe {
        (
            std::fs::File::from_raw_fd(descriptors[0]),
            std::fs::File::from_raw_fd(descriptors[1]),
        )
    };
    let write_fd = writer.as_raw_fd();
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg(super::entry::NATIVE_CODE_SERVICE_ENTRY)
        .arg(&launch.profile_path)
        .arg(&launch.workspace_path)
        .arg(&launch.lease_id)
        .arg("3")
        .current_dir(&launch.workspace_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_clear();
    for name in [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("KCODER_CONFIG_DIR", &launch.profile_path);
    // SAFETY: the child executes only async-signal-safe syscalls before exec.
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::dup2(write_fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .context("NATIVE_CODE_SERVICE_START_UNCONFIRMED")?;
    drop(writer);
    let result = (|| -> Result<serde_json::Value> {
        let deadline = std::time::Instant::now() + budget;
        let mut bytes = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            ensure!(
                !remaining.is_zero(),
                "NATIVE_CODE_SERVICE_START_UNCONFIRMED"
            );
            let mut poll = libc::pollfd {
                fd: reader.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let timeout = remaining.as_millis().min(1000) as i32;
            let count = unsafe { libc::poll(&mut poll, 1, timeout) };
            ensure!(count >= 0, "NATIVE_CODE_SERVICE_START_UNCONFIRMED");
            if count == 0 {
                continue;
            }
            let mut buffer = [0u8; 1024];
            let count = reader.read(&mut buffer)?;
            ensure!(count > 0, "NATIVE_CODE_SERVICE_START_UNCONFIRMED");
            bytes.extend_from_slice(&buffer[..count]);
            ensure!(bytes.len() <= 8192, "NATIVE_CODE_READY_RECEIPT_INVALID");
            if bytes.ends_with(b"\n") {
                let ready: serde_json::Value = serde_json::from_slice(&bytes)?;
                if let Some(failure) = ready.get("error") {
                    return Err(diagnostics::Failure::from_private(failure.clone())?.into());
                }
                ensure!(
                    child.try_wait()?.is_none(),
                    "NATIVE_CODE_SERVICE_START_UNCONFIRMED"
                );
                ensure!(
                    ready["leaseId"] == record.intent.lease_id
                        && ready["operationId"] == launch.task.runtime_operation_id
                        && ready["modelCalls"].as_u64() == Some(0),
                    "NATIVE_CODE_READY_RECEIPT_INVALID"
                );
                return Ok(ready);
            }
        }
    })();
    Ok((child, diagnostics::mark(Stage::WorkerReadyRead, result)))
}

#[cfg(not(target_os = "linux"))]
pub(super) fn spawn_owned(
    _native: &NativeIntegrationContext,
    _record: &NativeCodeServiceRecord,
    _launch: &NativeCodeServiceLaunchSpec,
    _budget: std::time::Duration,
) -> Result<(Child, Result<serde_json::Value>)> {
    anyhow::bail!("SERVICE_NATIVE_PLATFORM_UNSUPPORTED")
}
