use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};
use tokio::process::Command;
use tracing::{debug, warn};

pub const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
pub const SNAPSHOT_RETENTION: Duration = Duration::from_secs(60 * 60 * 24 * 3);
const SNAPSHOT_DIR: &str = "shell_snapshots";

#[derive(Clone, Debug, Default)]
pub struct ShellEnvironmentSnapshot {
    ready: Arc<RwLock<Option<PathBuf>>>,
    verifier_ready: Arc<RwLock<Option<PathBuf>>>,
    sandbox_ready: Arc<RwLock<Option<PathBuf>>>,
}

impl ShellEnvironmentSnapshot {
    pub fn schedule(cwd: PathBuf, session_id: String) -> Self {
        let snapshot = Self::default();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let target = snapshot.clone();
            let verifier_source = verifier_snapshot_source(|name| std::env::var_os(name));
            let sandbox_source = sandbox_snapshot_source(std::env::vars_os());
            runtime.spawn(async move {
                match build_snapshot(&cwd, &session_id, &verifier_source, &sandbox_source).await {
                    Ok((path, verifier_path, sandbox_path)) => {
                        *target
                            .verifier_ready
                            .write()
                            .unwrap_or_else(|p| p.into_inner()) = Some(verifier_path);
                        *target
                            .sandbox_ready
                            .write()
                            .unwrap_or_else(|p| p.into_inner()) = Some(sandbox_path);
                        // Publish the full snapshot last. Once callers observe ready, both redacted
                        // snapshots are also ready and no path can fall back to copying the full login environment.
                        *target.ready.write().unwrap_or_else(|p| p.into_inner()) = Some(path);
                    }
                    Err(error) => debug!(%error, "shell environment snapshot unavailable"),
                }
            });
        }
        snapshot
    }

    pub fn ready_path(&self) -> Option<PathBuf> {
        self.ready.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Return a verifier-only snapshot containing runtime selection and Python import
    /// paths. It never includes login-shell functions, aliases, or arbitrary exported secrets.
    pub fn verifier_ready_path(&self) -> Option<PathBuf> {
        self.verifier_ready
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Return a task-runtime snapshot for regular restricted shells. It retains only
    /// explicitly allowed runtime variables and excludes provider credentials, functions, and aliases.
    pub fn sandbox_ready_path(&self) -> Option<PathBuf> {
        self.sandbox_ready
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    #[cfg(test)]
    pub(crate) fn from_paths_for_test(
        ready: Option<PathBuf>,
        verifier_ready: Option<PathBuf>,
        sandbox_ready: Option<PathBuf>,
    ) -> Self {
        Self {
            ready: Arc::new(RwLock::new(ready)),
            verifier_ready: Arc::new(RwLock::new(verifier_ready)),
            sandbox_ready: Arc::new(RwLock::new(sandbox_ready)),
        }
    }
}

async fn build_snapshot(
    cwd: &Path,
    session_id: &str,
    verifier_source: &str,
    sandbox_source: &str,
) -> anyhow::Result<(PathBuf, PathBuf, PathBuf)> {
    let config_dir = kcoder_config::Settings::config_dir()?;
    let snapshot_dir = config_dir.join(SNAPSHOT_DIR);
    tokio::fs::create_dir_all(&snapshot_dir).await?;
    cleanup_stale_snapshots(&snapshot_dir).await;

    let safe_session = kcoder_state::artifact_id_path_component(session_id);
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let final_path = snapshot_dir.join(format!("{safe_session}-{nonce}.sh"));
    let verifier_final_path = snapshot_dir.join(format!("{safe_session}-{nonce}.verifier.sh"));
    let sandbox_final_path = snapshot_dir.join(format!("{safe_session}-{nonce}.sandbox.sh"));
    let temp_path = snapshot_dir.join(format!(".{safe_session}-{nonce}.tmp"));
    let verifier_temp_path = snapshot_dir.join(format!(".{safe_session}-{nonce}.verifier.tmp"));
    let sandbox_temp_path = snapshot_dir.join(format!(".{safe_session}-{nonce}.sandbox.tmp"));
    let shell = snapshot_shell();

    let output = tokio::time::timeout(SNAPSHOT_TIMEOUT, async {
        snapshot_command(&shell, cwd)
            .args(["-l", "-c", SNAPSHOT_SCRIPT])
            .output()
            .await
    })
    .await
    .map_err(|_| anyhow::anyhow!("shell snapshot timed out after 10 seconds"))??;
    if !output.status.success() {
        anyhow::bail!(
            "shell snapshot command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    tokio::fs::write(&temp_path, &output.stdout).await?;
    tokio::fs::write(&verifier_temp_path, verifier_source).await?;
    tokio::fs::write(&sandbox_temp_path, sandbox_source).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o600)).await?;
        tokio::fs::set_permissions(&verifier_temp_path, std::fs::Permissions::from_mode(0o600))
            .await?;
        tokio::fs::set_permissions(&sandbox_temp_path, std::fs::Permissions::from_mode(0o600))
            .await?;
    }

    let validation = tokio::time::timeout(SNAPSHOT_TIMEOUT, async {
        snapshot_command(&shell, cwd)
            .args([
                "-c",
                ". \"$1\" >/dev/null 2>&1 && . \"$2\" >/dev/null 2>&1 && . \"$3\" >/dev/null 2>&1",
                "kcoder-snapshot",
            ])
            .arg(&temp_path)
            .arg(&verifier_temp_path)
            .arg(&sandbox_temp_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
    })
    .await
    .map_err(|_| anyhow::anyhow!("shell snapshot validation timed out"))??;
    if !validation.success() {
        let _ = tokio::fs::remove_file(&temp_path).await;
        let _ = tokio::fs::remove_file(&verifier_temp_path).await;
        let _ = tokio::fs::remove_file(&sandbox_temp_path).await;
        anyhow::bail!("generated shell snapshot failed validation");
    }
    tokio::fs::rename(&verifier_temp_path, &verifier_final_path).await?;
    if let Err(error) = tokio::fs::rename(&sandbox_temp_path, &sandbox_final_path).await {
        let _ = tokio::fs::remove_file(&verifier_final_path).await;
        return Err(error.into());
    }
    if let Err(error) = tokio::fs::rename(&temp_path, &final_path).await {
        let _ = tokio::fs::remove_file(&verifier_final_path).await;
        let _ = tokio::fs::remove_file(&sandbox_final_path).await;
        return Err(error.into());
    }
    Ok((final_path, verifier_final_path, sandbox_final_path))
}

const VERIFIER_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "CONDA_DEFAULT_ENV",
    "SWE_BENCH_BASE_SITE_PACKAGES",
    "SWE_BENCH_PRIVATE_SITE_PACKAGES",
    "SWE_BENCH_RUNS_ROOT",
];

fn verifier_snapshot_source(mut lookup: impl FnMut(&str) -> Option<OsString>) -> String {
    let mut source = String::from("# KCoder verifier environment snapshot\n");
    for name in VERIFIER_ENV_ALLOWLIST {
        let value = lookup(name)
            .or_else(|| (*name == "PATH").then(|| OsString::from("/usr/local/bin:/usr/bin:/bin")));
        let Some(value) = value else {
            continue;
        };
        source.push_str("export ");
        source.push_str(name);
        source.push('=');
        source.push_str(&shell_single_quoted(&value));
        source.push('\n');
    }
    source
}

const SANDBOX_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "CONDA_DEFAULT_ENV",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CACHE_HOME",
    "PIP_CACHE_DIR",
    "NPM_CONFIG_CACHE",
    "PYTHONPYCACHEPREFIX",
    "CARGO_TARGET_DIR",
    "UV_CACHE_DIR",
    "PYTHONPATH",
    "PYTHONNOUSERSITE",
    "PYTHONDONTWRITEBYTECODE",
    "PIP_REQUIRE_VIRTUALENV",
    "PIP_CONFIG_FILE",
    "PIP_DISABLE_PIP_VERSION_CHECK",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_ADDRESS",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_IDENTIFICATION",
    "LC_MEASUREMENT",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NAME",
    "LC_NUMERIC",
    "LC_PAPER",
    "LC_TELEPHONE",
    "LC_TIME",
    "MKL_THREADING_LAYER",
    "MKL_NUM_THREADS",
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "BLIS_NUM_THREADS",
];

