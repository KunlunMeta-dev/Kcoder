//! ACP output evidence uses the original Native Office store and Reader; it is never a business success receipt.
use super::*;
use kcoder_acp::outbound::OutboundPromptReceipt;
use kcoder_engine::QueryEngine;
use kcoder_office_worker::read_worker::{OfficeReadHeader, OfficeReadWorker};
use kcoder_state::integrations::office::OfficeStore;
use kcoder_tools::ToolContext;
use kcoder_types::integrations::{core::IntegrationOwner, office::*};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

/// Captured from this original transport's returned receipt, never caller JSON or a local path.
pub struct NativeRemoteReceivedOutput {
    operation: String,
    session: String,
    original_input_sha256: String,
    recipient_sha256: String,
    bytes: Vec<u8>,
    sha256: String,
    format: OfficeFileFormat,
    native_result: Option<OfficeArtifactManifest>,
}
impl NativeRemoteReceivedOutput {
    pub fn capture(journal: &NativeRemoteJournal, received: OutboundPromptReceipt) -> Result<Self> {
        journal.check_current()?;
        let original = journal
            .store()
            .read(journal.operation_id())?
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
        ensure!(original.stages.get(&NativeRemoteStage::Prompt) == Some(&kcoder_state::integrations::core::remote_delegations::NativeRemoteStageState::Received), "REMOTE_ORIGINAL_PROMPT_RECEIPT_REQUIRED");
        let session = received.session.session_id.to_string();
        ensure!(
            original
                .safe_receipts
                .get(&NativeRemoteStage::Session)
                .and_then(|receipt| receipt["sessionId"].as_str())
                == Some(session.as_str()),
            "REMOTE_ORIGINAL_SESSION_CHANGED"
        );
        let prompt_receipt = original
            .safe_receipts
            .get(&NativeRemoteStage::Prompt)
            .context("REMOTE_ORIGINAL_PROMPT_RECEIPT_REQUIRED")?;
        ensure!(
            prompt_receipt["updateCount"].as_u64() == Some(received.updates.len() as u64)
                && prompt_receipt["stopReason"]
                    == serde_json::to_value(received.response.stop_reason)?,
            "REMOTE_ORIGINAL_PROMPT_RECEIPT_CHANGED"
        );
        let mut text = String::new();
        for update in received.updates {
            ensure!(
                update.session_id.to_string() == session,
                "REMOTE_ORIGINAL_SESSION_CHANGED"
            );
            let update = serde_json::to_value(update)?;
            if update["update"]["sessionUpdate"] == "agent_message_chunk" {
                ensure!(
                    update["update"]["content"]["type"] == "text",
                    "REMOTE_OUTPUT_KIND_UNSUPPORTED"
                );
                let part = update["update"]["content"]["text"]
                    .as_str()
                    .context("REMOTE_OUTPUT_KIND_UNSUPPORTED")?;
                ensure!(
                    text.len().saturating_add(part.len()) <= 4 * 1024 * 1024,
                    "REMOTE_OUTPUT_LIMIT"
                );
                text.push_str(part);
            }
        }
        let recipient_sha256 = hash(&serde_json::to_vec(&original.recipient_identity)?);
        // This is a sourced protocol-output document, not a claimed DOCX/PDF or validated business deliverable.
        let bytes = serde_json::to_vec(&json!({"schemaVersion":1,"kind":"remote_protocol_output",
            "operationId":original.operation_id,"sessionId":session,"inputIntentSha256":original.intent_sha256,
            "recipientIdentitySha256":recipient_sha256,"receiver":original.receiver,
            "textBytes":text.len(),"textSha256":hash(text.as_bytes()),"text":text,
            "businessCompletion":"unverified","untrustedSourceData":true}))?;
        let sha256 = hash(&bytes);
        Ok(Self {
            operation: original.operation_id,
            session,
            original_input_sha256: original.intent_sha256,
            recipient_sha256,
            bytes,
            sha256,
            format: OfficeFileFormat::Json,
            native_result: None,
        })
    }
    pub fn bind_original_native_result(
        &mut self,
        authority: &super::authority::AcceptedRemoteAuthority,
        journal: &NativeRemoteJournal,
    ) -> Result<()> {
        if let Some(result) = super::receiver_results::capture(authority, journal)? {
            self.format = result.manifest.format;
            self.sha256 = result.manifest.sha256.clone();
            self.bytes = result.bytes;
            self.native_result = Some(result.manifest);
        }
        Ok(())
    }
    /// The actual SSH factory supplies only its correlated, fully hashed result
    /// after Native endpoint/task/scope validation. This creates no permission.
    pub fn bind_authenticated_endpoint_result(
        &mut self,
        result: super::receiver_results::OriginalReceiverOfficeResult,
    ) -> Result<()> {
        result.manifest.validate()?;
        ensure!(
            result.bytes.len() as u64 == result.manifest.bytes
                && hash(&result.bytes) == result.manifest.sha256,
            "REMOTE_RECEIVER_OFFICE_RESULT_CHANGED"
        );
        self.format = result.manifest.format;
        self.sha256 = result.manifest.sha256.clone();
        self.bytes = result.bytes;
        self.native_result = Some(result.manifest);
        Ok(())
    }
    /// Publish one immutable, source-bound JSON evidence artifact in the existing Native Office domain.
    /// It retains Partial verification. Neither ACP stop nor transport integrity proves business correctness.
    pub fn publish(
        &self,
        journal: &NativeRemoteJournal,
        engine: &QueryEngine,
        actual: &ToolContext,
    ) -> Result<OfficeArtifactManifest> {
        verify_original_tool(journal, engine, actual)?;
        ensure!(
            self.operation == journal.operation_id() && self.sha256 == hash(&self.bytes),
            "REMOTE_OUTPUT_IDENTITY_CHANGED"
        );
        let settings = engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("OFFICE_SETTINGS_UNAVAILABLE"))?
            .integrations
            .office
            .clone();
        settings.validate()?;
        ensure!(
            settings.enabled
                && settings.allowed_formats.contains(&self.format)
                && self.bytes.len() as u64 <= settings.max_output_bytes,
            "REMOTE_NATIVE_ASSET_POLICY_UNAVAILABLE"
        );
        let intent = json!({"operationId":self.operation,"sessionId":self.session,"bytes":self.bytes.len(),"sha256":self.sha256,
            "inputIntentSha256":self.original_input_sha256,"recipientIdentitySha256":self.recipient_sha256});
        let dispatch = journal.store().before_dispatch(
            &self.operation,
            journal.context().scope(),
            NativeRemoteStage::OutputTransfer,
            &intent,
        )?;
        let open = || -> Result<Option<(NativeDomainGuard, OfficeStore)>> {
            let Some(guard) = NativeDomainGuard::observe(
                journal.context().profile()?,
                journal.context().scope(),
                NativeDomain::Office,
            )?
            else {
                return Ok(None);
            };
            let store = OfficeStore::open_in(
                &guard.directory(journal.context().profile()?)?,
                OsStr::new("data"),
                IntegrationOwner::from(journal.context().scope()),
            )?
            .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?;
            Ok(Some((guard, store)))
        };
        let result = (|| -> Result<OfficeArtifactManifest> {
            let (_guard, store) = match open()? {
                Some(value) => value,
                None => match NativeDomainGuard::initialize(
                    journal.context().profile()?,
                    journal.context().scope(),
                    NativeDomain::Office,
                    &self.operation,
                    |directory| {
                        OfficeStore::create_in(
                            directory,
                            OsStr::new("data"),
                            IntegrationOwner::from(journal.context().scope()),
                        )
                    },
                ) {
                    Ok(value) => value,
                    Err(error) => open()?.ok_or(error)?,
                },
            };
            verify_original_tool(journal, engine, actual)?;
            let attempt = journal.authority().original_attempt();
            let original_reference = self
                .native_result
                .as_ref()
                .map(|original| -> Result<OfficeResourceRef> {
                    Ok(OfficeResourceRef {
                        kind: "native_remote_artifact".into(),
                        id: original.id.clone(),
                        revision: super::launch::digest(original)?,
                    })
                })
                .transpose()?;
            let mut verification = self
                .native_result
                .as_ref()
                .map(|original| original.verification.clone())
                .unwrap_or(OfficeVerification {
                    status: OfficeVerificationStatus::Partial,
                    completed_checks: Vec::new(),
                    pending_checks: Vec::new(),
                    reader_status: OfficeVerificationStatus::Pending,
                    formula_calculation: "not_applicable".into(),
                });
            verification.status = OfficeVerificationStatus::Partial;
            verification.reader_status = OfficeVerificationStatus::Pending;
            verification.completed_checks.extend([
                "original_operation_transport_binding".into(),
                "complete_content_sha256".into(),
            ]);
            verification
                .pending_checks
                .extend(["independent_reader".into(), "business_correctness".into()]);
            if self
                .native_result
                .as_ref()
                .is_some_and(|original| original.dataset.is_some())
            {
                verification
                    .pending_checks
                    .push("original_linked_dataset_transfer".into());
            }
            let manifest = OfficeArtifactManifest {
                schema_version: 1,
                id: format!("remote-output-{}", hash(self.operation.as_bytes())),
                revision: 1,
                owner: IntegrationOwner::from(journal.context().scope()),
                task: OfficeTaskRef {
                    thread_id: attempt.thread_id.clone(),
                    turn_id: attempt.turn_id.clone(),
                    run_id: None,
                },
                kind: self
                    .native_result
                    .as_ref()
                    .map(|original| original.kind)
                    .unwrap_or(OfficeArtifactKind::Research),
                title: if self.native_result.is_some() {
                    "Received Native Office result".into()
                } else {
                    "Remote protocol output".into()
                },
                format: self.format,
                bytes: self.bytes.len() as u64,
                sha256: self.sha256.clone(),
                source_refs: vec![
                    OfficeResourceRef {
                        kind: "remote_operation".into(),
                        id: self.operation.clone(),
                        revision: self.original_input_sha256.clone(),
                    },
                    OfficeResourceRef {
                        kind: "acp_session".into(),
                        id: self.session.clone(),
                        revision: self.recipient_sha256.clone(),
                    },
                ]
                .into_iter()
                .chain(original_reference)
                .collect(),
                verification,
                dataset: None,
                created_at_ms: u64::try_from(
                    SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
                )?,
                presentation: None,
            };
            let published = store.publish_artifact(
                &format!("{}-publish-output", self.operation),
                manifest,
                &self.bytes,
            )?;
            let native_artifact = self
                .native_result
                .as_ref()
                .map(|original| -> Result<Value> {
                    Ok(json!({"id":original.id,"revision":original.revision,
                    "manifestSha256":super::launch::digest(original)?}))
                })
                .transpose()?;
            journal.store().receive(&dispatch,&json!({"artifact":{"id":published.id,"revision":published.revision},"bytes":published.bytes,"sha256":published.sha256,"nativeArtifact":native_artifact,"businessCompleted":false}))?;
            Ok(published)
        })();
        if result.is_err() {
            let _ = journal.store().unknown(&dispatch);
        }
        result
    }
    /// Use the same installed Native executable's existing owned pure-bytes Reader.
    /// Its result is format/extraction evidence; the artifact remains Partial.
    pub fn read<'a>(
        &'a self,
        journal: &'a NativeRemoteJournal,
        runner: &'a InstalledOutboundRunner,
        engine: &'a QueryEngine,
        actual: &'a ToolContext,
    ) -> futures::future::BoxFuture<'a, Result<Value>> {
        Box::pin(self.read_producer(journal, runner, engine, actual))
    }
    async fn read_producer(
        &self,
        journal: &NativeRemoteJournal,
        runner: &InstalledOutboundRunner,
        engine: &QueryEngine,
        actual: &ToolContext,
    ) -> Result<Value> {
        journal.verify_runner(runner)?;
        self.read_with_program(journal, runner.owner_executable(), engine, actual)
            .await
    }
    pub fn read_current_native<'a>(
        &'a self,
        journal: &'a NativeRemoteJournal,
        engine: &'a QueryEngine,
        actual: &'a ToolContext,
    ) -> futures::future::BoxFuture<'a, Result<Value>> {
        Box::pin(self.read_current_native_producer(journal, engine, actual))
    }
    async fn read_current_native_producer(
        &self,
        journal: &NativeRemoteJournal,
        engine: &QueryEngine,
        actual: &ToolContext,
    ) -> Result<Value> {
        journal
            .authority()
            .check_owned_native_observation(journal.context())?;
        self.read_with_program(journal, &std::env::current_exe()?, engine, actual)
            .await
    }
    async fn read_with_program(
        &self,
        journal: &NativeRemoteJournal,
        program: &std::path::Path,
        engine: &QueryEngine,
        actual: &ToolContext,
    ) -> Result<Value> {
        verify_original_tool(journal, engine, actual)?;
        ensure!(
            self.operation == journal.operation_id() && self.sha256 == hash(&self.bytes),
            "REMOTE_OUTPUT_IDENTITY_CHANGED"
        );
        let worker = OfficeReadWorker::from_trusted_program(program)?;
        let cancel = actual
            .abort_token
            .as_ref()
            .map(CancellationToken::child_token)
            .unwrap_or_default();
        let header = OfficeReadHeader {
            schema_version: 1,
            operation: None,
            reference: OfficeArtifactRef {
                id: format!("remote-output-{}", hash(self.operation.as_bytes())),
                revision: 1,
            },
            // The existing Reader extracts exact UTF-8 evidence bytes as text;
            // it does not claim JSON schema or business-document verification.
            filename: if self.native_result.is_some() {
                format!("received-native-result.{}", self.format.extension())
            } else {
                "remote-protocol-output.txt".into()
            },
            byte_length: self.bytes.len() as u64,
            sha256: self.sha256.clone(),
            scope_sha256: hash(&serde_json::to_vec(journal.context().scope())?),
            cursor: None,
            limit: 4,
        };
        header.validate()?;
        let dispatch = journal.store().before_dispatch(
            &self.operation,
            journal.context().scope(),
            NativeRemoteStage::Verify,
            &json!({"sha256":self.sha256,"bytes":self.bytes.len(),"reader":"native_office_text_reader"}),
        )?;
        let result = super::output_reader::read_all(
            &worker,
            header,
            &self.bytes,
            journal.authority().deadline(),
            &cancel,
            || journal.check_current(),
        )
        .await;
        match result {
            Ok(result) => {
                journal.store().receive(&dispatch,&json!({"sha256":self.sha256,"readerReceived":true,"complete":result["complete"],"businessCompleted":false}))?;
                journal.check_current()?;
                Ok(result)
            }
            Err(error) => {
                journal.store().unknown(&dispatch)?;
                Err(error)
            }
        }
    }
}
fn verify_original_tool(
    journal: &NativeRemoteJournal,
    engine: &QueryEngine,
    actual: &ToolContext,
) -> Result<()> {
    journal.authority().verify_original_tool(
        &engine.state,
        &actual.state,
        actual.tool_call_id.as_deref(),
        &|| actual.is_aborted(),
    )
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
