use crate::protocol::{PROTOCOL_VERSION, SpawnRequest};
use anyhow::{Context, Result};
use serde_json::json;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static NEXT_NONCE: AtomicU64 = AtomicU64::new(1);

pub struct SpawnSpec {
    pub executable: PathBuf,
    pub cwd: PathBuf,
    pub args: Vec<OsString>,
    pub env: BTreeMap<OsString, OsString>,
}

impl SpawnSpec {
    pub fn from_command_inherit_environment(command: &Command) -> Result<Self> {
        Self::from_command_with_environment(command, true)
    }

    pub fn from_command_exact_environment(command: &Command) -> Result<Self> {
        Self::from_command_with_environment(command, false)
    }

    fn from_command_with_environment(command: &Command, inherit: bool) -> Result<Self> {
        let executable = resolve_executable(command.get_program())?;
        let cwd = command
            .get_current_dir()
            .map(Path::to_path_buf)
            .unwrap_or(std::env::current_dir()?);
        let mut env = BTreeMap::new();
        if inherit {
            for (name, value) in std::env::vars_os() {
                if name.to_str().is_some_and(|name| name.starts_with('=')) {
                    continue;
                }
                replace_environment_entry(&mut env, name, Some(value))?;
            }
        }
        for (name, value) in command.get_envs() {
            replace_environment_entry(
                &mut env,
                name.to_os_string(),
                value.map(OsStr::to_os_string),
            )?;
        }
        Ok(Self {
            executable,
            cwd,
            args: command.get_args().map(OsStr::to_os_string).collect(),
            env,
        })
    }
}

fn replace_environment_entry(
    environment: &mut BTreeMap<OsString, OsString>,
    name: OsString,
    value: Option<OsString>,
) -> Result<()> {
    let normalized = windows_environment_name(&name)?;
    let mut replaced = None;
    for existing in environment.keys() {
        if windows_environment_name(existing)? == normalized {
            replaced = Some(existing.clone());
            break;
        }
    }
    if let Some(replaced) = replaced {
        environment.remove(&replaced);
    }
    if let Some(value) = value {
        environment.insert(name, value);
    }
    Ok(())
}

fn windows_environment_name(value: &OsStr) -> Result<String> {
    Ok(value
        .to_str()
        .context("environment name is not valid Unicode")?
        .chars()
        .flat_map(char::to_uppercase)
        .collect())
}

pub struct SupervisedChild {
    child: Child,
    stdin: Option<ChildStdin>,
    target_pid: u32,
    nonce: String,
    _status_directory: tempfile::TempDir,
}

impl SupervisedChild {
    pub fn spawn(spec: SpawnSpec, supervisor: &Path) -> Result<Self> {
        Self::spawn_with_timeout(spec, supervisor, Duration::from_secs(10))
    }

    pub fn spawn_with_timeout(
        spec: SpawnSpec,
        supervisor: &Path,
        ready_timeout: Duration,
    ) -> Result<Self> {
        anyhow::ensure!(
            supervisor.is_absolute(),
            "process supervisor path must be absolute"
        );
        anyhow::ensure!(!ready_timeout.is_zero(), "READY timeout must be positive");
        let status_directory = tempfile::Builder::new()
            .prefix("kcoder-process-supervisor-")
            .tempdir()
            .context("failed to create private supervisor status directory")?;
        let status_file = status_directory.path().join("status.jsonl");
        let nonce = format!(
            "{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            NEXT_NONCE.fetch_add(1, Ordering::Relaxed)
        );
        let request = spawn_request(&spec, &status_file, &nonce)?;
        let mut child = Command::new(supervisor)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("failed to launch process supervisor")?;
        let mut stdin = child
            .stdin
            .take()
            .context("supervisor stdin is unavailable")?;
        serde_json::to_writer(&mut stdin, &request)?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        let target_pid = match wait_ready(&status_file, &nonce, ready_timeout) {
            Ok(pid) => pid,
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        serde_json::to_writer(
            &mut stdin,
            &json!({"command":"START","version":PROTOCOL_VERSION,"nonce":nonce}),
        )?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(Self {
            child,
            stdin: Some(stdin),
            target_pid,
            nonce,
            _status_directory: status_directory,
        })
    }

    pub fn target_pid(&self) -> u32 {
        self.target_pid
    }
    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }
    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }
    pub fn try_wait(&mut self) -> Result<Option<ExitStatus>> {
        self.child
            .try_wait()
            .context("failed to query process supervisor")
    }
    pub fn wait(&mut self) -> Result<ExitStatus> {
        self.child
            .wait()
            .context("failed to wait for process supervisor")
    }
    pub fn wait_with_timeout(&mut self, timeout: Duration) -> Result<Option<ExitStatus>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(Some(status));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(
                Duration::from_millis(10).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
    pub fn kill_and_wait(&mut self, timeout: Duration) -> Result<Option<ExitStatus>> {
        self.kill()?;
        self.wait_with_timeout(timeout)
    }
    pub fn kill(&mut self) -> Result<()> {
        let Some(mut stdin) = self.stdin.take() else {
            return Ok(());
        };
        serde_json::to_writer(
            &mut stdin,
            &json!({"command":"KILL","version":PROTOCOL_VERSION,"nonce":self.nonce}),
        )?;
        stdin.write_all(b"\n")?;
        stdin
            .flush()
            .context("failed to send KILL to process supervisor")
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        let _ = self.kill();
        let _ = self.child.try_wait();
    }
}

