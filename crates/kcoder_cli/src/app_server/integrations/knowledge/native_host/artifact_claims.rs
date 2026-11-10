//! Original P-ASSET completion is the only producer of automation claim facts.
use super::*;
use crate::app_server::integrations::office::native_assets::VerifiedOfficeExportAcknowledgement;
use kcoder_state::integrations::knowledge::ApprovedAutomationArtifactClaim;
use sha2::{Digest, Sha256};

impl NativeKnowledgeHost {
    pub(in crate::app_server::integrations) fn record_export_acknowledgement(
        &self,
        request: &IntegrationRequest,
        run_id: &str,
        export: &VerifiedOfficeExportAcknowledgement,
        now_ms: u64,
    ) -> Result<AutomationArtifactClaim> {
        self.native.validate_scope(export.scope())?;
        self.native.validate_scope(&request.scope)?;
        ensure!(
            self.settings.business_automation_enabled,
            "AUTOMATION_DISABLED"
        );
        let owned = self
            .observe_automation()?
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_STORE_UNAVAILABLE"))?;
        let policy = self.policy_for(Some(&owned));
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms,
            explicit_user_action: true,
            policy: &policy,
        };
        let resource = KnowledgeResource {
            kind: "automation",
            id: run_id.into(),
            owner: KnowledgeOwner::from(self.scope()),
        };
        context.check(request, true, "automation.read", &resource)?;
        owned.verify(&self.native)?;
        let run = owned.store.read_run(run_id)?;
        let manifest_ref = IntegrationEntityRef {
            kind: IntegrationEntityKind::Artifact,
            id: export.manifest().id.clone(),
            revision: Some(export.manifest().revision.to_string()),
        };
        if let Some(original) = owned
            .store
            .read_artifact_claim_for_export(export.export_id())?
        {
            ensure!(
                original.run_id == run.id
                    && original.native_operation_id == run.native_operation_id
                    && original.manifest_ref == manifest_ref
                    && original.bytes == export.bytes()
                    && original.sha256 == export.sha256(),
                "AUTOMATION_EXPORT_CLAIM_CONFLICT"
            );
            context.check(request, true, "automation.read", &resource)?;
            return Ok(original);
        }
        let proof = ApprovedAutomationArtifactClaim::from_verified_native_transfer(
            self.scope(),
            &run,
            manifest_ref,
            export.export_id(),
            export.manifest().bytes,
            export.bytes(),
            &export.manifest().sha256,
            export.sha256(),
            true,
            false,
            export.completed_at_ms(),
        )?;
        context.check(request, true, "automation.read", &resource)?;
        let operation = format!(
            "native-export-claim-{:x}",
            Sha256::digest(export.export_id().as_bytes())
        );
        let result = owned
            .store
            .record_verified_artifact_claim(&operation, &proof)?;
        owned.verify(&self.native)?;
        context.check(request, true, "automation.read", &resource)?;
        Ok(result)
    }
}
