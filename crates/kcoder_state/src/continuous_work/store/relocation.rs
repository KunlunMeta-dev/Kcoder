//! Keep business records and all receipts unchanged at the namespace boundary.
use super::super::namespace::{ContinuousWorkRelocationSnapshot, RelocationPayload};
use super::*;

fn payloads(bytes: &[u8]) -> Result<BTreeMap<String, RelocationPayload>> {
    let data = parse_data(bytes)?;
    // A copied inode cannot recreate the original unpublished process object.
    // Its original owner must reconcile this operation before profile migration.
    ensure!(
        data.pending_publications.is_empty(),
        "CONTINUOUS_WORK_RELOCATION_PENDING_PUBLICATION"
    );
    let mut payloads = BTreeMap::new();
    for input in data.inputs.values() {
        let receipt = receipt(input)?;
        #[cfg(not(any(target_os = "linux", windows)))]
        let original = input
            .publication
            .as_ref()
            .map(|intent| {
                intent
                    .current_attempt()
                    .map(|attempt| attempt.identity.clone())
            })
            .transpose()?;
        ensure!(
            payloads
                .insert(
                    receipt.payload_ref,
                    RelocationPayload {
                        #[cfg(not(any(target_os = "linux", windows)))]
                        original,
                        size: input.payload_size,
                        sha256: input.payload_sha256.clone(),
                    }
                )
                .is_none(),
            "CONTINUOUS_WORK_PAYLOAD_INVALID"
        );
    }
    Ok(payloads)
}

impl ContinuousWorkStore {
    pub fn relocation_snapshot(&self) -> Result<ContinuousWorkRelocationSnapshot> {
        self.namespace.relocation_snapshot(payloads)
    }

    /// The caller owns the stopped instance and the final, verified copy. The
    /// logical ProfileIdentity must already continue at the target profile.
    pub fn relocate(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &ContinuousWorkRelocationSnapshot,
    ) -> Result<Self> {
        let namespace = self.namespace.relocate(
            final_target_profile,
            operation_id,
            expected,
            payloads,
            true,
        )?;
        Ok(Self { namespace })
    }

    pub fn verify_relocation(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &ContinuousWorkRelocationSnapshot,
    ) -> Result<()> {
        self.namespace
            .relocate(
                final_target_profile,
                operation_id,
                expected,
                payloads,
                false,
            )
            .map(|_| ())
    }
}
