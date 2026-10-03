use anyhow::{Context, Result};
use kcoder_app_protocol::{SkillImportParams, SkillManagementResult, SkillRemoveParams};

pub(super) async fn import(params: SkillImportParams) -> Result<SkillManagementResult> {
    if !params.path.is_absolute() {
        anyhow::bail!("Skill import requires an absolute directory path on the selected host");
    }
    tokio::task::spawn_blocking(move || {
        let root = kcoder_config::user_config_dir()?.join("skills");
        let receipt = kcoder_skills::import::install_directory(&root, &params.path)?;
        let name = receipt
            .after
            .iter()
            .find(|entry| entry.revision.is_some())
            .context("Imported skill revision is unavailable")?
            .name
            .clone();
        Ok(SkillManagementResult {
            name,
            applies_to_new_conversations: true,
            archive_name: None,
        })
    })
    .await?
}

pub(super) async fn remove(params: SkillRemoveParams) -> Result<SkillManagementResult> {
    tokio::task::spawn_blocking(move || {
        let root = kcoder_config::user_config_dir()?.join("skills");
        let archived = kcoder_skills::import::archive_skill(&root, &params.name)?;
        Ok(SkillManagementResult {
            name: params.name,
            applies_to_new_conversations: true,
            archive_name: Some(archived.archive_name),
        })
    })
    .await?
}

pub(super) fn user_managed(skill: &kcoder_skills::Skill) -> bool {
    let name = &skill.name;
    if kcoder_skills::store::validate_skill_name(name).is_err() {
        return false;
    }
    let Ok(root) = kcoder_config::user_config_dir() else {
        return false;
    };
    let directory = root.join("skills").join(name);
    if !std::fs::symlink_metadata(&directory)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        return false;
    }
    let path = directory.join("SKILL.md");
    if !std::fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        return false;
    }
    match (path.canonicalize(), skill.source.canonicalize()) {
        (Ok(expected), Ok(actual)) => expected == actual,
        _ => false,
    }
}
