//! Owned local migration subprocesses keep the terminal responsive and model context unchanged.
use crate::{AppEvent, AppEventSender, MessageRole, QueryEngine, ReplApp};
use anyhow::{Context, Result, ensure};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, task::JoinHandle};
use tokio_util::sync::CancellationToken;
mod general;
mod guide_io;
mod launch;
pub(super) fn capture_launch(cwd: &std::path::Path) {
    launch::capture(cwd);
}
pub(super) fn start_general(
    arguments: Vec<String>,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
) {
    general::start(arguments, engine, app, tx);
}

pub(super) struct MigrationTask {
    handle: JoinHandle<()>,
    cancel: CancellationToken,
    input: Option<guide_io::GuideInput>,
}
impl MigrationTask {
    pub fn finished(&self) -> bool {
        self.handle.is_finished()
    }
    pub fn request_stop(&self) {
        if let Some(input) = &self.input {
            input.invalidate();
        }
        self.cancel.cancel();
    }
    pub fn answer(&self, engine: &QueryEngine, id: &str, value: &str) -> Result<()> {
        ensure!(
            !self.finished() && !self.cancel.is_cancelled(),
            "migration_answer_unavailable"
        );
        let input = self
            .input
            .as_ref()
            .context("migration_answer_unavailable")?;
        if !input.matches(engine) {
            self.request_stop();
            anyhow::bail!("migration_answer_owner_changed");
        }
        input.answer(id, value)
    }
    pub async fn stop(mut self) {
        self.request_stop();
        if tokio::time::timeout(Duration::from_secs(10), &mut self.handle)
            .await
            .is_err()
        {
            self.handle.abort();
            let _ = (&mut self.handle).await;
        }
    }
}
impl Drop for MigrationTask {
    fn drop(&mut self) {
        self.request_stop();
        self.handle.abort();
    }
}

