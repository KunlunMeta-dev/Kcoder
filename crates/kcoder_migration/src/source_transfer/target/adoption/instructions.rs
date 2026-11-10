//! Per-item destinations are sealed by Native before the existing adoption worker owns them.
use super::*;
use crate::{
    asset_sources::AssetBundleBinding,
    batch::BatchSource,
    instruction_sources::{InstructionDestination, ScopedInstructionDestination},
};
use std::path::Path;

/// Native callers supply an independently authorized real workspace, not a source directory.
/// Public JSON carries only item IDs and relative choices; it cannot deserialize this proof.
#[derive(Clone)]
pub struct ReceivedInstructionAdoptionMapping {
    sealed: SealedInstructionMapping,
}
impl std::fmt::Debug for ReceivedInstructionAdoptionMapping {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReceivedInstructionAdoptionMapping")
            .field("items", &self.sealed.items.len())
            .finish_non_exhaustive()
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SealedInstructionMapping {
    pub(super) entry_id: String,
    items: BTreeMap<String, ScopedInstructionDestination>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    archive_incomplete_chain: bool,
}
impl ReceivedInstructionAdoptionMapping {
    pub fn capture(
        profile: &Path,
        workspace: &ReceivedProjectTarget,
        entry_id: &str,
        items: &[(String, String)],
        archive_incomplete_chain: bool,
    ) -> Result<Self> {
        valid_id(entry_id)?;
        workspace.verify(profile)?;
        let target = InstructionDestination::capture(profile, workspace.root())?;
        ensure!(
            !items.is_empty() && items.len() <= 128,
            "source_transfer_instruction_mapping_limit"
        );
        let mut mapped = BTreeMap::new();
        for (item, relative) in items {
            ensure!(
                mapped
                    .insert(
                        item.clone(),
                        ScopedInstructionDestination::capture(&target, relative)?
                    )
                    .is_none(),
                "source_transfer_instruction_duplicate_mapping"
            );
        }
        let sealed = SealedInstructionMapping {
            entry_id: entry_id.into(),
            items: mapped,
            archive_incomplete_chain,
        };
        sealed.validate_shape()?;
        sealed.verify(profile, workspace)?;
        Ok(Self { sealed })
    }
}
impl SealedInstructionMapping {
    fn validate_shape(&self) -> Result<()> {
        valid_id(&self.entry_id)?;
        ensure!(
            !self.items.is_empty() && self.items.len() <= 128,
            "source_transfer_instruction_mapping_limit"
        );
        for id in self.items.keys() {
            ensure!(
                !id.is_empty()
                    && id.len() <= 160
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
                "source_transfer_instruction_mapping_invalid"
            );
        }
        Ok(())
    }
    fn verify(&self, profile: &Path, workspace: &ReceivedProjectTarget) -> Result<()> {
        self.validate_shape()?;
        workspace.verify(profile)?;
        let actual = InstructionDestination::capture(profile, workspace.root())?;
        for target in self.items.values() {
            target.verify(profile)?;
            ensure!(
                target.destination() == &actual,
                "source_transfer_instruction_mapping_changed"
            );
        }
        Ok(())
    }
    fn choices(&self) -> Vec<(String, ScopedInstructionDestination)> {
        self.items
            .iter()
            .map(|(id, target)| (id.clone(), target.clone()))
            .collect()
    }
}
pub(super) fn canonical(
    mappings: Vec<ReceivedInstructionAdoptionMapping>,
) -> Result<Vec<SealedInstructionMapping>> {
    let mut mappings = mappings
        .into_iter()
        .map(|mapping| mapping.sealed)
        .collect::<Vec<_>>();
    mappings.sort_by(|a, b| a.entry_id.cmp(&b.entry_id));
    validate(&mappings)?;
    Ok(mappings)
}
pub(super) fn validate(mappings: &[SealedInstructionMapping]) -> Result<()> {
    ensure!(
        mappings.len() <= 64
            && mappings
                .windows(2)
                .all(|pair| pair[0].entry_id < pair[1].entry_id),
        "source_transfer_instruction_duplicate_mapping"
    );
    let mut count = 0usize;
    for mapping in mappings {
        mapping.validate_shape()?;
        count = count.saturating_add(mapping.items.len());
    }
    ensure!(count <= 128, "source_transfer_instruction_mapping_limit");
    Ok(())
}
impl IncomingTransfers {
    pub(super) fn validate_instruction_intent(
        &self,
        request: &str,
        manifest: &str,
        selections: &[ReceivedAdoptionSelection],
        project: Option<&ReceivedProjectTarget>,
        mappings: &[SealedInstructionMapping],
    ) -> Result<()> {
        validate(mappings)?;
        if mappings.is_empty() {
            return Ok(());
        }
        let project = project.context("source_transfer_project_mapping_required")?;
        for mapping in mappings {
            ensure!(
                selections
                    .iter()
                    .any(|selection| selection.entry_id == mapping.entry_id
                        && selection.project_mapping
                            == Some(ReceivedProjectMapping::CurrentWorkspace)),
                "source_transfer_instruction_mapping_unused"
            );
            mapping.verify(&self.store.profile, project)?;
            let snapshot =
                self.received_instruction_snapshot(request, manifest, &mapping.entry_id, |_| true)?;
            AssetBundleBinding::capture_mapped_instructions(
                &self.store.profile,
                project.root(),
                snapshot,
                &mapping.choices(),
                mapping.archive_incomplete_chain,
            )?;
        }
        Ok(())
    }
    pub(super) fn instruction_input(
        &self,
        journal: &Journal,
        entry_id: &str,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<BatchSource> {
        let mapping = journal
            .intent
            .instruction_mappings
            .iter()
            .find(|mapping| mapping.entry_id == entry_id)
            .context("source_transfer_scoped_instructions_update_required")?;
        let project = journal
            .intent
            .project
            .as_ref()
            .context("source_transfer_project_mapping_required")?;
        mapping.verify(&self.store.profile, project)?;
        let snapshot = self.received_instruction_snapshot(
            &journal.intent.request,
            &journal.intent.receipt.manifest_sha256,
            entry_id,
            &mut *check,
        )?;
        let binding = AssetBundleBinding::capture_mapped_instructions_checked(
            &self.store.profile,
            project.root(),
            snapshot,
            &mapping.choices(),
            mapping.archive_incomplete_chain,
            check,
        )?;
        Ok(BatchSource::Assets(binding))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_instruction_mappings_keep_the_exact_legacy_intent_bytes_and_digest() {
        const OLD: &str = concat!(
            "{\"request\":\"11111111-1111-4111-8111-111111111111\",\"adoption\":\"22222222-2222-4222-8222-222222222222\",",
            "\"receipt\":{\"requestId\":\"11111111-1111-4111-8111-111111111111\",\"manifestSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"entries\":1,\"bytes\":4},",
            "\"selections\":[{\"entryId\":\"e0000-0000\"}],\"project\":null,\"profile\":\"owned-fixture-profile\",\"profileIdentity\":\"original-private-profile\",",
            "\"target\":{\"instanceId\":\"33333333-3333-4333-8333-333333333333\",\"accountId\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"},",
            "\"groups\":[{\"source\":\"codex\",\"project\":false,\"entries\":[\"e0000-0000\"],\"jobId\":\"mig-44444444444444444444444444444444\"}]}"
        );
        let restored: Intent = serde_json::from_str(OLD).unwrap();
        assert!(restored.instruction_mappings.is_empty());
        assert_eq!(serde_json::to_string(&restored).unwrap(), OLD);
        assert_eq!(
            digest(&restored).unwrap(),
            format!("{:x}", Sha256::digest(OLD.as_bytes()))
        );
    }
}
