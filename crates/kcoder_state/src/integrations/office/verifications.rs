use super::*;
impl OfficeStore {
    pub fn save_verification(
        &self,
        operation: &str,
        reference: &OfficeArtifactRef,
        sha256: &str,
        verification: OfficeVerification,
        now: u64,
    ) -> Result<OfficeVerificationObservation> {
        let key = reference_key(reference);
        self.mutate(
            operation,
            "artifact.saveVerification",
            &(reference, sha256, &verification),
            |state| {
                let manifest = &state
                    .artifacts
                    .get(&key)
                    .context("OFFICE_ARTIFACT_NOT_FOUND")?
                    .manifest;
                ensure!(
                    manifest.sha256 == sha256,
                    "OFFICE_CONTENT_IDENTITY_MISMATCH"
                );
                let mut checked = manifest.clone();
                checked.verification = verification.clone();
                checked.validate()?;
                let observations = state.verifications.entry(key).or_default();
                ensure!(observations.len() < 64, "OFFICE_VERIFICATION_CAPACITY");
                let observation = OfficeVerificationObservation {
                    reference: reference.clone(),
                    content_sha256: sha256.into(),
                    revision: observations.len() as u64 + 1,
                    observed_at_ms: now,
                    verification: verification.clone(),
                };
                observations.push(observation.clone());
                Ok(observation)
            },
        )
    }
    pub fn read_verification(
        &self,
        reference: &OfficeArtifactRef,
    ) -> Result<Option<OfficeVerificationObservation>> {
        valid_id(&reference.id)?;
        let _lock = self.lock(false)?;
        let state = self.load()?;
        let key = reference_key(reference);
        let observation = state
            .verifications
            .get(&key)
            .and_then(|observations| observations.last())
            .cloned();
        if let Some(observation) = &observation {
            let manifest = &state
                .artifacts
                .get(&key)
                .context("OFFICE_ARTIFACT_NOT_FOUND")?
                .manifest;
            ensure!(
                observation.reference == *reference
                    && observation.content_sha256 == manifest.sha256,
                "OFFICE_CONTENT_IDENTITY_MISMATCH"
            );
        }
        Ok(observation)
    }
}
