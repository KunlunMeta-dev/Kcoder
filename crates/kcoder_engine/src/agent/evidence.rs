//! Agent evidence; state ownership is retained by the agent facade.

use super::*;

pub(super) async fn persist_orchestrate_agent_evidence(
    parent: &QueryEngine,
    agent_id: &str,
    messages: &[Message],
    trusted_tool_results: &HashMap<String, ToolOutput>,
    execution_root: &Path,
    output: &str,
) -> anyhow::Result<()> {
    if !parent.state.session_mode().is_orchestrate() {
        return Ok(());
    }
    let store = kcoder_state::orchestrate_store::PlanStore::for_workspace(&parent.cwd);
    let Some(work_id) = store.active_work_id()? else {
        return Ok(());
    };
    let snapshot = store.read_work(&work_id)?;
    let run = AgentRunResult::from_messages_with_trusted_tool_results(
        output.to_string(),
        messages,
        trusted_tool_results,
        false,
        false,
        true,
        true,
    );
    if !run.tool_trace_complete {
        return Ok(());
    }
    let workspace_digest = workspace_evidence_digest(execution_root).await;
    for execution in run.tool_executions {
        if execution.is_error == Some(true) {
            continue;
        }
        let mut evidence_items = Vec::new();
        if matches!(execution.name.as_str(), "bash" | "PowerShell") {
            let Some(command) = execution
                .input
                .get("command")
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            evidence_items.push(
                kcoder_state::orchestrate_store::AgentEvidenceKind::ProcessExit {
                    tool: execution.name.clone(),
                    command: command.to_string(),
                    exit_code: execution.process_exit_code,
                    signal: execution.process_signal,
                    cwd: execution
                        .process_cwd
                        .unwrap_or_else(|| execution_root.to_path_buf()),
                    raw_exit_code: execution.raw_exit_code,
                },
            );
        }
        for artifact in execution.artifacts {
            let visual = execution.name == "read"
                && artifact
                    .path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        matches!(
                            extension.to_ascii_lowercase().as_str(),
                            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
                        )
                    });
            evidence_items.push(if visual {
                kcoder_state::orchestrate_store::AgentEvidenceKind::Visual {
                    artifact_path: artifact.path,
                    sha256: artifact.sha256,
                }
            } else {
                kcoder_state::orchestrate_store::AgentEvidenceKind::Artifact {
                    tool: execution.name.clone(),
                    path: artifact.path,
                    sha256: artifact.sha256,
                }
            });
        }
        if execution.name == "SpecValidate" {
            evidence_items.push(kcoder_state::orchestrate_store::AgentEvidenceKind::Schema {
                subject: execution.input.to_string(),
                schema_sha256: format!("{:x}", Sha256::digest(execution.output.as_bytes())),
            });
        }
        if execution.name == "WebFetch"
            && let Some(url) = execution
                .input
                .get("url")
                .or_else(|| execution.input.get("query"))
                .and_then(serde_json::Value::as_str)
        {
            evidence_items.push(
                kcoder_state::orchestrate_store::AgentEvidenceKind::Citation {
                    url: url.to_string(),
                    source_date: None,
                },
            );
        }
        for evidence in evidence_items {
            let record = kcoder_state::orchestrate_store::AgentEvidence {
                evidence_id: String::new(),
                work_id: work_id.clone(),
                revision: snapshot.work.revision,
                plan_sha256: snapshot.work.plan_sha256.clone(),
                agent_id: agent_id.to_string(),
                workspace_digest: workspace_digest.clone(),
                recorded_at: chrono::Utc::now(),
                evidence,
            };
            // A plan tool that creates a new revision invalidates remaining evidence for the
            // old revision in this run. Treat this race as fail-closed without attributing the
            // partial-trace mismatch to agent failure.
            match store.append_evidence(&work_id, record) {
                Ok(saved) => {
                    let evidence_kind = match &saved.evidence {
                        kcoder_state::orchestrate_store::AgentEvidenceKind::ProcessExit {
                            ..
                        } => "process_exit",
                        kcoder_state::orchestrate_store::AgentEvidenceKind::Artifact { .. } => {
                            "artifact"
                        }
                        kcoder_state::orchestrate_store::AgentEvidenceKind::Citation { .. } => {
                            "citation"
                        }
                        kcoder_state::orchestrate_store::AgentEvidenceKind::Manual { .. } => {
                            "manual"
                        }
                        kcoder_state::orchestrate_store::AgentEvidenceKind::Schema { .. } => {
                            "schema"
                        }
                        kcoder_state::orchestrate_store::AgentEvidenceKind::Visual { .. } => {
                            "visual"
                        }
                        kcoder_state::orchestrate_store::AgentEvidenceKind::NotApplicable {
                            ..
                        } => "not_applicable",
                    };
                    parent.state.record_orchestrate_runtime_event_after_commit(
                        "evidence_recorded",
                        Some(&work_id),
                        None,
                        Some(agent_id),
                        None,
                        serde_json::json!({
                            "evidence_id": saved.evidence_id,
                            "revision": saved.revision,
                            "evidence_kind": evidence_kind,
                        }),
                    );
                }
                Err(error) => {
                    warn!(%error, %agent_id, "discarding stale Orchestrate evidence");
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

pub(super) async fn workspace_evidence_digest(root: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(root.to_string_lossy().as_bytes());
    for args in [
        &[
            "diff",
            "--binary",
            "--no-ext-diff",
            "HEAD",
            "--",
            ".",
            ":(exclude).kcoder/orchestrate/**",
        ] as &[&str],
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
            ":(exclude).kcoder/orchestrate/**",
        ],
    ] {
        match tokio::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .await
        {
            Ok(output) => {
                digest.update(output.status.code().unwrap_or(-1).to_le_bytes());
                digest.update(&output.stdout);
                digest.update(&output.stderr);
            }
            Err(error) => digest.update(error.to_string().as_bytes()),
        }
    }
    format!("{:x}", digest.finalize())
}
