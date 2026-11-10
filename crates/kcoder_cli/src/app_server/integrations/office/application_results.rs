//! An actual application producer publishes its verified receipt through OfficeStore.
use super::*;
impl NativeOfficeComposition {
    pub(crate) fn read_native_application_effect_intent(
        &self,
        native: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<kcoder_state::integrations::office::OfficeApplicationEffectIntent>> {
        self.binding.check(native.scope())?;
        let intent = self
            .binding
            .store
            .read_application_effect_intent(operation)?;
        self.binding.check(native.scope())?;
        Ok(intent)
    }
    pub(crate) fn save_native_application_effect_intent(
        &self,
        native: &NativeIntegrationContext,
        operation: &str,
        intent: kcoder_state::integrations::office::OfficeApplicationEffectIntent,
    ) -> Result<()> {
        self.binding.check(native.scope())?;
        NativeOfficeAcceptedTurnAuthority.validate(native, &self.binding.engine, &intent.task)?;
        self.binding
            .store
            .save_application_effect_intent(operation, intent)?;
        self.binding.check(native.scope())
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep the original accepted task, result and saved-document readback identity explicit"
    )]
    pub(crate) fn publish_native_application_result(
        &self,
        native: &NativeIntegrationContext,
        task: &OfficeTaskRef,
        operation: &str,
        application_receipt: kcoder_state::integrations::office::OfficeApplicationToolReceipt,
        result:crate::app_server::integrations::connectivity::application_inputs::business_result::VerifiedBusinessResult,
        _receipt: &Value,
        readback_for: Option<OfficeArtifactRef>,
    ) -> Result<OfficeArtifactManifest> {
        self.binding.check(native.scope())?;
        NativeOfficeAcceptedTurnAuthority.validate(native, &self.binding.engine, task)?;
        let sources = application_receipt.source_references()?;
        let readback = if let Some(reference) = readback_for {
            let created = self
                .binding
                .store
                .read_application_receipt(&reference)?
                .context("APPLICATION_DOCUMENT_CREATE_RECEIPT_REQUIRED")?;
            ensure!(
                created.rule.action == kcoder_types::McpApplicationAction::DocumentCreate
                    && application_receipt.rule.action
                        == kcoder_types::McpApplicationAction::DocumentRead
                    && created.owner == application_receipt.owner
                    && created.task == application_receipt.task
                    && created.root_operation_id == application_receipt.root_operation_id
                    && created.source == application_receipt.source
                    && created.connection == application_receipt.connection
                    && created.resources == application_receipt.resources,
                "APPLICATION_DOCUMENT_READBACK_IDENTITY_CHANGED"
            );
            let body_sha=crate::app_server::integrations::connectivity::application_inputs::business_result::verify_document_readback(
                &created.root_operation_id,&created.approved_input,&created.actual_result,&application_receipt.approved_input,&application_receipt.actual_result)?;
            Some((reference, body_sha))
        } else {
            None
        };
        for source in &sources {
            source.validate()?;
        }
        let presentation = result
            .receipt_id()
            .filter(|_| result.kind() == OfficeArtifactKind::OperationReceipt)
            .map(|id| OfficeArtifactPresentation::OperationReceipt {
                operation_id: application_receipt.root_operation_id.clone(),
                // Platform state was verified before publication; presentation uses
                // the shared native operation lifecycle vocabulary.
                phase: "completed".into(),
                detail: format!("Verified original application receipt: {id}"),
            });
        let reconciled = application_receipt.reconciliation.is_some();
        let manifest = OfficeArtifactManifest {
            schema_version: 1,
            id: application_receipt.artifact.id.clone(),
            revision: 1,
            owner: IntegrationOwner::from(native.scope()),
            task: task.clone(),
            kind: result.kind(),
            title: result
                .filename()
                .map(|name| {
                    name.strip_suffix(&format!(".{}", result.format().extension()))
                        .unwrap_or(name)
                        .to_owned()
                })
                .unwrap_or_else(|| "Application business result".into()),
            format: result.format(),
            bytes: result.bytes().len() as u64,
            sha256: format!("{:x}", Sha256::digest(result.bytes())),
            source_refs: sources,
            verification: OfficeVerification {
                status: OfficeVerificationStatus::Partial,
                completed_checks: vec![
                    if reconciled {
                        "original_readonly_platform_lookup"
                    } else {
                        "original_application_receipt"
                    }
                    .into(),
                    "source_account_resource_identity".into(),
                    "complete_content_sha256".into(),
                ],
                pending_checks: if application_receipt.rule.action
                    == kcoder_types::McpApplicationAction::DocumentCreate
                {
                    vec![
                        "saved_document_readback".into(),
                        "external_vendor_quality".into(),
                    ]
                } else {
                    vec!["external_vendor_quality".into()]
                },
                reader_status: OfficeVerificationStatus::Unavailable,
                formula_calculation: "not_applicable".into(),
            },
            dataset: None,
            created_at_ms: chrono::Utc::now().timestamp_millis().try_into()?,
            presentation,
        };
        let published = self.binding.store.publish_application_artifact(
            operation,
            manifest,
            result.bytes(),
            application_receipt,
        )?;
        self.binding.check(native.scope())?;
        NativeOfficeAcceptedTurnAuthority.validate(native, &self.binding.engine, task)?;
        if let Some((reference, body_sha)) = readback {
            let created = self
                .binding
                .store
                .read_artifact(&reference)?
                .context("APPLICATION_DOCUMENT_CREATE_RECEIPT_REQUIRED")?;
            let mut verification = created.verification.clone();
            verification
                .pending_checks
                .retain(|check| check != "saved_document_readback");
            verification.completed_checks.extend([
                "saved_document_title".into(),
                format!("saved_document_readback_sha256:{body_sha}"),
                format!(
                    "original_read_artifact:{}@{}",
                    published.id, published.revision
                ),
            ]);
            self.binding.store.save_verification(
                &format!("{operation}-readback"),
                &reference,
                &created.sha256,
                verification,
                chrono::Utc::now().timestamp_millis().try_into()?,
            )?;
        }
        Ok(published)
    }
}