fn sandbox_environment_name_is_allowed(name: &str) -> bool {
    !environment_name_is_sensitive(name)
        && (SANDBOX_ENV_ALLOWLIST.contains(&name) || name.starts_with("SWE_BENCH_"))
}

fn environment_name_is_sensitive(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    [
        "API_KEY",
        "APIKEY",
        "AUTH",
        "CREDENTIAL",
        "KEY",
        "PASSWORD",
        "PASSWD",
        "PROVIDER",
        "SECRET",
        "TOKEN",
    ]
    .iter()
    .any(|marker| name.contains(marker))
}

pub(crate) fn sandbox_snapshot_source(
    environment: impl IntoIterator<Item = (OsString, OsString)>,
) -> String {
    let mut allowed = environment
        .into_iter()
        .filter_map(|(name, value)| {
            let name = name.into_string().ok()?;
            sandbox_environment_name_is_allowed(&name).then_some((name, value))
        })
        .collect::<Vec<_>>();
    allowed.sort_by(|left, right| left.0.cmp(&right.0));
    allowed.dedup_by(|left, right| left.0 == right.0);

    if !allowed.iter().any(|(name, _)| name == "PATH") {
        allowed.push((
            "PATH".to_string(),
            OsString::from("/usr/local/bin:/usr/bin:/bin"),
        ));
        allowed.sort_by(|left, right| left.0.cmp(&right.0));
    }

    let mut source = String::from("# KCoder sandbox task-runtime environment snapshot\n");
    for (name, value) in allowed {
        source.push_str("export ");
        source.push_str(&name);
        source.push('=');
        source.push_str(&shell_single_quoted(&value));
        source.push('\n');
    }
    source
}

