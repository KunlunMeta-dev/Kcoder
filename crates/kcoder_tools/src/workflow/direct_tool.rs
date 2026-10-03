//! Durable direct-tool receipts prevent replaying an unknown or completed effect.
use super::*;
use anyhow::{Context, Result, ensure};

impl ToolAgentExecutor {
    pub(super) async fn execute_direct_tool(
        &self,
        id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<Value> {
        ensure!(
            valid_agent_artifact_id(id),
            "workflow_tool: invalid operation id"
        );
        let root = self
            .tool_run_dir
            .as_ref()
            .context("workflow_tool: durable run directory unavailable")?;
        let path = root.join(format!("tool-{id}.json"));
        let request = json!({"name":name,"arguments":arguments});
        if path.exists() {
            let prior: Value = serde_json::from_slice(&secure_read_file(&path, 256 * 1024)?)?;
            ensure!(
                prior["request"] == request,
                "workflow_tool: saved request differs; refusing to replay a different operation"
            );
            match prior["status"].as_str() {
                Some("completed") => return Ok(prior["output"].clone()),
                Some("blocked") => {}
                _ => anyhow::bail!(
                    "workflow_tool: previous outcome is unknown or failed after execution; inspect the prior effect before starting a new run"
                ),
            }
        }
        if self.cancellation.is_cancelled() {
            anyhow::bail!("workflow_tool: cancelled before execution");
        }
        atomic_write_file(
            &path,
            serde_json::to_vec(&json!({"request":request,"status":"pending"}))?,
        )?;
        let (output, may_have_executed) = tokio::select! {
            _ = self.cancellation.cancelled() => anyhow::bail!("workflow_tool: cancelled; operation outcome may be unknown"),
            result = self.runner.run_workflow_tool(id, name, arguments) => result?,
        };
        let content = persist_content(root, id, output.content)?;
        let value = json!({"content":content,"isError":output.is_error});
        let encoded = serde_json::to_vec(&value)?;
        ensure!(
            encoded.len() <= 64 * 1024,
            "workflow_tool: output too large; effect must not be replayed automatically"
        );
        let status = if output.is_error {
            if may_have_executed {
                "failed"
            } else {
                "blocked"
            }
        } else {
            "completed"
        };
        atomic_write_file(
            &path,
            serde_json::to_vec(&json!({"request":request,"status":status,"output":value}))?,
        )?;
        ensure!(!output.is_error, "workflow_tool: {}", value);
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Runner {
        calls: AtomicUsize,
        block_first: bool,
    }
    #[async_trait]
    impl AgentRunner for Runner {
        async fn run_agent(&self, _: String, _: usize) -> Result<String, crate::AgentError> {
            panic!("direct tool must not start a model")
        }
        async fn run_workflow_tool(
            &self,
            _: &str,
            _: &str,
            _: Value,
        ) -> Result<(ToolOutput, bool), crate::AgentError> {
            let count = self.calls.fetch_add(1, Ordering::SeqCst);
            if self.block_first && count == 0 {
                Ok((ToolOutput::error("permission denied"), false))
            } else {
                Ok((ToolOutput::text("done"), true))
            }
        }
    }
    fn executor(root: &std::path::Path, runner: Arc<Runner>) -> ToolAgentExecutor {
        ToolAgentExecutor {
            isolate_context: true,
            runner,
            arrangement_mode: false,
            resume_run_dir: None,
            tool_run_dir: Some(root.into()),
            library_root: None,
            wait_root: None,
            run_id: String::new(),
            cancellation: CancellationToken::new(),
        }
    }
    #[tokio::test]
    async fn completed_tool_is_not_replayed_and_changed_arguments_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let runner = Arc::new(Runner {
            calls: AtomicUsize::new(0),
            block_first: false,
        });
        let executor = executor(temp.path(), runner.clone());
        let first = executor
            .execute_direct_tool("call-1", "fixture", json!({"x":1}))
            .await
            .unwrap();
        assert_eq!(
            executor
                .execute_direct_tool("call-1", "fixture", json!({"x":1}))
                .await
                .unwrap(),
            first
        );
        assert!(
            executor
                .execute_direct_tool("call-1", "fixture", json!({"x":2}))
                .await
                .is_err()
        );
        assert_eq!(runner.calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn unknown_outcome_is_never_automatically_replayed() {
        let temp = tempfile::tempdir().unwrap();
        let runner = Arc::new(Runner {
            calls: AtomicUsize::new(0),
            block_first: false,
        });
        let executor = executor(temp.path(), runner.clone());
        atomic_write_file(
            &temp.path().join("tool-call-1.json"),
            serde_json::to_vec(
                &json!({"request":{"name":"fixture","arguments":{}},"status":"pending"}),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(
            executor
                .execute_direct_tool("call-1", "fixture", json!({}))
                .await
                .unwrap_err()
                .to_string()
                .contains("unknown")
        );
        assert_eq!(runner.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn confirmed_denial_can_be_retried_without_claiming_a_prior_effect() {
        let temp = tempfile::tempdir().unwrap();
        let runner = Arc::new(Runner {
            calls: AtomicUsize::new(0),
            block_first: true,
        });
        let executor = executor(temp.path(), runner.clone());
        assert!(
            executor
                .execute_direct_tool("call-1", "fixture", json!({}))
                .await
                .is_err()
        );
        assert!(
            executor
                .execute_direct_tool("call-1", "fixture", json!({}))
                .await
                .is_ok()
        );
        assert_eq!(runner.calls.load(Ordering::SeqCst), 2);
    }
}

fn persist_content(
    root: &Path,
    id: &str,
    blocks: Vec<kcoder_types::ContentBlock>,
) -> Result<Vec<Value>> {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let mut content = Vec::new();
    for (index, block) in blocks.into_iter().enumerate() {
        match block {
            kcoder_types::ContentBlock::Image { source } => {
                ensure!(
                    source.source_type == "base64" && source.data.len() <= 16 * 1024 * 1024,
                    "workflow_tool: unsupported image source"
                );
                let bytes = base64::engine::general_purpose::STANDARD.decode(&source.data)?;
                let info = crate::image_input::inspect(&bytes, &source.media_type)
                    .map_err(anyhow::Error::msg)?;
                let extension = match source.media_type.as_str() {
                    "image/png" => "png",
                    "image/jpeg" => "jpg",
                    "image/webp" => "webp",
                    "image/gif" => "gif",
                    _ => anyhow::bail!("workflow_tool: unsupported image format"),
                };
                let directory = kcoder_config::PrivateDirectory::open_existing(root)?;
                let existing = directory
                    .open_regular_files(|name| name.to_string_lossy().starts_with("tool-image-"))?;
                let total = existing.into_iter().try_fold(
                    bytes.len() as u64,
                    |total, (_, file)| -> Result<u64> {
                        Ok(total.saturating_add(file.metadata()?.len()))
                    },
                )?;
                ensure!(
                    total <= 16 * 1024 * 1024,
                    "workflow_tool: image artifact quota exceeded"
                );
                let path = root.join(format!("tool-image-{id}-{index}.{extension}"));
                atomic_write_file(&path, &bytes)?;
                content.push(json!({"type":"image","path":path,"mediaType":source.media_type,"width":info.width,"height":info.height,"sha256":format!("{:x}",Sha256::digest(&bytes))}));
            }
            other => content.push(serde_json::to_value(other)?),
        }
    }
    Ok(content)
}
