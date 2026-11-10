//! Fixed component process adapter; paths originate only in trusted host packaging.
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_engine::integrations::office::OfficeGeneratedFile;
use kcoder_types::integrations::office::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[path = "node_launch_paths.rs"]
mod node_launch_paths;
#[path = "node_process.rs"]
mod node_process;
use node_launch_paths::office_node_launch_path;
use node_process::OwnedOfficeNodeProcess;
use std::sync::Arc;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeNodeRuntimeMode {
    StandaloneNode,
    ElectronAsNode,
}
#[async_trait]
pub trait NativeOfficeResourceVerifier: Send + Sync {
    /// Loading a new worker must verify the actual executable/component bytes.
    async fn verify(&self, cancel: &CancellationToken) -> Result<()>;
    fn verify_readiness(&self, _probe: &Value) -> Result<()> {
        Ok(())
    }
    /// Observing task/tool authority does not load code. Older implementations
    /// conservatively retain the full check until they provide an owner fence.
    async fn verify_owner(&self, cancel: &CancellationToken) -> Result<()> {
        self.verify(cancel).await
    }
}
pub struct NativeOfficeNodeLaunch {
    pub mode: OfficeNodeRuntimeMode,
    pub owner_program: PathBuf,
    pub verify: Arc<dyn NativeOfficeResourceVerifier>,
}
fn configure_office_node_command(
    command: &mut Command,
    entry: &Path,
    package: &Path,
    mode: OfficeNodeRuntimeMode,
) {
    command
        .args([
            "--max-old-space-size=256",
            "--disable-proto=throw",
            "--no-addons",
        ])
        .arg(office_node_launch_path(entry))
        .current_dir(office_node_launch_path(package))
        .env_clear()
        .env("LANG", "C.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if mode == OfficeNodeRuntimeMode::ElectronAsNode {
        command.env("ELECTRON_RUN_AS_NODE", "1");
    }
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
}
pub struct OfficeNodeGenerator {
    node: PathBuf,
    entry: PathBuf,
    package: PathBuf,
    native: Option<NativeOfficeNodeLaunch>,
    ready: tokio::sync::OnceCell<()>,
}
impl OfficeNodeGenerator {
    pub async fn verify_native_owner(&self, cancel: &CancellationToken) -> Result<()> {
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        self.native
            .as_ref()
            .context("OFFICE_NATIVE_RESOURCES_REQUIRED")?
            .verify
            .verify_owner(cancel)
            .await?;
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        Ok(())
    }
    pub fn from_trusted_paths(node: &Path, package: &Path) -> Result<Self> {
        let node = node.canonicalize().context("OFFICE_NODE_UNAVAILABLE")?;
        let package = package
            .canonicalize()
            .context("OFFICE_COMPONENT_UNAVAILABLE")?;
        let entry = package
            .join("src/cli.mjs")
            .canonicalize()
            .context("OFFICE_COMPONENT_UNAVAILABLE")?;
        ensure!(
            node.is_file() && package.is_dir() && entry.is_file() && entry.starts_with(&package),
            "OFFICE_COMPONENT_UNAVAILABLE"
        );
        Ok(Self {
            node,
            entry,
            package,
            native: None,
            ready: tokio::sync::OnceCell::new(),
        })
    }
    pub fn from_verified_native_launch(
        node: &Path,
        package: &Path,
        native: NativeOfficeNodeLaunch,
    ) -> Result<Self> {
        let mut generator = Self::from_trusted_paths(node, package)?;
        generator.native = Some(native);
        Ok(generator)
    }
    pub async fn readiness(&self, cancel: &CancellationToken) -> Result<Value> {
        let probe = self.call(json!({"method":"probe"}), 60_000, cancel).await?;
        if let Some(native) = &self.native {
            native.verify.verify_readiness(&probe)?;
        }
        Ok(probe)
    }
    pub fn mark_ready(&self) {
        let _ = self.ready.set(());
    }
    pub async fn generate(
        &self,
        specification: &Value,
        timeout_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<OfficeGeneratedFile> {
        if self.native.is_some() {
            self.ready
                .get_or_try_init(|| async { self.readiness(cancel).await.map(|_| ()) })
                .await?;
        }
        let value = self
            .call(
                json!({"method":"generate","specification":specification,"timeoutMs":timeout_ms}),
                timeout_ms,
                cancel,
            )
            .await?;
        let format: OfficeFileFormat = serde_json::from_value(
            value
                .get("kind")
                .cloned()
                .context("OFFICE_GENERATOR_IDENTITY_MISMATCH")?,
        )?;
        let bytes = STANDARD
            .decode(
                value
                    .get("bytesBase64")
                    .and_then(Value::as_str)
                    .context("OFFICE_GENERATOR_IDENTITY_MISMATCH")?,
            )
            .context("OFFICE_GENERATOR_IDENTITY_MISMATCH")?;
        ensure!(
            bytes.len() as u64 <= OFFICE_MAX_ARTIFACT_BYTES
                && value.get("size").and_then(Value::as_u64) == Some(bytes.len() as u64)
                && value.get("sha256").and_then(Value::as_str)
                    == Some(format!("{:x}", Sha256::digest(&bytes)).as_str()),
            "OFFICE_GENERATOR_IDENTITY_MISMATCH"
        );
        ensure!(
            value
                .pointer("/verification/structuralStatus")
                .and_then(Value::as_str)
                == Some("passed"),
            "OFFICE_STRUCTURE_UNCONFIRMED"
        );
        Ok(OfficeGeneratedFile {
            format,
            bytes,
            generator: {
                let identity: OfficeGeneratorIdentity = serde_json::from_value(
                    value
                        .get("generator")
                        .cloned()
                        .context("OFFICE_COMPONENT_IDENTITY_UNAVAILABLE")?,
                )
                .context("OFFICE_COMPONENT_IDENTITY_UNAVAILABLE")?;
                identity.validate()?;
                identity
            },
            verification: OfficeVerification {
                status: OfficeVerificationStatus::Partial,
                completed_checks: vec!["ooxml_structure".into(), "content_identity".into()],
                pending_checks: vec!["reader".into(), "semantic_acceptance".into()],
                reader_status: OfficeVerificationStatus::Pending,
                formula_calculation: if format == OfficeFileFormat::Xlsx {
                    "not_performed".into()
                } else {
                    "not_applicable".into()
                },
            },
        })
    }
    async fn call(
        &self,
        input: Value,
        timeout_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        ensure!(
            (1..=60_000).contains(&timeout_ms) && !cancel.is_cancelled(),
            "OFFICE_INVALID_WAIT_BUDGET"
        );
        let input = encode_office_node_request(&input)?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        let mut owned = None;
        let mut legacy = None;
        let outcome = {
            let child = if let Some(native) = &self.native {
                native.verify.verify(cancel).await?;
                ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
                ensure!(tokio::time::Instant::now() < deadline, "OFFICE_TIMEOUT");
                owned = Some(
                    OwnedOfficeNodeProcess::spawn(&self.node, &self.entry, &self.package, native)
                        .await?,
                );
                &mut owned.as_mut().context("OFFICE_PROCESS_PROTOCOL")?.child
            } else {
                let mut command = Command::new(office_node_launch_path(&self.node));
                configure_office_node_command(
                    &mut command,
                    &self.entry,
                    &self.package,
                    OfficeNodeRuntimeMode::StandaloneNode,
                );
                command.kill_on_drop(true);
                legacy = Some(command.spawn().context("OFFICE_COMPONENT_UNAVAILABLE")?);
                legacy.as_mut().context("OFFICE_PROCESS_PROTOCOL")?
            };
            let mut stdin = child.stdin.take().context("OFFICE_PROCESS_PROTOCOL")?;
            let stdout = child.stdout.take().context("OFFICE_PROCESS_PROTOCOL")?;
            let complete = async {
                stdin.write_all(&input).await?;
                stdin.shutdown().await?;
                drop(stdin);
                let mut output = Vec::new();
                stdout
                    .take(32 * 1024 * 1024 + 1)
                    .read_to_end(&mut output)
                    .await?;
                ensure!(output.len() <= 32 * 1024 * 1024, "OFFICE_OUTPUT_TOO_LARGE");
                let status = child.wait().await.context("OFFICE_PROCESS_PROTOCOL")?;
                let response: Value =
                    serde_json::from_slice(&output).context("OFFICE_PROCESS_PROTOCOL")?;
                if !status.success() || response.get("ok") != Some(&Value::Bool(true)) {
                    let code = response
                        .pointer("/error/code")
                        .and_then(Value::as_str)
                        .and_then(office_public_error_code)
                        .unwrap_or("OFFICE_GENERATION_FAILED");
                    anyhow::bail!("{code}");
                }
                response
                    .get("result")
                    .cloned()
                    .context("OFFICE_PROCESS_PROTOCOL")
            };
            tokio::pin!(complete);
            tokio::select! {result=&mut complete=>result,_=cancel.cancelled()=>Err(anyhow::anyhow!("OFFICE_CANCELLED")),_=tokio::time::sleep_until(deadline)=>Err(anyhow::anyhow!("OFFICE_TIMEOUT"))}
        };
        if let Some(owned) = owned.as_mut() {
            owned.terminate().await?;
        } else if outcome.is_err()
            && let Some(child) = legacy.as_mut()
        {
            terminate_owned(child).await?;
        }
        outcome
    }
}
fn encode_office_node_request(input: &Value) -> Result<Vec<u8>> {
    let input = serde_json::to_vec(input)?;
    // The canonical specification has its own exact 1 MiB validation. The
    // fixed private method/timeout envelope must fit independently of it.
    ensure!(
        input.len() <= 1024 * 1024 + 16 * 1024,
        "OFFICE_INPUT_TOO_LARGE"
    );
    Ok(input)
}

async fn terminate_owned(child: &mut tokio::process::Child) -> Result<()> {
    if child
        .try_wait()
        .context("OFFICE_CLEANUP_UNCONFIRMED")?
        .is_some()
    {
        return Ok(());
    }
    child.start_kill().context("OFFICE_CLEANUP_UNCONFIRMED")?;
    tokio::time::timeout(std::time::Duration::from_secs(2), child.wait())
        .await
        .context("OFFICE_CLEANUP_UNCONFIRMED")?
        .context("OFFICE_CLEANUP_UNCONFIRMED")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_request_framing_allows_full_specification_and_remains_bounded() {
        let specification = json!({"text":"a".repeat(1024*1024-11)});
        assert_eq!(
            serde_json::to_vec(&specification).unwrap().len(),
            1024 * 1024
        );
        let framed = json!({"method":"generate","specification":specification,"timeoutMs":30000});
        assert!(encode_office_node_request(&framed).unwrap().len() > 1024 * 1024);
        assert!(encode_office_node_request(&json!("a".repeat(1024 * 1024 + 16 * 1024))).is_err());
    }
    #[tokio::test]
    #[ignore = "Requires pinned Office components and an explicitly selected local Node runtime"]
    async fn actual_node_process_generates_three_formats_and_cancels_owned_process() {
        let node =
            std::env::var_os("KCODER_OFFICE_COMPONENT_TEST_NODE").expect("explicit test Node path");
        let package = kcoder_test_harness::workspace_root()
            .expect("resolve current workspace")
            .join("crates/kcoder_cli")
            .join("../../apps/kcoder-office-components");
        let generator =
            OfficeNodeGenerator::from_trusted_paths(Path::new(&node), &package).unwrap();
        let token = CancellationToken::new();
        let probe = generator.readiness(&token).await.unwrap();
        assert_eq!(probe["status"], "available");
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwSpn2HwAEJAIsVIWyawAAAABJRU5ErkJggg==";
        let cases = [
            json!({"schemaVersion":1,"kind":"docx","title":"会议纪要","paragraphs":(0..12).map(|index|json!({"text":format!("段落{index}：{}","金额1234.56元；责任人待确认。".repeat(60))})).collect::<Vec<_>>()}),
            json!({"schemaVersion":1,"kind":"xlsx","title":"表格核对","sheets":[{"name":"明细","columns":[{"key":"amount","title":"金额","type":"number"}],"rows":[[1234.56],[200]],"formulas":[{"cell":"A4","formula":"=SUM(A2:A3)"}]},{"name":"另一个工作表","columns":[{"key":"literal","title":"原文","type":"string"}],"rows":[["保留第二个工作表"]]}]}),
            json!({"schemaVersion":1,"kind":"pptx","title":"工作汇报","slides":(0..12).map(|index|json!({"title":format!("已核对事项{index}"),"paragraphs":["1234.56元；日期待确认"],"notes":format!("完整备注{index}"),"images":[{"data":png,"alt":"Controlled synthetic one-pixel material"}]})).collect::<Vec<_>>()}),
        ];
        let directory = tempfile::tempdir().unwrap();
        let owner = kcoder_types::integrations::core::IntegrationOwner {
            account_id: "owned-native-case".into(),
            target_id: "local-case".into(),
            workspace_id: kcoder_types::integrations::core::IntegrationNullable::Null,
            organization_id: None,
        };
        let store = kcoder_state::integrations::office::OfficeStore::create(
            &directory.path().join("canonical-office"),
            owner.clone(),
        )
        .unwrap();
        for (index, specification) in cases.into_iter().enumerate() {
            let file = generator
                .generate(&specification, 30_000, &token)
                .await
                .unwrap();
            assert_eq!(&file.bytes[..2], b"PK");
            assert_eq!(
                file.verification.reader_status,
                OfficeVerificationStatus::Pending
            );
            let path = directory
                .path()
                .join(format!("result.{}", file.format.extension()));
            std::fs::write(&path, &file.bytes).unwrap();
            assert_eq!(std::fs::read(path).unwrap(), file.bytes);
            let operation = format!("real-generation-{index}");
            let task = OfficeTaskRef {
                thread_id: "native-file-case".into(),
                turn_id: format!("turn-{index}"),
                run_id: None,
            };
            store
                .prepare_canonical_generation(
                    &operation,
                    task.clone(),
                    &specification,
                    Vec::new(),
                    1,
                )
                .unwrap();
            let manifest = OfficeArtifactManifest {
                schema_version: 1,
                id: format!("artifact-{index}"),
                revision: 1,
                owner: owner.clone(),
                task,
                kind: if file.format == OfficeFileFormat::Xlsx {
                    OfficeArtifactKind::Table
                } else {
                    OfficeArtifactKind::Document
                },
                title: "Actual Node canonical fixture".into(),
                format: file.format,
                bytes: file.bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&file.bytes)),
                source_refs: Vec::new(),
                verification: file.verification,
                dataset: None,
                created_at_ms: 1,
                presentation: None,
            };
            store
                .publish_generated_artifact(
                    &format!("publish-{index}"),
                    &operation,
                    manifest.clone(),
                    &file.bytes,
                    file.generator,
                )
                .unwrap();
            let reopened = kcoder_state::integrations::office::OfficeStore::open_existing(
                &directory.path().join("canonical-office"),
                owner.clone(),
            )
            .unwrap()
            .unwrap();
            let reference = OfficeArtifactRef {
                id: manifest.id,
                revision: 1,
            };
            let metadata = reopened
                .read_canonical_source(&reference, None, 0, 64 * 1024, true)
                .unwrap();
            let source = metadata.source.unwrap();
            let mut offset = 0;
            let mut json = String::new();
            loop {
                let part = reopened
                    .read_canonical_source(
                        &reference,
                        Some(&source.specification_sha256),
                        offset,
                        64 * 1024,
                        false,
                    )
                    .unwrap();
                json.push_str(part.chunk.as_deref().unwrap());
                if part.complete {
                    break;
                }
                offset = part.next_offset.unwrap();
            }
            assert_eq!(serde_json::from_str::<Value>(&json).unwrap(), specification);
            assert_eq!(
                source.output_sha256,
                format!("{:x}", Sha256::digest(&file.bytes))
            );
            assert_eq!(
                reopened
                    .generation_publication(&operation)
                    .unwrap()
                    .unwrap()
                    .sha256,
                source.output_sha256
            );
            let (first, total) = reopened
                .read_artifact_chunk(&reference, 0, 512 * 1024)
                .unwrap();
            assert_eq!(total, file.bytes.len() as u64);
            assert_eq!(first, &file.bytes[..first.len()]);
        }
        let error = generator
            .generate(
                &json!({"schemaVersion":1,"kind":"docx","title":"timeout","paragraphs":[]}),
                1,
                &token,
            )
            .await
            .err()
            .unwrap();
        assert_eq!(error.to_string(), "OFFICE_TIMEOUT");
    }

    #[tokio::test]
    #[ignore = "Requires explicitly selected local Node runtime"]
    async fn closed_stdout_does_not_escape_timeout_or_cancellation() {
        let node =
            std::env::var_os("KCODER_OFFICE_COMPONENT_TEST_NODE").expect("explicit test Node path");
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("src")).unwrap();
        let fixture = kcoder_test_harness::workspace_root()
            .expect("resolve current workspace")
            .join("crates/kcoder_cli")
            .join("../../apps/kcoder-office-components/test/fixtures/close-stdout-hang.mjs");
        std::fs::copy(fixture, directory.path().join("src/cli.mjs")).unwrap();
        let generator =
            OfficeNodeGenerator::from_trusted_paths(Path::new(&node), directory.path()).unwrap();
        let start = std::time::Instant::now();
        let token = CancellationToken::new();
        let error = generator
            .call(json!({"method":"probe"}), 300, &token)
            .await
            .err()
            .unwrap();
        assert_eq!(error.to_string(), "OFFICE_TIMEOUT");
        assert!(start.elapsed() < std::time::Duration::from_secs(3));
        #[cfg(unix)]
        {
            let pid = std::fs::read_to_string(directory.path().join("pid"))
                .unwrap()
                .parse::<i32>()
                .unwrap();
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        }
        let token = CancellationToken::new();
        let trigger = token.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            trigger.cancel();
        });
        let start = std::time::Instant::now();
        let error = generator
            .call(json!({"method":"probe"}), 60_000, &token)
            .await
            .err()
            .unwrap();
        assert_eq!(error.to_string(), "OFFICE_CANCELLED");
        assert!(start.elapsed() < std::time::Duration::from_secs(3));
        task.await.unwrap();
        #[cfg(unix)]
        {
            let pid = std::fs::read_to_string(directory.path().join("pid"))
                .unwrap()
                .parse::<i32>()
                .unwrap();
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        }
    }
}

#[cfg(test)]
#[path = "node_generator_load_guard_tests.rs"]
mod load_guard_tests;