fn shell_single_quoted(value: &OsStr) -> String {
    let value = value.to_string_lossy();
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn cleanup_stale_snapshots(dir: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let now = SystemTime::now();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let stale = entry
            .metadata()
            .await
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > SNAPSHOT_RETENTION);
        if stale && let Err(error) = tokio::fs::remove_file(&path).await {
            warn!(path = %path.display(), %error, "failed to remove stale shell snapshot");
        }
    }
}

fn snapshot_command(shell: impl AsRef<OsStr>, cwd: &Path) -> Command {
    let mut command = Command::new(shell);
    // WSL launchers and shell startup scripts can read ahead even when the
    // validation command itself needs no input. Never inherit the RPC/TUI pipe.
    command
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    command
}

fn snapshot_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|shell| shell.ends_with("bash"))
        .or_else(|| {
            Path::new("/bin/bash")
                .exists()
                .then(|| "/bin/bash".to_string())
        })
        .unwrap_or_else(|| "bash".to_string())
}

const SNAPSHOT_SCRIPT: &str = r#"
if [ -z "${BASH_ENV:-}" ] && [ -r "${HOME:-}/.bashrc" ]; then
  . "$HOME/.bashrc" >/dev/null 2>&1
fi
printf '%s\n' '# KCoder shell environment snapshot'
printf '%s\n' 'unalias -a 2>/dev/null || true'
printf '%s\n' '# shell options'
set +o
shopt -p 2>/dev/null || true
printf '%s\n' 'shopt -s expand_aliases 2>/dev/null || true'
printf '%s\n' '# functions'
declare -f
printf '%s\n' '# aliases'
alias -p
printf '%s\n' '# exported variables'
while IFS= read -r name; do
  case "$name" in
    PWD|OLDPWD|SHLVL|_|BASHOPTS|SHELLOPTS|KCODER_GOAL_AUTO_CONTINUATION_MARKER_FD) continue ;;
  esac
  declare -p "$name" 2>/dev/null | sed 's/^declare -x /export /'
