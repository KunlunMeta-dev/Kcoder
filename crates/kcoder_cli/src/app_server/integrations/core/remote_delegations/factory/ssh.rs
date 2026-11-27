//! SSH uses the original Source task, journal and ACP client; no separate model loop.
use super::*;
use crate::app_server::integrations::core::remote_delegations::authority_ssh::AcceptedSshRemoteAuthority;
use kcoder_config::integrations::remotes::ConfiguredNativeSshPeer;

impl CurrentTurnRemoteBackend {
    pub fn delegate_owned_ssh<'a>(
        &'a self,
        input: RemoteDelegateInput,
        actual: &'a ToolContext,
        registry: NativeRemoteRegistry,
        selector: ConfiguredNativeSshPeer,
    ) -> futures::future::BoxFuture<'a, Result<Value>> {
        Box::pin(self.delegate_owned_ssh_producer(input, actual, registry, selector))
    }
    async fn delegate_owned_ssh_producer(
        &self,
        input: RemoteDelegateInput,
        actual: &ToolContext,
        registry: NativeRemoteRegistry,
        selector: ConfiguredNativeSshPeer,
    ) -> Result<Value> {
        let host_client = self
            .host_client
            .clone()
            .context("REMOTE_NATIVE_HOST_UNAVAILABLE")?;
        host_client.verify_owner()?;
        let authority = AcceptedSshRemoteAuthority::capture(
            &self.native,
            &self.engine,
            &self.attempt,
            actual,
            (
                registry,
                selector,
                input.clone(),
                host_client,
                &self.budget_owners,
            ),
        )?;
        let operation = authority.operation().to_owned();
        let request = IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: format!("request-{operation}"),
            scope: self.native.scope().clone(),
            operation_id: Some(operation.clone()),
            expected_revision: None,
            timeout_ms: 1000,
            cancellation_ref: None,
            payload: json!({"sourceTask":self.attempt,"sourceToolCallId":actual.tool_call_id,
                "prompt":input.prompt,"recipientRevision":authority.recipient_revision(),
                "nativeTransport":"ssh"})
            .as_object()
            .context("REMOTE_INVALID_INPUT")?
            .clone(),
        };
        let journal = Arc::new(NativeRemoteJournal::begin(
            &self.native,
            &request,
            authority.clone(),
        )?);
        let cancel = actual
            .abort_token
            .as_ref()
            .map(CancellationToken::child_token)
            .unwrap_or_default();
        let mut peer = match OutboundAcp::connect_owned_transport(
            authority.frames(),
            None,
            ("kcoder", kcoder_cli_commands::build_identity::version()),
            journal.clone(),
            &cancel,
        )
        .await
        {
            Ok(peer) => peer,
            Err(error) => {
                let mut outcome = unknown(&operation, "REMOTE_SSH_OPEN_REQUIRES_ORIGINAL_READ");
                outcome["openDiagnostic"] = safe_open_diagnostic(&error);
                return Ok(outcome);
            }
        };
        let received = async {
            peer.initialize(&cancel)
                .await
                .context("REMOTE_OWNED_INITIALIZE")?;
            peer.bind_owned_native_original(authority.original_bind(), &cancel)
                .await
                .context("REMOTE_OWNED_BIND_ORIGINAL")?;
            super::super::materials_ssh::send_all(&authority, &journal, &mut peer, &cancel)
                .await
                .context("REMOTE_OWNED_TRANSFER_MATERIALS")?;
            let remaining = journal
                .deadline()
                .saturating_duration_since(tokio::time::Instant::now());
            ensure!(!remaining.is_zero(), "REMOTE_NATIVE_DEADLINE_EXPIRED");
            let received = peer
                .prompt_once(
                    vec![OutboundContentBlock::Text(OutboundTextContent::new(
                        input.prompt,
                    ))],
                    &cancel,
                    remaining,
                )
                .await
                .context("REMOTE_OWNED_PROMPT")?;
            let original_result = super::super::receiver_results_ssh::capture(
                &authority, &journal, &mut peer, &cancel,
            )
            .await
            .context("REMOTE_OWNED_READ_ORIGINAL_ARTIFACT")?;
            let mut output = NativeRemoteReceivedOutput::capture(&journal, received)?;
            let native_format = original_result
                .as_ref()
                .map(|result| result.manifest.format);
            if let Some(result) = original_result {
                output.bind_authenticated_endpoint_result(result)?;
            }
            let artifact = output.publish(&journal, &self.engine, actual)?;
            let reader = match output
                .read_current_native(&journal, &self.engine, actual)
                .await
            {
                Ok(result) => {
                    json!({"state":"received","complete":result["complete"],"businessVerified":false})
                }
                Err(_) => json!({"state":"unavailable","businessVerified":false}),
            };
            Ok::<_, anyhow::Error>((artifact, native_format, reader))
        }
        .await;
        // Even an unknown prompt may retain its one actual Accepted endpoint.
        // This cannot reopen a transport or retry any execution effect.
        let close = async {
            peer.close_owned_native_original(&authority.original_close()?)
                .await
                .context("REMOTE_OWNED_CLOSE_ORIGINAL")
        }
        .await;
        let received = received.and_then(|result| close.map(|_| result));
        let cleanup = peer.shutdown().await;
        journal.record_owned_endpoint_cleanup(&cleanup)?;
        // Frame cleanup has no local receiver PID. It must not enter the old
        // process-backed cleanup record or invent a cross-host process id.
        let (artifact, native_format, reader) = match received {
            Ok(received) => received,
            Err(error) => {
                let mut outcome = unknown(
                    &operation,
                    "REMOTE_SSH_BIND_OR_DISPATCH_REQUIRES_ORIGINAL_READ",
                );
                outcome["openDiagnostic"] = safe_open_diagnostic(&error);
                return Ok(outcome);
            }
        };
        authority.frames().observe_current_target_owner().await?;
        // Full authenticated artifact transfer and independent business
        // verification remain mandatory for a native business deliverable. Text
        // or an ACP prompt response never substitutes for those receipts.
        Ok(
            json!({"operationId":operation,"state":if native_format.is_some(){"native_receiver_observed"}else{"protocol_output_received"},
            "artifact":{"id":artifact.id,"revision":artifact.revision,"sha256":artifact.sha256,"bytes":artifact.bytes,"format":artifact.format,"kind":if native_format.is_some(){"received_native_office_result"}else{"remote_protocol_output"}},
            "reader":reader,
            "verification":"partial","businessCompleted":false,"ownerCleanupConfirmed":cleanup.confirmed(),
            "reasonCode":if native_format.is_some(){"REMOTE_NATIVE_BUSINESS_VERIFICATION_PENDING"}else{"REMOTE_SSH_OFFICE_RESULT_NOT_APPLICABLE"}}),
        )
    }
}