pub fn locate_supervisor(variable: &str) -> Result<PathBuf> {
    let configured = std::env::var_os(variable)
        .with_context(|| format!("{variable} must identify kcoder-process-supervisor.exe"))?;
    let path = std::fs::canonicalize(configured)?;
    anyhow::ensure!(
        path.is_absolute() && path.is_file(),
        "invalid process supervisor binary"
    );
    Ok(path)
}

pub fn locate_supervisor_or_sibling(variable: &str) -> Result<PathBuf> {
    if std::env::var_os(variable).is_some() {
        return locate_supervisor(variable);
    }
    let executable = std::env::current_exe()?;
    let sibling = executable
        .parent()
        .context("current executable has no parent directory")?
        .join("kcoder-process-supervisor.exe");
    let sibling = std::fs::canonicalize(sibling).with_context(|| {
        format!("{variable} is unset and the packaged process supervisor is missing")
    })?;
    anyhow::ensure!(
        sibling.is_file(),
        "invalid packaged process supervisor binary"
    );
    Ok(sibling)
}

fn spawn_request(spec: &SpawnSpec, status_file: &Path, nonce: &str) -> Result<SpawnRequest> {
    let request = SpawnRequest {
        version: PROTOCOL_VERSION,
        nonce: nonce.into(),
        executable: unicode(&spec.executable, "executable")?,
        cwd: unicode(&spec.cwd, "cwd")?,
        status_file: unicode(status_file, "status_file")?,
        args: spec
            .args
            .iter()
            .map(|value| unicode(value, "argument"))
            .collect::<Result<_>>()?,
        env: spec
            .env
            .iter()
            .map(|(name, value)| {
                Ok((
                    unicode(name, "environment name")?,
                    unicode(value, "environment value")?,
                ))
            })
            .collect::<Result<_>>()?,
    };
    request.validate()?;
    Ok(request)
}

fn wait_ready(path: &Path, nonce: &str, timeout: Duration) -> Result<u32> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(file) = std::fs::File::open(path) {
            for line in BufReader::new(file).lines() {
                let value: serde_json::Value = serde_json::from_str(&line?)?;
                if value["event"] == "READY" {
                    anyhow::ensure!(value["nonce"] == nonce, "supervisor READY nonce mismatch");
                    return value["pid"]
                        .as_u64()
                        .and_then(|pid| u32::try_from(pid).ok())
                        .context("supervisor READY pid is invalid");
                }
                if value["event"] == "ERROR" {
                    anyhow::bail!(
                        "process supervisor failed: {}",
                        value["message"].as_str().unwrap_or("unknown error")
                    );
                }
            }
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "timed out waiting for supervisor READY"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn resolve_executable(program: &OsStr) -> Result<PathBuf> {
    let path = Path::new(program);
    if path.is_absolute() {
        return std::fs::canonicalize(path).context("failed to resolve executable");
    }
    which::which(program).context("failed to locate executable on PATH")
}

fn unicode(value: impl AsRef<OsStr>, label: &str) -> Result<String> {
    value
        .as_ref()
        .to_str()
        .map(str::to_owned)
        .with_context(|| format!("{label} is not valid Unicode"))
}
