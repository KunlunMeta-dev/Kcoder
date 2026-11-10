//! One owned command serves configuration/assets without changing the historical entrypoint.
use super::guide_io;
use super::*;
use tokio::sync::mpsc;

fn command(
    arguments: &[String],
    profile: &std::path::Path,
    cwd: &std::path::Path,
) -> Result<(tokio::process::Command, bool)> {
    let Some(action) = arguments.first() else {
        anyhow::bail!("migration_command_required")
    };
    ensure!(
        !arguments.iter().any(|a| a == "--target-profile"
            || a.starts_with("--target-profile=")
            || a == "--cwd"
            || a.starts_with("--cwd=")
            || a == "--jsonl"),
        "migration_owner_override_forbidden"
    );
    ensure!(
        matches!(
            action.as_str(),
            "configure"
                | "transfer"
                | "batch-scan"
                | "plan-batch"
                | "records"
                | "items"
                | "apply-batch"
                | "resume-batch"
                | "rollback-batch"
                | "cancel"
                | "status"
                | "history"
                | "budget"
                | "plugin"
                | "scan"
                | "plan-provider"
                | "apply-provider"
                | "rollback-provider"
                | "--help"
        ),
        "migration_unknown_terminal_operation"
    );
    let guided = action == "configure" || transfer_guide(arguments);
    let mut command = tokio::process::Command::new(std::env::current_exe()?);
    super::launch::apply(&mut command);
    command.arg("migrate").arg(action);
    if action != "--help" && action != "scan" && action != "transfer" {
        command.arg("--target-profile").arg(profile);
    }
    command.args(&arguments[1..]).arg("--cwd").arg(cwd);
    if guided {
        command.arg("--jsonl");
    }
    Ok((command, guided))
}
fn transfer_guide(arguments: &[String]) -> bool {
    if arguments.first().is_none_or(|arg| arg != "transfer") {
        return false;
    }
    let mut args = arguments.iter().skip(1);
    while let Some(arg) = args.next() {
        if matches!(arg.as_str(), "--gateway" | "--access-token-env") {
            args.next();
            continue;
        }
        if arg.starts_with("--gateway=") || arg.starts_with("--access-token-env=") {
            continue;
        }
        return arg == "guide";
    }
    false
}
pub(super) fn start(
    arguments: Vec<String>,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
) {
    if app.migration_task.as_ref().is_some_and(|t| !t.finished()) {
        app.push_message(
            MessageRole::System,
            "已有本地迁移运行中。先作答、等待完成或使用 /migrate stop。",
        );
        return;
    }
    let Some(profile) = engine
        .settings_persistence_path()
        .and_then(|p| p.parent().map(ToOwned::to_owned))
    else {
        app.push_message(MessageRole::System, "当前目标没有明确的私有配置目录。");
        return;
    };
    let cwd = engine.state.cwd().to_path_buf();
    let (mut command, guided) = match command(&arguments, &profile, &cwd) {
        Ok(command) => command,
        Err(error) => {
            app.push_message(MessageRole::System, format!("本地迁移参数错误：{error}"));
            return;
        }
    };
    command
        .stdin(if guided {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let (input, receiver) = guide_io::input(profile, cwd, engine.state.artifact_session_id());
    let pending = input.pending.clone();
    let cancel = CancellationToken::new();
    let worker_cancel = cancel.clone();
    let tx = tx.clone();
    let handle = tokio::spawn(async move {
        let result = tokio::time::timeout(
            Duration::from_secs(1800),
            execute(
                command,
                guided,
                receiver,
                pending,
                worker_cancel.clone(),
                tx.clone(),
            ),
        )
        .await;
        let text = match result {
            Ok(Ok(text)) => text,
            Ok(Err(error)) if worker_cancel.is_cancelled() => {
                format!("本地迁移命令已停止。先按原 jobId 回读，不能据此断言未发布：{error}")
            }
            Ok(Err(error)) => format!("本地迁移未完成：{error}"),
            Err(_) => {
                "本地迁移向导等待超时。先用 /migrate status 回读原作业，不要自动重发操作。".into()
            }
        };
        tx.send_ordered(AppEvent::SystemNotice(text)).await;
    });
    app.migration_task = Some(MigrationTask {
        handle,
        cancel,
        input: Some(input),
    });
}
async fn execute(
    mut command: tokio::process::Command,
    guided: bool,
    receiver: mpsc::Receiver<String>,
    pending: std::sync::Arc<std::sync::Mutex<Option<guide_io::PendingPrompt>>>,
    cancel: CancellationToken,
    tx: AppEventSender,
) -> Result<String> {
    let mut child = command.spawn().context("migration_command_unavailable")?;
    let stdout = child
        .stdout
        .take()
        .context("migration_output_unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("migration_output_unavailable")?;
    let input = child.stdin.take();
    let read = async {
        if guided {
            guide_io::stream(stdout, tx, pending, cancel.clone()).await?;
            Ok(String::new())
        } else {
            let mut bytes = Vec::new();
            stdout
                .take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .await?;
            ensure!(bytes.len() <= 2 * 1024 * 1024, "migration_output_too_large");
            String::from_utf8(bytes).context("migration_invalid_output")
        }
    };
    let errors = async {
        let mut bytes = Vec::new();
        stderr.take(64 * 1024 + 1).read_to_end(&mut bytes).await?;
        ensure!(bytes.len() <= 64 * 1024, "migration_diagnostics_too_large");
        Ok::<_, anyhow::Error>(bytes)
    };
    let wait = async {
        tokio::select! {
            result=child.wait()=>Ok::<_,anyhow::Error>(result?),
            _=cancel.cancelled()=>{
                #[cfg(unix)] if let Some(pid)=child.id(){
                    // The unreaped child retains this owned PID until wait completes.
                    unsafe{libc::kill(pid as libc::pid_t,libc::SIGINT);}
                }
                #[cfg(not(unix))] child.start_kill()?;
                match tokio::time::timeout(Duration::from_secs(8),child.wait()).await {Ok(result)=>Ok(result?),Err(_)=>{child.start_kill()?;Ok(child.wait().await?)}}
            }
        }
    };
    let writer = async {
        if let Some(input) = input {
            guide_io::answers(input, receiver, cancel.clone()).await
        } else {
            std::future::pending::<Result<()>>().await
        }
    };
    tokio::pin!(writer);
    let work = async { tokio::try_join!(read, errors, wait) };
    tokio::pin!(work);
    let (body, errors, status) = tokio::select! {
        result=&mut work=>result?,
        result=&mut writer=>{
            let unexpected=!cancel.is_cancelled();
            cancel.cancel();
            let completed=work.await?;
            result?;
            ensure!(!unexpected,"migration_answer_transport_closed_read_original_job");
            completed
        }
    };
    if cancel.is_cancelled() {
        return Ok("本地迁移命令已停止；是否已发布以原作业回执为准。".into());
    }
    ensure!(
        status.success(),
        "migration_command_failed_use_original_status: {}",
        String::from_utf8_lossy(&errors)
            .chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .take(2048)
            .collect::<String>()
    );
    if guided {
        Ok("本地迁移向导已退出，原记录仍可重新打开；不会自动向模型发送内容。".into())
    } else {
        Ok(format!(
            "本地迁移结果（未向模型发送）：\n```json\n{}\n```",
            serde_json::to_string_pretty(
                &serde_json::from_str::<serde_json::Value>(&body).unwrap_or_else(|_| {
                    serde_json::Value::String(
                        body.chars()
                            .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
                            .collect(),
                    )
                })
            )?
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_uses_the_original_profile_and_workspace_without_opening_prompt_transport() {
        let root = std::env::current_dir().unwrap();
        let profile = root.join("owned-budget-profile");
        let arguments = [
            "budget", "read", "--scope", "history", "--job-id", "original",
        ]
        .map(str::to_owned)
        .to_vec();
        let (child, guided) = command(&arguments, &profile, &root).unwrap();
        assert!(!guided);
        let args = child
            .as_std()
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.windows(2).any(|pair| pair == ["migrate", "budget"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--target-profile", profile.to_str().unwrap()])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--cwd", root.to_str().unwrap()])
        );
        assert!(!args.iter().any(|value| value == "--jsonl"));
        let mut override_attempt = arguments;
        override_attempt.extend(["--target-profile".into(), "other-owner".into()]);
        assert!(command(&override_attempt, &profile, &root).is_err());
    }

    #[test]
    fn transfer_keeps_gateway_authority_separate_from_local_profile_and_rejects_owner_overrides() {
        let root = std::env::current_dir().unwrap();
        let arguments = [
            "transfer",
            "--gateway",
            "https://gateway.invalid",
            "targets",
        ]
        .map(str::to_owned);
        let (command, guided) = command(&arguments, &root, &root).unwrap();
        let args = command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!guided);
        assert!(args.windows(2).any(|pair| pair == ["migrate", "transfer"]));
        assert!(
            !args
                .iter()
                .any(|a| a == "--target-profile" || a == "--jsonl")
        );
        let mut malicious = arguments.to_vec();
        malicious.extend(["--target-profile".into(), "foreign".into()]);
        assert!(super::command(&malicious, &root, &root).is_err());
    }
    #[test]
    fn only_the_transfer_guide_operation_uses_local_prompt_transport() {
        let args = |values: &[&str]| values.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(transfer_guide(&args(&[
            "transfer",
            "--gateway",
            "https://gateway.invalid",
            "guide",
            "--record",
            "private.json"
        ])));
        assert!(transfer_guide(&args(&[
            "transfer",
            "--gateway=https://gateway.invalid",
            "--access-token-env=OWNED",
            "guide"
        ])));
        assert!(!transfer_guide(&args(&[
            "transfer",
            "--gateway",
            "guide",
            "targets"
        ])));
        assert!(!transfer_guide(&args(&[
            "transfer",
            "--gateway",
            "https://gateway.invalid",
            "batch",
            "--target-id",
            "guide",
            "read"
        ])));
    }
}
