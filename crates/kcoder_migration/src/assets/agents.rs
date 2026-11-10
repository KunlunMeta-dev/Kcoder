//! Adapted Agents use the same native SkillStore owner, receipt and Undo as ordinary assets.
use super::*;
use kcoder_types::migration_agent::MigrationAgentAdaptation;

pub(super) fn validate_choice(category: Category, resolution: &AssetResolution) -> Result<()> {
    if resolution.agent_adaptation.is_some() {
        ensure!(
            category == Category::Agent && !resolution.enable_after_import,
            "migration_agent_requires_disabled_publication"
        );
    }
    Ok(())
}

pub(super) fn semantic_revision(
    revision: &str,
    adaptation: Option<&MigrationAgentAdaptation>,
) -> Result<String> {
    match adaptation {
        None => Ok(revision.to_owned()),
        Some(adaptation) => Ok(format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(&(revision, adaptation))?)
        )),
    }
}

impl AssetTarget {
    pub(super) fn adapt_agent(
        &self,
        binding: &AssetBundleBinding,
        resolution: &AssetResolution,
        bytes: &[u8],
        plan_id: &str,
        scope: &ImportedContextScope,
    ) -> Result<Action> {
        if self.skills_directory_exists()? {
            ensure!(
                self.skills()?
                    .current_revision(&resolution.target_name)
                    .map_err(skill_error)?
                    .is_none(),
                "migration_target_conflict"
            );
        }
        let package = crate::agent_adapter::package(
            crate::definition_adapter::format(binding.kind, Category::Agent)?,
            bytes,
            &resolution.target_name,
            plan_id,
            scope,
            resolution.agent_adaptation.as_ref().unwrap(),
        )?;
        let revision = kcoder_skills::canonical_package_revision(&package).map_err(skill_error)?;
        Ok(Action::Skill {
            name: package.name,
            revision,
            files: package
                .files
                .into_iter()
                .map(|file| EncodedFile {
                    path: file.relative_path,
                    data: STANDARD.encode(file.content),
                    executable: false,
                })
                .collect(),
        })
    }
}
