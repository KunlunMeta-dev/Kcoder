//! Bounded Git observations never start repository hooks, filters or remote transports.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::DeviceExecuteResult;
use kcoder_process_supervisor::owned_process::{OwnedProcess, drain_prefix};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::process::Command;

const CONFIG_BYTES: usize = 32 * 1024;

fn overrides(keys: &str) -> Result<Vec<String>> {
    let mut result = Vec::new();
    for key in keys.split_terminator('\0') {
        ensure!(
            !key.is_empty()
                && key.len() <= 1024
                && !key.contains('=')
                && !key.chars().any(char::is_control),
            "unsafe Git observation configuration key"
        );
        let (prefix, field) = key
            .rsplit_once('.')
            .context("invalid Git observation configuration key")?;
        let value = if let Some(driver) = prefix.strip_prefix("filter.") {
            ensure!(
                !driver.is_empty() && matches!(field, "clean" | "process" | "required"),
                "invalid Git filter key"
            );
            if field == "required" { "false" } else { "" }
        } else if let Some(protocol) = prefix.strip_prefix("protocol.") {
            ensure!(
                !protocol.is_empty() && field == "allow",
                "invalid Git protocol key"
            );
            "never"
        } else {
            anyhow::bail!("unexpected Git observation configuration key")
        };
        result.extend(["-c".into(), format!("{key}={value}")]);
    }
    Ok(result)
}

