//! Compatible scoped sources publish the same owned ImportedContext action as ordinary assets.
use super::*;
use crate::instruction_sources::InstructionResolution;
impl AssetTarget {
    pub(super) fn prepare_scoped_instruction(
        &self,
        item: &NormalizedItem,
        binding: &AssetBundleBinding,
        resolution: &AssetResolution,
    ) -> Result<AssetPlan> {
        self.current_profile()?;
        ensure!(
            binding.scoped_instruction_profile()? == self.profile,
            "migration_wrong_target"
        );
        ensure!(
            binding.category == Category::Instructions
                && item.preview.category == Category::Instructions
                && item.preview.id == resolution.item_id
                && resolution.memory_scope.is_none(),
            "migration_unknown_item"
        );
        ensure!(
            !item
                .preview
                .issues
                .iter()
                .any(|issue| issue.blocks_import()),
            "migration_item_requires_resolution"
        );
        ensure!(
            !resolution.target_name.trim().is_empty()
                && resolution.target_name.trim() == resolution.target_name
                && resolution.target_name.len() <= 256
                && !resolution.target_name.chars().any(char::is_control),
            "migration_invalid_asset_name"
        );
        let source = item
            .asset
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_not_an_asset"))?;
        let snapshot = binding
            .scoped_instruction_snapshot()?
            .ok_or_else(|| anyhow::anyhow!("migration_not_scoped_instructions"))?;
        let target = binding.scoped_instruction_target(&source.entry)?;
        target.verify(&self.profile)?;
        let job_id = binding.instruction_capture_job_id()?;
        let choices = [InstructionResolution {
            id: source.entry.clone(),
            name: resolution.target_name.clone(),
            target_relative_scope: target.relative_scope().into(),
            enabled: resolution.enable_after_import,
        }];
        let mut records = snapshot.prepare_records(target.destination(), &choices, job_id)?;
        let record = records
            .pop()
            .ok_or_else(|| anyhow::anyhow!("migration_instruction_selection_invalid"))?;
        ensure!(
            records.is_empty(),
            "migration_instruction_selection_invalid"
        );
        target.verify_record(&self.profile, &record)?;
        ensure!(
            !ImportedContextStore::open(&self.profile)?
                .list()?
                .iter()
                .any(|current| current.name == record.name && current.scope == record.scope),
            "migration_target_conflict"
        );
        let original = snapshot.original_bytes(&source.entry)?;
        let summary = snapshot
            .summaries()
            .into_iter()
            .find(|row| row.id == source.entry)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        let source_revision = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                snapshot.semantic_revision()?,
                &summary.relative_path,
                target,
            ))?)
        );
        let mut item = item.clone();
        item.preview.status = Status::Staged;
        let scope = record.scope.clone();
        let plan = AssetPlan {
            agent_adaptation: None,
            adapted_agent_report: None,
            plan_id: format!("plan-{}", uuid::Uuid::new_v4().simple()),
            target_id: self.target_id(),
            name: resolution.target_name.clone(),
            enabled: resolution.enable_after_import,
            item,
            scope,
            original_entry: EncodedFile {
                path: summary.relative_path.into(),
                data: STANDARD.encode(&*original),
                executable: false,
            },
            imported_sources: Vec::new(),
            source_revision: Some(source_revision),
            action: Action::Context { record },
        };
        plan.original_text()?;
        Ok(plan)
    }
}