done < <(compgen -e)
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_contract_uses_ten_second_timeout_and_three_day_retention() {
        assert_eq!(SNAPSHOT_TIMEOUT, Duration::from_secs(10));
        assert_eq!(SNAPSHOT_RETENTION, Duration::from_secs(3 * 24 * 60 * 60));
    }

    #[tokio::test]
    async fn snapshot_stdin_process_helper() {
        use std::io::Read;
        let Ok(stage) = std::env::var("KCODER_TEST_SNAPSHOT_STDIN_STAGE") else {
            return;
        };
        if stage == "parent" {
            let status = snapshot_command(
                std::env::current_exe().unwrap(),
                &std::env::current_dir().unwrap(),
            )
            .args([
                "--exact",
                "shell_snapshot::tests::snapshot_stdin_process_helper",
                "--nocapture",
            ])
            .env("KCODER_TEST_SNAPSHOT_STDIN_STAGE", "child")
            .status()
            .await
            .unwrap();
            assert!(status.success());
        }
        let mut remaining = String::new();
        std::io::stdin().read_to_string(&mut remaining).unwrap();
        assert_eq!(
            remaining,
            if stage == "parent" {
                "protocol-input\n"
            } else {
                ""
            }
        );
    }

    #[test]
    fn snapshot_subprocess_does_not_consume_protocol_stdin() {
        use std::io::Write;
        let mut parent = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "shell_snapshot::tests::snapshot_stdin_process_helper",
                "--nocapture",
            ])
            .env("KCODER_TEST_SNAPSHOT_STDIN_STAGE", "parent")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        parent
            .stdin
            .take()
            .unwrap()
            .write_all(b"protocol-input\n")
            .unwrap();
        let output = parent.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn snapshot_script_excludes_per_command_directory_state() {
        assert!(SNAPSHOT_SCRIPT.contains("PWD|OLDPWD"));
        assert!(SNAPSHOT_SCRIPT.contains("KCODER_GOAL_AUTO_CONTINUATION_MARKER_FD"));
        assert!(SNAPSHOT_SCRIPT.contains("declare -f"));
        assert!(SNAPSHOT_SCRIPT.contains("alias -p"));
    }

    #[test]
    fn verifier_snapshot_keeps_python_import_paths_without_secrets_or_markers() {
        let source = verifier_snapshot_source(|name| match name {
            "PATH" => Some(OsString::from("/task/python/bin:/usr/bin")),
            "VIRTUAL_ENV" => Some(OsString::from("/task/python")),
            "PYTHONPATH" => Some(OsString::from("/task/workspace:/harness/bootstrap")),
            "SWE_BENCH_BASE_SITE_PACKAGES" => {
                Some(OsString::from("/base/site-packages:/shared/site-packages"))
            }
            "SWE_BENCH_PRIVATE_SITE_PACKAGES" => {
                Some(OsString::from("/task/python/lib/python3.8/site-packages"))
            }
            "SWE_BENCH_RUNS_ROOT" => Some(OsString::from("/task/runs")),
            "AWS_SECRET_ACCESS_KEY" => Some(OsString::from("must-not-leak")),
            "DEEPSEEK_API_KEY" => Some(OsString::from("provider-secret")),
            "KCODER_GOAL_AUTO_CONTINUATION_MARKER_FD" => Some(OsString::from("marker-fd")),
            "PYTHONHOME" => Some(OsString::from("/untrusted/python-home")),
            "PYTHONNOUSERSITE" => Some(OsString::from("0")),
            _ => None,
        });

        assert!(source.contains("export PATH='/task/python/bin:/usr/bin'"));
        assert!(source.contains("export VIRTUAL_ENV='/task/python'"));
        assert!(source.contains(
            "export SWE_BENCH_BASE_SITE_PACKAGES='/base/site-packages:/shared/site-packages'"
        ));
        assert!(source.contains(
            "export SWE_BENCH_PRIVATE_SITE_PACKAGES='/task/python/lib/python3.8/site-packages'"
        ));
        assert!(source.contains("export SWE_BENCH_RUNS_ROOT='/task/runs'"));
        // After sourcing the snapshot, a verifier rebuilds PYTHONPATH from only the
        // current workspace and trusted bootstrap. Do not carry arbitrary parent-process import paths into it.
        assert!(!source.contains("export PYTHONPATH="));
        assert!(!source.contains("/task/workspace:/harness/bootstrap"));
        assert!(!source.contains("AWS_SECRET_ACCESS_KEY"));
        assert!(!source.contains("must-not-leak"));
        assert!(!source.contains("DEEPSEEK_API_KEY"));
        assert!(!source.contains("provider-secret"));
        assert!(!source.contains("KCODER_GOAL_AUTO_CONTINUATION_MARKER_FD"));
        assert!(!source.contains("marker-fd"));
        assert!(!source.contains("PYTHONHOME"));
        assert!(!source.contains("/untrusted/python-home"));
        assert!(!source.contains("PYTHONNOUSERSITE"));
        assert!(!source.contains("declare -f"));
        assert!(!source.contains("alias -p"));
    }

    #[test]
    fn verifier_snapshot_shell_quotes_untrusted_path_characters() {
        let source = verifier_snapshot_source(|name| {
            (name == "PATH").then(|| OsString::from("/tmp/a'b;$(touch nope)"))
        });

        assert_eq!(
            source,
            "# KCoder verifier environment snapshot\n\
             export PATH='/tmp/a'\\''b;$(touch nope)'\n"
        );
    }

    #[test]
    fn sandbox_snapshot_keeps_task_runtime_without_credentials_or_shell_state() {
        let source = sandbox_snapshot_source([
            ("PATH".into(), "/task/python/bin:/usr/bin".into()),
            ("VIRTUAL_ENV".into(), "/task/python".into()),
            ("HOME".into(), "/task/runtime/home".into()),
            ("TMPDIR".into(), "/task/private-tmp".into()),
            ("XDG_CACHE_HOME".into(), "/task/runtime/cache".into()),
            (
                "PYTHONPATH".into(),
                "/task/workspace:/harness/bootstrap".into(),
            ),
            ("PYTHONNOUSERSITE".into(), "1".into()),
            ("PIP_REQUIRE_VIRTUALENV".into(), "1".into()),
            ("LANG".into(), "C.UTF-8".into()),
            (
                "SWE_BENCH_BASE_SITE_PACKAGES".into(),
                "/shared/site-packages".into(),
            ),
            (
                "SWE_BENCH_PRIVATE_SITE_PACKAGES".into(),
                "/task/private-site-packages".into(),
            ),
            (
                "SWE_BENCH_ACTIVE_WORKSPACE".into(),
                "/task/workspace".into(),
            ),
            ("SWE_BENCH_API_TOKEN".into(), "swe-secret".into()),
            ("DEEPSEEK_API_KEY".into(), "provider-secret".into()),
            ("ANTHROPIC_AUTH_TOKEN".into(), "auth-secret".into()),
            ("AWS_SECRET_ACCESS_KEY".into(), "cloud-secret".into()),
        ]);

        for expected in [
            "export PATH='/task/python/bin:/usr/bin'",
            "export VIRTUAL_ENV='/task/python'",
            "export HOME='/task/runtime/home'",
            "export TMPDIR='/task/private-tmp'",
            "export XDG_CACHE_HOME='/task/runtime/cache'",
            "export PYTHONPATH='/task/workspace:/harness/bootstrap'",
            "export PYTHONNOUSERSITE='1'",
            "export PIP_REQUIRE_VIRTUALENV='1'",
            "export LANG='C.UTF-8'",
            "export SWE_BENCH_BASE_SITE_PACKAGES='/shared/site-packages'",
            "export SWE_BENCH_PRIVATE_SITE_PACKAGES='/task/private-site-packages'",
            "export SWE_BENCH_ACTIVE_WORKSPACE='/task/workspace'",
        ] {
            assert!(
                source.contains(expected),
                "missing `{expected}` in {source}"
            );
        }
        for forbidden in [
            "SWE_BENCH_API_TOKEN",
            "swe-secret",
            "DEEPSEEK_API_KEY",
            "provider-secret",
            "ANTHROPIC_AUTH_TOKEN",
            "auth-secret",
            "AWS_SECRET_ACCESS_KEY",
            "cloud-secret",
            "declare -f",
            "alias -p",
        ] {
            assert!(
                !source.contains(forbidden),
                "leaked `{forbidden}` in {source}"
            );
        }
    }
}
