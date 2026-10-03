//! Windows-only fixtures that prove a descendant really started before Job cleanup.

use base64::Engine;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::time::Duration;
use windows_sys::Win32::Foundation::{FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
};

pub(crate) struct DescendantProbe {
    started: PathBuf,
    release: PathBuf,
    survived: PathBuf,
}

impl DescendantProbe {
    pub(crate) fn new(workspace: &Path) -> Self {
        Self {
            started: workspace.join("descendant-started.pid"),
            release: workspace.join("release-root.txt"),
            survived: workspace.join("descendant-survived.txt"),
        }
    }

    pub(crate) fn command(&self, wait_for_release: bool) -> String {
        let staging = self.started.with_extension("staging");
        let child = format!(
            "$ErrorActionPreference='Stop'; $created=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc(); [IO.File]::WriteAllText({}, ($PID.ToString()+':'+$created.ToString())); \
             [IO.File]::Move({}, {}); Start-Sleep -Seconds 30; \
             [IO.File]::WriteAllText({}, 'survived')",
            quote(&staging),
            quote(&staging),
            quote(&self.started),
            quote(&self.survived),
        );
        let encoded = encoded_command(&child);
        let root_wait = if wait_for_release {
            format!(
                "$deadline=[DateTime]::UtcNow.AddSeconds(15); \
                 while (-not (Test-Path -LiteralPath {})) {{ \
                 if ([DateTime]::UtcNow -gt $deadline) {{ throw 'fixture release timed out' }}; \
                 Start-Sleep -Milliseconds 20 }}",
                quote(&self.release),
            )
        } else {
            "Start-Sleep -Seconds 30".to_string()
        };
        format!(
            "$ErrorActionPreference='Stop'; $ownedChild=Start-Process -FilePath powershell.exe -NoNewWindow \
             -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','{encoded}'); \
             $startupDeadline=[DateTime]::UtcNow.AddSeconds(5); \
             while (-not (Test-Path -LiteralPath {})) {{ \
             if ($ownedChild.HasExited) {{ throw ('fixture child exited before marker: '+$ownedChild.ExitCode) }}; \
             if ([DateTime]::UtcNow -gt $startupDeadline) {{ throw 'fixture child startup timed out' }}; \
             Start-Sleep -Milliseconds 20 }}; {root_wait}",
            quote(&self.started),
        )
    }

    pub(crate) async fn wait_started(&self) -> Result<StartedDescendant, String> {
        tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(&self.started) {
                    let (pid, created) =
                        text.trim().split_once(':').ok_or("invalid child marker")?;
                    let pid = pid.parse::<u32>().map_err(|error| error.to_string())?;
                    let created = created.parse::<u64>().map_err(|error| error.to_string())?;
                    // The marker is atomically published by the child itself. Holding
                    // its process handle keeps cleanup independent of PID reuse.
                    let raw = unsafe {
                        OpenProcess(
                            PROCESS_SYNCHRONIZE
                                | PROCESS_TERMINATE
                                | PROCESS_QUERY_LIMITED_INFORMATION,
                            0,
                            pid,
                        )
                    };
                    if raw.is_null() {
                        return Err(format!(
                            "cannot open started descendant: {}",
                            std::io::Error::last_os_error()
                        ));
                    }
                    let handle = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
                    let mut times: [FILETIME; 4] = unsafe { std::mem::zeroed() };
                    if unsafe {
                        GetProcessTimes(
                            raw,
                            &mut times[0],
                            &mut times[1],
                            &mut times[2],
                            &mut times[3],
                        )
                    } == 0
                    {
                        return Err(format!(
                            "cannot verify owned child creation time: {}",
                            std::io::Error::last_os_error()
                        ));
                    }
                    let actual = (u64::from(times[0].dwHighDateTime) << 32)
                        | u64::from(times[0].dwLowDateTime);
                    if actual != created {
                        return Err("child PID was reused before handle acquisition".to_string());
                    }
                    let child = StartedDescendant(handle);
                    if child.wait(0) != WAIT_TIMEOUT {
                        return Err("descendant exited before cleanup was exercised".to_string());
                    }
                    return Ok(child);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| "descendant did not publish its startup marker".to_string())?
    }

    pub(crate) fn release_root(&self) {
        std::fs::write(&self.release, b"release").expect("release owned fixture root");
    }

    pub(crate) fn assert_no_survival_marker(&self) {
        assert!(!self.survived.exists(), "owned descendant outlived its Job");
    }
}

pub(crate) struct StartedDescendant(OwnedHandle);

impl StartedDescendant {
    fn wait(&self, milliseconds: u32) -> u32 {
        unsafe { WaitForSingleObject(self.0.as_raw_handle() as HANDLE, milliseconds) }
    }

    pub(crate) fn assert_terminated(&self) {
        assert_eq!(
            self.wait(2_000),
            WAIT_OBJECT_0,
            "Job cleanup must terminate the started descendant"
        );
    }
}

impl Drop for StartedDescendant {
    fn drop(&mut self) {
        if self.wait(0) == WAIT_TIMEOUT {
            // Failure cleanup touches only the child handle authenticated by its marker.
            // The assertion above runs before this fallback and cannot pass because of it.
            unsafe { TerminateProcess(self.0.as_raw_handle() as HANDLE, 99) };
            let _ = self.wait(2_000);
        }
    }
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "''"))
}

pub(crate) fn encoded_command(script: &str) -> String {
    let bytes = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
