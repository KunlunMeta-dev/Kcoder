//! Fixed native font observation, executed only inside the owned worker tree.
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::process::Stdio;
use tokio::io::AsyncReadExt;
pub(super) async fn probe() -> Result<Value> {
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = tokio::process::Command::new("/usr/bin/fc-match");
        command.args(["--format=%{family}\\n", "Noto Sans SC"]);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let root = std::env::var_os("SystemRoot")
            .ok_or_else(|| anyhow::anyhow!("OFFICE_FONT_PROBE_UNAVAILABLE"))?;
        let mut command = tokio::process::Command::new(
            std::path::Path::new(&root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        command.args(["-NoLogo","-NoProfile","-NonInteractive","-Command","Add-Type -AssemblyName System.Drawing; [System.Drawing.Text.InstalledFontCollection]::new().Families | Where-Object { $_.Name -in @('Noto Sans SC','Noto Sans CJK SC','Microsoft YaHei','SimSun','Arial') } | ForEach-Object { $_.Name }"]);
        command
    };
    #[cfg(not(any(target_os = "linux", windows)))]
    return Ok(
        json!({"requestedFamily":"Noto Sans SC","status":"unavailable","reasonCode":"OFFICE_FONT_PROBE_UNAVAILABLE"}),
    );
    #[cfg(any(target_os = "linux", windows))]
    {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                return Ok(
                    json!({"requestedFamily":"Noto Sans SC","status":"unavailable","reasonCode":"OFFICE_FONT_PROBE_UNAVAILABLE"}),
                );
            }
        };
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("OFFICE_PROCESS_PROTOCOL"))?
            .take(4097)
            .read_to_end(&mut bytes)
            .await?;
        ensure!(bytes.len() <= 4096, "OFFICE_FONT_PROBE_UNAVAILABLE");
        let status = child.wait().await?;
        let names = String::from_utf8(bytes).unwrap_or_default();
        let available = status.success()
            && (names.contains("Noto Sans SC") || names.contains("Noto Sans CJK SC"));
        Ok(
            json!({"requestedFamily":"Noto Sans SC","status":if available{"available"}else{"fallback_only"},"observedFamilies":names.lines().filter(|line|!line.is_empty()).take(8).collect::<Vec<_>>(),"readerLayout":"not_verified","nativePlatform":std::env::consts::OS}),
        )
    }
}