/// A closed diagnostic vocabulary never includes raw filesystem, account or
/// transport errors. Unknown remains unknown; these facts never permit retry.
fn safe_open_diagnostic(error: &anyhow::Error) -> Value {
    let stages = [
        "REMOTE_OWNED_OPEN_CANCELLED",
        "REMOTE_OWNED_OPEN_TIMED_OUT",
        "REMOTE_OWNED_OPEN_SOURCE_ADMISSION",
        "REMOTE_OWNED_OPEN_TRANSPORT_OWNER",
        "REMOTE_OWNED_OPEN_TRANSPORT_BINDING",
        "REMOTE_OWNED_OPEN_SPAWN_JOURNAL",
        "REMOTE_OWNED_OPEN_TRANSPORT",
        "REMOTE_OWNED_OPEN_FRAME_ADMISSION",
        "REMOTE_OWNED_OPEN_HOST_REQUEST",
        "REMOTE_OWNED_OPEN_RECEIVER_WORKSPACE",
        "REMOTE_OWNED_OPEN_POST_SOURCE_ADMISSION",
        "REMOTE_OWNED_OPEN_POST_TRANSPORT_OWNER",
        "REMOTE_OWNED_OPEN_SPAWN_RECEIPT",
        "REMOTE_OWNED_INITIALIZE",
        "REMOTE_OWNED_BIND_ORIGINAL",
        "REMOTE_OWNED_TRANSFER_MATERIALS",
        "REMOTE_OWNED_PROMPT",
        "REMOTE_OWNED_READ_ORIGINAL_ARTIFACT",
        "REMOTE_OWNED_CLOSE_ORIGINAL",
    ];
    let reasons = [
        "REMOTE_NATIVE_CALL_OWNER_MISMATCH",
        "REMOTE_ORIGINAL_TASK_NOT_ACTIVE",
        "REMOTE_ORIGINAL_ACCEPTANCE_CHANGED",
        "REMOTE_HOST_CONNECTION_CLOSED",
        "REMOTE_HOST_ROOT_OWNER_CHANGED",
        "REMOTE_HOST_SOURCE_IMAGE_CHANGED",
        "REMOTE_HOST_RECONCILE_ORIGINAL",
        "REMOTE_HOST_OUTCOME_REQUIRES_ORIGINAL_READ",
        "REMOTE_ORIGINAL_TRANSPORT_CHANGED",
        "REMOTE_RUNNER_CONFIGURATION_CHANGED",
        "REMOTE_FROZEN_INTENT_CHANGED",
        "REMOTE_NATIVE_DEADLINE_EXPIRED",
        "REMOTE_HOST_ORIGINAL_DEADLINE_EXPIRED",
        "REMOTE_HOST_NATIVE_IMAGE_CHANGED",
        "REMOTE_HOST_RECEIVER_WORKSPACE_REQUIRED",
        "REMOTE_ORIGINAL_OPERATION_NOT_ACTIVE",
        "REMOTE_RECEIVER_PRIVATE_BINDING_UNAVAILABLE",
        "REMOTE_RECEIVER_MATERIAL_OUTCOME_UNCONFIRMED",
        "REMOTE_RECEIVER_SESSION_OVERRIDE_DENIED",
        "REMOTE_ORIGINAL_BIND_RECEIPT_CHANGED",
        "REMOTE_CONTROL_RECEIVER_SETTINGS_CHANGED",
        "REMOTE_NATIVE_INPUT_TRANSFER_UNAVAILABLE",
    ];
    let texts: Vec<String> = error.chain().map(ToString::to_string).collect();
    let receiver_code = kcoder_acp::native_receiver_bind_diagnostic(error);
    json!({"stages":texts.iter().filter_map(|text|stages.iter().find(|code| **code==text.as_str()).copied()).collect::<Vec<_>>(),
        "reason":texts.iter().find_map(|text|reasons.iter().find(|code| **code==text.as_str()).copied())
            .or_else(|| (receiver_code != "REMOTE_RECEIVER_PRIVATE_BINDING_UNAVAILABLE").then_some(receiver_code))
            .unwrap_or("REMOTE_OPEN_UNCLASSIFIED")})
}

#[cfg(test)]
mod open_diagnostic_tests {
    use super::*;
    #[test]
    fn original_open_diagnostic_does_not_expose_arbitrary_error_messages() {
        let error = anyhow::anyhow!("private-account-path-token")
            .context("REMOTE_OWNED_OPEN_SOURCE_ADMISSION");
        let diagnostic = safe_open_diagnostic(&error);
        assert_eq!(
            diagnostic,
            json!({"stages":["REMOTE_OWNED_OPEN_SOURCE_ADMISSION"],"reason":"REMOTE_OPEN_UNCLASSIFIED"})
        );
        assert!(!diagnostic.to_string().contains("private"));
        let error = anyhow::anyhow!("REMOTE_NATIVE_CALL_OWNER_MISMATCH")
            .context("REMOTE_OWNED_OPEN_SPAWN_JOURNAL");
        assert_eq!(
            safe_open_diagnostic(&error),
            json!({"stages":["REMOTE_OWNED_OPEN_SPAWN_JOURNAL"],"reason":"REMOTE_NATIVE_CALL_OWNER_MISMATCH"})
        );
    }
}
