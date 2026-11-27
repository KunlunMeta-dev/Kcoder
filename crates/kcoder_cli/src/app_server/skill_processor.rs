use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use kcoder_app_protocol::{SkillImportParams, SkillManagementResult, SkillRemoveParams};

pub(super) fn list(
    registry: &kcoder_skills::SkillRegistry,
    include_disabled: bool,
    profile: &Path,
) -> kcoder_app_protocol::SkillListResult {
    let mut items: Vec<_> = registry
        .list_catalog()
        .into_iter()
        .filter(|skill| {
            include_disabled || (registry.is_enabled(&skill.name) && skill.user_invocable)
        })
        .map(|skill| kcoder_app_protocol::SkillCatalogItem {
            name: skill.name.clone(),
            description: skill.description.clone(),
            path: skill.source.clone(),
            enabled: registry.is_enabled(&skill.name),
            user_invocable: skill.user_invocable,
            can_remove: user_managed(skill, profile),
        })
        .collect();
    items.sort_by(|left, right| left.name.cmp(&right.name));
    kcoder_app_protocol::SkillListResult {
        items,
        applies_to_new_conversations: true,
    }
}

pub(super) async fn set_enabled(
    params: kcoder_app_protocol::SkillSetEnabledParams,
    registry: kcoder_skills::SkillRegistry,
    profile: PathBuf,
) -> Result<kcoder_app_protocol::SkillSetEnabledResult> {
    anyhow::ensure!(
        registry
            .list_catalog()
            .iter()
            .any(|skill| skill.name == params.name),
        "Skill is not available on the selected target and workspace"
    );
    let token = registry
        .list_catalog()
        .into_iter()
        .find(|skill| skill.name == params.name)
        .and_then(|skill| skill.activation.as_ref())
        .map(|activation| activation.token.clone());
    tokio::task::spawn_blocking(move || {
        kcoder_skills::activation::set_enabled_for_import(
            &profile,
            &params.name,
            params.enabled,
            token.as_deref(),
        )?;
        Ok(kcoder_app_protocol::SkillSetEnabledResult {
            name: params.name,
            enabled: params.enabled,
            applies_to_new_conversations: true,
        })
    })
    .await?
}

pub(super) async fn import(
    params: SkillImportParams,
    profile: PathBuf,
) -> Result<SkillManagementResult> {
    if !params.path.is_absolute() {
        anyhow::bail!("Skill import requires an absolute directory path on the selected host");
    }
    tokio::task::spawn_blocking(move || {
        let root = profile.join("skills");
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

pub(super) async fn remove(
    params: SkillRemoveParams,
    profile: PathBuf,
) -> Result<SkillManagementResult> {
    tokio::task::spawn_blocking(move || {
        let root = profile.join("skills");
        let archived = kcoder_skills::import::archive_skill(&root, &params.name)?;
        Ok(SkillManagementResult {
            name: params.name,
            applies_to_new_conversations: true,
            archive_name: Some(archived.archive_name),
        })
    })
    .await?
}

pub(super) fn user_managed(skill: &kcoder_skills::Skill, profile: &Path) -> bool {
    let name = &skill.name;
    if kcoder_skills::store::validate_skill_name(name).is_err() {
        return false;
    }
    let directory = profile.join("skills").join(name);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(cwd: &Path, profile: &Path) -> kcoder_skills::SkillRegistry {
        kcoder_skills::SkillRegistry::load_for_profile(
            cwd,
            std::iter::empty::<&Path>(),
            profile,
            false,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn selected_profile_owns_import_activation_catalog_and_archive() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        let source = temp.path().join("source");
        std::fs::create_dir_all(source.join("references")).unwrap();
        std::fs::write(
            source.join("SKILL.md"),
            "---\nname: profile-demo\ndescription: Profile fixture\nactivation:\n  token: profile-fixture\n  default_enabled: false\n---\nUse the reference.\n",
        )
        .unwrap();
        std::fs::write(source.join("references/demo.txt"), b"original support").unwrap();
        for profile in [&first, &second] {
            import(
                SkillImportParams {
                    path: source.clone(),
                },
                profile.clone(),
            )
            .await
            .unwrap();
        }
        let load_first = || registry(temp.path(), &first);
        let load_second = || registry(temp.path(), &second);
        assert!(!load_first().is_enabled("profile-demo"));
        assert!(!load_second().is_enabled("profile-demo"));
        set_enabled(
            kcoder_app_protocol::SkillSetEnabledParams {
                name: "profile-demo".into(),
                enabled: true,
            },
            load_first(),
            first.clone(),
        )
        .await
        .unwrap();
        assert!(load_first().is_enabled("profile-demo"));
        assert!(!load_second().is_enabled("profile-demo"));
        let catalog = list(&load_first(), true, &first);
        let item = catalog
            .items
            .iter()
            .find(|item| item.name == "profile-demo")
            .unwrap();
        assert!(item.can_remove && item.enabled);
        let wrong_profile = list(&load_first(), true, &second);
        assert!(
            !wrong_profile
                .items
                .iter()
                .find(|item| item.name == "profile-demo")
                .unwrap()
                .can_remove
        );
        set_enabled(
            kcoder_app_protocol::SkillSetEnabledParams {
                name: "profile-demo".into(),
                enabled: false,
            },
            load_first(),
            first.clone(),
        )
        .await
        .unwrap();
        assert!(!load_first().is_enabled("profile-demo"));
        assert!(!second.join("skill-activation.json").exists());
        let settings = std::fs::read(first.join("skill-activation.json")).unwrap();
        let archived = remove(
            SkillRemoveParams {
                name: "profile-demo".into(),
            },
            second.clone(),
        )
        .await
        .unwrap();
        assert!(archived.archive_name.is_some());
        assert!(!second.join("skills/profile-demo").exists());
        assert_eq!(
            std::fs::read(first.join("skills/profile-demo/references/demo.txt")).unwrap(),
            b"original support"
        );
        assert_eq!(
            std::fs::read(first.join("skill-activation.json")).unwrap(),
            settings
        );
        assert!(
            remove(
                SkillRemoveParams {
                    name: "profile-demo".into()
                },
                second
            )
            .await
            .is_err()
        );
        assert!(first.join("skills/profile-demo/SKILL.md").is_file());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn selected_profile_catalog_does_not_allow_removing_symlinked_packages() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        let source = temp.path().join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("SKILL.md"),
            "---\nname: profile-demo\ndescription: Profile fixture\n---\nFixture.\n",
        )
        .unwrap();
        import(SkillImportParams { path: source }, profile.clone())
            .await
            .unwrap();
        let registry = registry(temp.path(), &profile);
        let package = profile.join("skills/profile-demo");
        let moved = temp.path().join("moved");
        std::fs::rename(&package, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &package).unwrap();
        assert!(
            !list(&registry, true, &profile)
                .items
                .iter()
                .find(|item| item.name == "profile-demo")
                .unwrap()
                .can_remove
        );
        assert!(
            remove(
                SkillRemoveParams {
                    name: "profile-demo".into()
                },
                profile
            )
            .await
            .is_err()
        );
        assert!(moved.join("SKILL.md").is_file());
    }
}