/// Quotes group native arguments; backslashes remain literal for Windows paths. No shell runs.
pub(super) fn arguments(text: &str) -> Result<Vec<String>> {
    ensure!(text.len() <= 64 * 1024, "migration_arguments_too_large");
    if text.trim_start().starts_with('[') {
        let args: Vec<String> = serde_json::from_str(text).context("invalid argument array")?;
        ensure!(args.len() <= 128, "migration_too_many_arguments");
        return Ok(args);
    }
    let (mut args, mut current, mut quote, mut begun) = (Vec::new(), String::new(), None, false);
    for character in text.chars() {
        match quote {
            Some(delimiter) if character == delimiter => quote = None,
            Some(_) => current.push(character),
            None if character == '\'' || character == '"' => {
                quote = Some(character);
                begun = true;
            }
            None if character.is_whitespace() => {
                if begun {
                    args.push(std::mem::take(&mut current));
                    begun = false;
                }
            }
            None => {
                current.push(character);
                begun = true;
            }
        }
    }
    ensure!(quote.is_none(), "unterminated quote");
    if begun {
        args.push(current);
    }
    ensure!(args.len() <= 128, "migration_too_many_arguments");
    Ok(args)
}
pub(super) fn start(
    arguments: Vec<String>,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
) {
    if app
        .migration_task
        .as_ref()
        .is_some_and(|task| !task.finished())
    {
        app.push_message(
            MessageRole::System,
            "已有本地迁移命令运行中。请等待完成，或使用 /migration stop。",
        );
        return;
    }
    let Some(profile) = engine
        .settings_persistence_path()
        .and_then(|path| path.parent().map(ToOwned::to_owned))
    else {
        app.push_message(MessageRole::System, "当前运行目标没有可用的私有配置目录。");
        return;
    };
    let cwd = engine.state.cwd().to_path_buf();
    let tx = tx.clone();
    app.push_message(
        MessageRole::System,
        "正在执行本地迁移命令；界面可继续滚动，使用 /migration stop 停止。",
    );
    let cancel = CancellationToken::new();
    let worker_cancel = cancel.clone();
    let handle = tokio::spawn(async move {
        let result = tokio::time::timeout(
            Duration::from_secs(360),
            execute(arguments, profile, cwd, worker_cancel),
        )
        .await;
        let text = match result {
            Ok(Ok(text)) => text,
            Ok(Err(error)) => format!("本地迁移失败：{error:#}"),
            Err(_) => "本地迁移等待超时。请使用原作业 ID 读取状态；不要自动重复发布。".to_owned(),
        };
        tx.send_ordered(AppEvent::SystemNotice(text)).await;
    });
    app.migration_task = Some(MigrationTask {
        handle,
        cancel,
        input: None,
    });
}
async fn execute(
    arguments: Vec<String>,
    profile: PathBuf,
    cwd: PathBuf,
    cancel: CancellationToken,
) -> Result<String> {
    let mut command = tokio::process::Command::new(std::env::current_exe()?);
    launch::apply(&mut command);
    command
        .arg("migrate")
        .arg("history")
        .arg("--target-profile")
        .arg(profile)
        .args(arguments)
        .arg("--cwd")
        .arg(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().context("migration_command_unavailable")?;
    let stdout = child
        .stdout
        .take()
        .context("migration_output_unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("migration_output_unavailable")?;
    let read = async |output: tokio::process::ChildStdout| -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        output
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await?;
        ensure!(bytes.len() <= 2 * 1024 * 1024, "migration_output_too_large");
        Ok(bytes)
    };
    let errors = async move {
        let mut bytes = Vec::new();
        stderr.take(64 * 1024 + 1).read_to_end(&mut bytes).await?;
        ensure!(bytes.len() <= 64 * 1024, "migration_diagnostics_too_large");
        Ok::<_, anyhow::Error>(bytes)
    };
    let wait = async {
        tokio::select! {
            status = child.wait() => Ok::<_,anyhow::Error>(status?),
            _ = cancel.cancelled() => {
                #[cfg(unix)]
                if let Some(pid) = child.id() {
                    // The unreaped owned child keeps its PID reserved until this wait completes.
                    unsafe { libc::kill(pid as libc::pid_t, libc::SIGINT); }
                }
                #[cfg(not(unix))]
                child.start_kill()?;
                match tokio::time::timeout(Duration::from_secs(8), child.wait()).await {
                    Ok(status) => Ok(status?),
                    Err(_) => { child.start_kill()?; Ok(child.wait().await?) }
                }
            }
        }
    };
    let (stdout, stderr, status) = tokio::try_join!(read(stdout), errors, wait)?;
    let output = String::from_utf8(stdout).context("migration_invalid_output")?;
    // JSON encoding keeps terminal controls and widget-like source text inert in the local notice.
    let body = if let Ok(value) = serde_json::from_str::<serde_json::Value>(&output) {
        serde_json::to_string_pretty(&value)?
    } else {
        output
    };
    if status.success() {
        Ok(format!(
            "本地迁移结果（未向模型发送）：\n```json\n{body}\n```"
        ))
    } else if cancel.is_cancelled() {
        Ok(format!(
            "本地迁移命令已停止；是否已发布以原作业回执为准：\n```json\n{body}\n```"
        ))
    } else {
        anyhow::bail!(
            "{}\n{}",
            body,
            String::from_utf8_lossy(&stderr)
                .chars()
                .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
                .take(4096)
                .collect::<String>()
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_arguments_preserve_windows_paths_and_never_expand_shell_code() {
        assert_eq!(
            arguments(
                r#"scan --source-root "C:\Users\some user\.claude" --value '$(touch marker)'"#
            )
            .unwrap(),
            vec![
                "scan",
                "--source-root",
                r"C:\Users\some user\.claude",
                "--value",
                "$(touch marker)"
            ]
        );
        assert_eq!(
            arguments(r#"["text","--offset","0"]"#).unwrap(),
            vec!["text", "--offset", "0"]
        );
        assert!(arguments("scan 'broken").is_err());
    }
    #[test]
    fn native_arguments_bound_allocation() {
        assert!(arguments(&"x".repeat(65537)).is_err());
        assert!(arguments(&["x"; 129].join(" ")).is_err());
    }
}
