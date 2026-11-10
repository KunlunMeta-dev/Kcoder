use super::*;
use kcoder_types::integrations::core::{IntegrationEntityKind, IntegrationEntityRef};
use kcoder_types::integrations::knowledge::AutomationArtifactClaim;

/// Native-only completion evidence. This type deliberately has no RPC deserializer.
pub struct ApprovedAutomationArtifactClaim {
    body: AutomationArtifactClaim,
}
impl ApprovedAutomationArtifactClaim {
    /// Call only after the authenticated export endpoint verifies the complete byte stream
    /// and its original client completion acknowledgement. Prepared leases are insufficient.
    #[allow(clippy::too_many_arguments)]
    pub fn from_verified_native_transfer(
        scope: &IntegrationScope,
        run: &AutomationRun,
        manifest_ref: IntegrationEntityRef,
        export_id: &str,
        expected_bytes: u64,
        observed_bytes: u64,
        expected_sha256: &str,
        observed_sha256: &str,
        stream_complete: bool,
        transfer_cancelled: bool,
        completed_at_ms: u64,
    ) -> Result<Self> {
        scope.validate()?;
        ensure!(
            KnowledgeOwner::from(scope) == run.owner,
            "AUTOMATION_SCOPE_MISMATCH"
        );
        ensure!(
            run.status == AutomationRunStatus::Completed,
            "AUTOMATION_RESULT_NOT_READY"
        );
        validate_id(export_id)?;
        validate_id(&manifest_ref.id)?;
        ensure!(
            manifest_ref.kind == IntegrationEntityKind::Artifact
                && manifest_ref
                    .revision
                    .as_deref()
                    .is_some_and(|revision| !revision.is_empty()),
            "AUTOMATION_ARTIFACT_REVISION_REQUIRED"
        );
        validate_id(manifest_ref.revision.as_deref().unwrap_or_default())?;
        ensure!(
            stream_complete
                && !transfer_cancelled
                && expected_bytes == observed_bytes
                && expected_sha256 == observed_sha256
                && expected_sha256.len() == 64
                && expected_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && completed_at_ms >= run.created_at_ms,
            "AUTOMATION_EXPORT_COMPLETION_UNVERIFIED"
        );
        Ok(Self {
            body: AutomationArtifactClaim {
                owner: run.owner.clone(),
                run_id: run.id.clone(),
                native_operation_id: run.native_operation_id.clone(),
                manifest_ref,
                export_id: export_id.into(),
                bytes: observed_bytes,
                sha256: observed_sha256.into(),
                completed_at_ms,
            },
        })
    }
}
impl AutomationStore {
    /// Observe the original export receipt without creating state or changing
    /// its acknowledgement time when a client repeats an unknown response.
    pub fn read_artifact_claim_for_export(
        &self,
        export_id: &str,
    ) -> Result<Option<AutomationArtifactClaim>> {
        validate_id(export_id)?;
        self.access(false, |data| {
            Ok(data.artifact_claims.get(export_id).cloned())
        })
    }

    /// Called by the original native byte-transfer owner, never exposed as a writable UI RPC.
    pub fn record_verified_artifact_claim(
        &self,
        operation: &str,
        claim: &ApprovedAutomationArtifactClaim,
    ) -> Result<AutomationArtifactClaim> {
        let body = &claim.body;
        ensure!(body.owner == self.owner, "AUTOMATION_SCOPE_MISMATCH");
        let intent = json!({"action":"record_verified_artifact_claim","claim":body});
        self.access(true, |data| {
            if let Some(old) = Self::replay(data, operation, &intent)? {
                return Ok(old);
            }
            let run = data
                .runs
                .get(&body.run_id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_RUN_NOT_FOUND"))?;
            ensure!(
                run.owner == body.owner
                    && run.native_operation_id == body.native_operation_id
                    && run.status == AutomationRunStatus::Completed,
                "AUTOMATION_EXPORT_COMPLETION_UNVERIFIED"
            );
            let manifests = data
                .artifact_manifests
                .get(&body.run_id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_ARTIFACT_REVISION_REQUIRED"))?;
            ensure!(
                manifests.contains(&body.manifest_ref)
                    && run.artifact_refs.contains(&body.manifest_ref.id),
                "AUTOMATION_ARTIFACT_REVISION_REQUIRED"
            );
            if let Some(old) = data.artifact_claims.get(&body.export_id) {
                ensure!(old == body, "AUTOMATION_EXPORT_CLAIM_CONFLICT");
            } else {
                ensure!(
                    data.artifact_claims.len() < MAX_ITEMS,
                    "AUTOMATION_EXPORT_CLAIM_CAPACITY"
                );
                data.artifact_claims
                    .insert(body.export_id.clone(), body.clone());
            }
            Self::receipt(data, operation, intent, body)?;
            Ok(body.clone())
        })
    }
    pub fn read_artifact_claims(
        &self,
        run_id: &str,
        after: Option<&str>,
    ) -> Result<KnowledgePage<AutomationArtifactClaim>> {
        validate_id(run_id)?;
        if let Some(after) = after {
            validate_id(after)?;
        }
        self.access(false, |data| {
            ensure!(data.runs.contains_key(run_id), "AUTOMATION_RUN_NOT_FOUND");
            let mut items: Vec<_> = data
                .artifact_claims
                .values()
                .filter(|claim| {
                    claim.run_id == run_id
                        && after.is_none_or(|after| claim.export_id.as_str() > after)
                })
                .take(11)
                .cloned()
                .collect();
            let more = items.len() > 10;
            items.truncate(10);
            let next_cursor = if more {
                items.last().map(|claim| claim.export_id.clone())
            } else {
                None
            };
            Ok(KnowledgePage { items, next_cursor })
        })
    }
}

#[cfg(test)]
mod tests;
