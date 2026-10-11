//! Host-owned command construction. Only verified package resources may become
//! executables. Never inherit provider credentials, Python overrides or proxies.
use crate::runtime::VerifiedRuntime;
use anyhow::{Result, ensure};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    path::Path,
    process::Stdio,
};

const INHERITED: &[&str] = &[
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "USERNAME",
    "USERDOMAIN",
    "SESSIONNAME",
];

/// Environment defaults are selected by the host; no model-writable overrides.
pub fn worker_environment(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    temporary_directory: &Path,
) -> Result<BTreeMap<OsString, OsString>> {
    ensure!(
        temporary_directory.is_absolute(),
        "worker temp directory must be absolute"
    );
    let mut env = BTreeMap::new();
    for (key, value) in inherited {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if INHERITED.contains(&upper.as_str()) {
            env.insert(OsString::from(upper), value);
        }
    }
    // Windows process and COM libraries need SystemRoot. PATH is intentionally
    // reduced so app launch helpers do not resolve executables from a project.
    if let Some(system_root) = env.get(OsStr::new("SYSTEMROOT")) {
        let system = Path::new(system_root).join("System32");
        env.insert("PATH".into(), system.into_os_string());
    }
    for name in ["TEMP", "TMP"] {
        env.insert(name.into(), temporary_directory.as_os_str().into());
    }
    for (key, value) in [
        ("ANONYMIZED_TELEMETRY", "false"),
        ("WINDOWS_MCP_WATCHDOG", "false"),
        ("PYTHONIOENCODING", "utf-8"),
        ("NO_COLOR", "1"),
    ] {
        env.insert(key.into(), value.into());
    }
    Ok(env)
}

/// Produces a command but does not spawn it: the Windows host must use
/// windows_process::JobChild to atomically assign its kill-on-close Job Object.
/// Preflight/lease verification remains mandatory immediately before spawn.
pub fn worker_command(runtime: &VerifiedRuntime, temp: &Path) -> Result<std::process::Command> {
    let env = worker_environment(std::env::vars_os(), temp)?;
    let mut command = std::process::Command::new(runtime.python());
    command
        .args(["-I", "-B", "-X", "utf8"])
        .arg(runtime.launcher());
    command.current_dir(runtime.root()).env_clear().envs(env);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strips_credentials_proxy_python_and_tool_overrides() {
        let env = worker_environment(
            [
                ("SystemRoot".into(), "C:\\Windows".into()),
                ("PATH".into(), "untrusted-project".into()),
                ("OPENAI_API_KEY".into(), "fixture-secret".into()),
                ("PYTHONPATH".into(), "untrusted-python".into()),
                ("HTTP_PROXY".into(), "http://fixture".into()),
                ("WINDOWS_MCP_TOOLS".into(), "PowerShell".into()),
                ("WINDOWS_MCP_WATCHDOG".into(), "true".into()),
            ],
            &std::env::temp_dir(),
        )
        .unwrap();
        for key in [
            "OPENAI_API_KEY",
            "PYTHONPATH",
            "HTTP_PROXY",
            "WINDOWS_MCP_TOOLS",
        ] {
            assert!(!env.contains_key(OsStr::new(key)));
        }
        assert_eq!(env[OsStr::new("ANONYMIZED_TELEMETRY")], "false");
        assert_eq!(env[OsStr::new("WINDOWS_MCP_WATCHDOG")], "false");
        assert!(
            !env[OsStr::new("PATH")]
                .to_string_lossy()
                .contains("untrusted")
        );
    }
    #[test]
    fn relative_temp_is_rejected() {
        assert!(
            worker_environment(Vec::<(OsString, OsString)>::new(), Path::new("relative")).is_err()
        );
    }
}