async fn process(
    cwd: &Path,
    args: &[&str],
    limit: usize,
    timeout: Duration,
) -> Result<DeviceExecuteResult> {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_clear()
        .env(
            "PATH",
            std::env::var_os("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
        )
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_ATTR_NOSYSTEM", "1");
    for key in ["HOME", "USER", "LOGNAME", "XDG_CONFIG_HOME"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "COMSPEC",
            "PATHEXT",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    let mut owned = OwnedProcess::spawn(&mut command).context("cannot start Git observation")?;
    let stdout = owned
        .child
        .stdout
        .take()
        .context("Git stdout unavailable")?;
    let stderr = owned
        .child
        .stderr
        .take()
        .context("Git stderr unavailable")?;
    let work = async {
        let wait = async {
            let status = owned.child.wait().await?;
            owned.terminate_group();
            Ok::<_, std::io::Error>(status)
        };
        let (status, stdout, stderr) = tokio::try_join!(
            wait,
            drain_prefix(stdout, limit),
            drain_prefix(stderr, 4096)
        )?;
        Ok::<_, std::io::Error>((status, stdout, stderr))
    };
    let result = tokio::time::timeout(timeout, work).await;
    owned
        .finish()
        .await
        .context("cannot clean owned Git observation")?;
    let (status, mut stdout, mut stderr) = result.context("Git observation timed out")??;
    let truncated = stdout.len() > limit || stderr.len() > 4096;
    stdout.truncate(limit);
    stderr.truncate(4096);
    let mut stderr = String::from_utf8_lossy(&stderr).into_owned();
    if truncated {
        stderr.push_str("\ngit command output was truncated");
    }
    Ok(DeviceExecuteResult {
        success: status.success() && !truncated,
        exit_code: status.code().unwrap_or(1),
        stdout: String::from_utf8(stdout)
            .context("Git observation output is not valid UTF-8")?
            .into(),
        stderr,
    })
}

pub async fn run_git_observation_command(
    cwd: &Path,
    args: &[&str],
    limit: usize,
    timeout: Duration,
) -> Result<DeviceExecuteResult> {
    let Some(command) = args.first().copied() else {
        anyhow::bail!("Git observation command is required")
    };
    ensure!(
        matches!(
            command,
            "rev-parse"
                | "branch"
                | "remote"
                | "show"
                | "diff"
                | "status"
                | "merge-base"
                | "ls-files"
        ),
        "unsupported Git observation command"
    );
    ensure!(
        command != "remote" || args.get(1) == Some(&"get-url"),
        "Git observation only reads remote URLs"
    );
    ensure!(
        command != "branch" || args == ["branch", "--show-current"],
        "Git observation only reads the current branch"
    );
    ensure!(
        !args
            .iter()
            .any(|arg| arg.starts_with("--recurse-submodules")),
        "recursive submodule observations are unsupported"
    );
    let deadline = tokio::time::Instant::now() + timeout;
    let hooks = format!("core.hooksPath={}", super::git::NULL_DEVICE_PATH);
    let mut safe = vec!["--no-pager".to_owned(), "--no-replace-objects".into()];
    for item in [
        "core.fsmonitor=false",
        "core.untrackedCache=false",
        "submodule.recurse=false",
        "diff.ignoreSubmodules=all",
        "status.submoduleSummary=false",
        "log.showSignature=false",
        "protocol.allow=never",
        "protocol.file.allow=never",
        "protocol.git.allow=never",
        "protocol.http.allow=never",
        "protocol.https.allow=never",
        "protocol.ssh.allow=never",
        "protocol.ext.allow=never",
        &hooks,
    ] {
        safe.extend(["-c".into(), item.into()]);
    }
    let mut query = safe.iter().map(String::as_str).collect::<Vec<_>>();
    query.extend([
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        r"^(filter\..*\.(clean|process|required)|protocol\..*\.allow)$",
    ]);
    let config = process(cwd, &query, CONFIG_BYTES, timeout).await?;
    ensure!(
        config.success || config.exit_code == 1 && config.stderr.is_empty(),
        "Git observation configuration unavailable"
    );
    let keys = config
        .stdout
        .as_str()
        .context("invalid Git observation config")?;
    safe.extend(overrides(keys)?);
    safe.push(command.into());
    if matches!(command, "diff" | "show") {
        safe.extend([
            "--no-ext-diff".into(),
            "--no-textconv".into(),
            "--ignore-submodules=all".into(),
        ]);
    } else if command == "status" {
        safe.push("--ignore-submodules=all".into());
    }
    safe.extend(args[1..].iter().map(|value| (*value).to_owned()));
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    ensure!(!remaining.is_zero(), "Git observation timed out");
    process(
        cwd,
        &safe.iter().map(String::as_str).collect::<Vec<_>>(),
        limit,
        remaining,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsafe_filter_and_protocol_names_are_rejected_before_command_execution() {
        for key in [
            "filter.bad=name.clean\0",
            "filter.bad\nname.process\0",
            "filter..required\0",
            "protocol.bad=name.allow\0",
            "filter.driver.unknown\0",
        ] {
            assert!(overrides(key).is_err(), "unsafe key accepted: {key:?}");
        }
        assert_eq!(overrides("filter.driver.clean\0filter.driver.process\0filter.driver.required\0protocol.helper.allow\0").unwrap(),
            vec!["-c", "filter.driver.clean=", "-c", "filter.driver.process=", "-c", "filter.driver.required=false", "-c", "protocol.helper.allow=never"]);
    }
}

#[cfg(all(test, unix))]
mod process_tests {
    use super::*;
    async fn fixture(cwd: &Path, args: &[&str]) {
        let hooks = format!("core.hooksPath={}", super::super::git::NULL_DEVICE_PATH);
        let attributes = format!(
            "core.attributesFile={}",
            super::super::git::NULL_DEVICE_PATH
        );
        let mut safe = vec![
            "-c",
            &hooks,
            "-c",
            &attributes,
            "-c",
            "core.fsmonitor=false",
            "-c",
            "commit.gpgsign=false",
        ];
        safe.extend_from_slice(args);
        let result = super::super::git::run_git_command(cwd, &safe, 4096, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(result.success, "fixture Git failed: {}", result.stderr);
    }
    #[tokio::test]
    async fn observations_disable_repository_programs_and_preserve_index_bytes() {
        let repo = tempfile::tempdir().unwrap();
        let cwd = repo.path();
        fixture(cwd, &["init", "-b", "main"]).await;
        fixture(cwd, &["config", "user.name", "Observation Fixture"]).await;
        fixture(
            cwd,
            &["config", "user.email", "observation@example.invalid"],
        )
        .await;
        std::fs::write(cwd.join("answer.txt"), "baseline\n").unwrap();
        fixture(cwd, &["add", "answer.txt"]).await;
        fixture(cwd, &["commit", "-m", "baseline"]).await;
        for (key, command) in [
            ("filter.trap.clean", "sh -c 'touch escaped-clean; cat'"),
            (
                "filter.trap.process",
                "sh -c 'touch escaped-process; exit 1'",
            ),
            ("filter.trap.required", "true"),
            ("core.fsmonitor", "sh -c 'touch escaped-monitor; exit 0'"),
            ("diff.trap.textconv", "sh -c 'touch escaped-textconv; cat'"),
            ("diff.external", "sh -c 'touch escaped-diff; exit 1'"),
            ("core.sshCommand", "sh -c 'touch escaped-ssh; exit 1'"),
        ] {
            fixture(cwd, &["config", key, command]).await;
        }
        std::fs::write(
            cwd.join(".gitattributes"),
            "answer.txt filter=trap diff=trap\n",
        )
        .unwrap();
        std::fs::write(cwd.join("answer.txt"), "actual changed bytes\n").unwrap();
        let index = std::fs::read(cwd.join(".git/index")).unwrap();
        for args in [
            vec!["status", "--porcelain=v1", "-z"],
            vec!["diff", "HEAD", "--"],
            vec!["show", "-s", "--format=%s", "HEAD"],
        ] {
            let result = run_git_observation_command(cwd, &args, 8192, Duration::from_secs(5))
                .await
                .unwrap();
            assert!(result.success, "safe observation failed: {}", result.stderr);
        }
        assert_eq!(std::fs::read(cwd.join(".git/index")).unwrap(), index);
        for name in [
            "escaped-clean",
            "escaped-process",
            "escaped-monitor",
            "escaped-textconv",
            "escaped-diff",
            "escaped-ssh",
        ] {
            assert!(
                !cwd.join(name).exists(),
                "observation executed repository program {name}"
            );
        }
        let config = cwd.join(".git/config");
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(config)
            .unwrap()
            .write_all(b"\n[filter \"bad=name\"]\n\tclean = sh -c 'touch escaped-unsafe; cat'\n")
            .unwrap();
        assert!(
            run_git_observation_command(
                cwd,
                &["status", "--porcelain"],
                8192,
                Duration::from_secs(5)
            )
            .await
            .is_err()
        );
        assert!(!cwd.join("escaped-unsafe").exists());
    }
}
