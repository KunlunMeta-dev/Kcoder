use crate::{
    ExpectedSkillRevision, SkillCommitRequest, SkillMetadataDelta, SkillMutation,
    SkillMutationActor, SkillOperationKind, SkillPackage, SkillPackageFile, SkillStore,
    canonical_package_revision,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Hidden directory used by skills bundled with the KCoder binary.
pub const BUILTIN_SKILLS_DIR_NAME: &str = ".builtin";
const BUILTIN_MANIFEST_FILENAME: &str = ".builtin_manifest";
const BUILTIN_MANIFEST_VERSION: u32 = 1;

const BUILTIN_SKILLS: &[(&str, &str)] = &[(
    "kcoder-settings",
    include_str!("assets/builtin/kcoder-settings/SKILL.md"),
)];
const BUILTIN_SKILL_ASSETS: &[(&str, &str, &str)] = &[
    (
        "kcoder-settings",
        "references/providers.md",
        include_str!("assets/builtin/kcoder-settings/references/providers.md"),
    ),
    (
        "kcoder-settings",
        "references/studio.md",
        include_str!("assets/builtin/kcoder-settings/references/studio.md"),
    ),
    (
        "kcoder-settings",
        "references/mcp.md",
        include_str!("assets/builtin/kcoder-settings/references/mcp.md"),
    ),
    (
        "kcoder-settings",
        "references/skills.md",
        include_str!("assets/builtin/kcoder-settings/references/skills.md"),
    ),
    (
        "kcoder-settings",
        "references/hooks.md",
        include_str!("assets/builtin/kcoder-settings/references/hooks.md"),
    ),
    (
        "kcoder-settings",
        "references/plugins.md",
        include_str!("assets/builtin/kcoder-settings/references/plugins.md"),
    ),
    (
        "kcoder-settings",
        "references/training.md",
        include_str!("assets/builtin/kcoder-settings/references/training.md"),
    ),
    (
        "kcoder-settings",
        "references/tui.md",
        include_str!("assets/builtin/kcoder-settings/references/tui.md"),
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct BuiltinManifest {
    #[serde(default = "default_manifest_version")]
    version: u32,
    #[serde(default)]
    skills: BTreeMap<String, BuiltinManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct BuiltinManifestEntry {
    content_hash: String,
    source: String,
}

fn default_manifest_version() -> u32 {
    BUILTIN_MANIFEST_VERSION
}

/// Return the materialized built-in skill directory in the user profile.
pub fn builtin_skills_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("skills").join(BUILTIN_SKILLS_DIR_NAME)
}

/// Materialize KCoder-bundled skills into the user profile.
///
/// Embedded binary content is authoritative. When the binary carries updates,
/// atomically replace existing materialized files while retaining user and project overrides in their own skill layers.
pub fn ensure_builtin_skills(config_dir: &Path) -> Result<PathBuf> {
    let root = builtin_skills_dir(config_dir);
    // Read the previous manifest first: built-in skills removed by a product decision
    // must be retired from the `.builtin` layer, otherwise old installs will keep
    // seeing the residual content.
    let previous_manifest: BuiltinManifest = std::fs::read(root.join(BUILTIN_MANIFEST_FILENAME))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(BuiltinManifest {
            version: BUILTIN_MANIFEST_VERSION,
            skills: BTreeMap::new(),
        });
    let mut manifest = BuiltinManifest {
        version: BUILTIN_MANIFEST_VERSION,
        skills: BTreeMap::new(),
    };
    let mut mutations = Vec::new();
    let mut packages = Vec::new();

    for (name, content) in BUILTIN_SKILLS {
        let mut files = vec![SkillPackageFile {
            relative_path: PathBuf::from("SKILL.md"),
            content: content.as_bytes().to_vec(),
            executable: false,
        }];
        for (_, relative_path, asset_content) in BUILTIN_SKILL_ASSETS
            .iter()
            .filter(|(skill_name, _, _)| skill_name == name)
        {
            files.push(SkillPackageFile {
                relative_path: PathBuf::from(relative_path),
                content: asset_content.as_bytes().to_vec(),
                executable: false,
            });
        }
        packages.push(SkillPackage {
            name: (*name).to_string(),
            files,
        });
    }
    packages.extend(crate::bundled_assets::packages());
    let packaged_names: std::collections::BTreeSet<&str> = packages
        .iter()
        .map(|package| package.name.as_str())
        .collect();
    let store = SkillStore::open(&root).context("failed to open built-in skill store")?;
    let mut retirement_archive_names = Vec::new();
    for (name, entry) in &previous_manifest.skills {
        if packaged_names.contains(name.as_str()) || !entry.source.starts_with("skills/") {
            continue;
        }
        let Some(revision) = store.current_revision(name)? else {
            continue;
        };
        // `content_hash` looks like "sha256:<hex>"; the colon is not a valid skill-name
        // character, so use the hex digest portion as the archive-name suffix.
        let digest_hex = entry.content_hash.rsplit(':').next().unwrap_or_default();
        let archive_name = format!("{name}-retired-{}", &digest_hex[..digest_hex.len().min(8)]);
        retirement_archive_names.push(archive_name.clone());
        mutations.push(SkillMutation::Archive {
            name: name.clone(),
            expected: revision,
            archive_name,
        });
    }
    for package in &packages {
        let name = &package.name;
        let revision = canonical_package_revision(package)
            .with_context(|| format!("failed to hash built-in skill '{name}'"))?;

        manifest.skills.insert(
            name.to_string(),
            BuiltinManifestEntry {
                content_hash: revision.0,
                source: if name == "kcoder-settings" {
                    format!("kcoder_skills/assets/builtin/{name}/SKILL.md")
                } else {
                    format!("skills/{name}/SKILL.md")
                },
            },
        );
        mutations.push(SkillMutation::PutPackage {
            package: package.clone(),
            expected: ExpectedSkillRevision::Unconditional,
        });
    }

    let manifest_path = root.join(BUILTIN_MANIFEST_FILENAME);
    let manifest_content = format!(
        "{}\n",
        serde_json::to_string_pretty(&manifest)
            .context("failed to serialize built-in skill manifest")?
    );
    let manifest_changed = std::fs::read(&manifest_path)
        .map(|current| current != manifest_content.as_bytes())
        .unwrap_or(true);
    let mut current_state = Sha256::new();
    for package in &packages {
        current_state.update(package.name.as_bytes());
        for file in &package.files {
            current_state.update(file.relative_path.to_string_lossy().as_bytes());
            current_state.update(
                std::fs::read(root.join(&package.name).join(&file.relative_path))
                    .unwrap_or_else(|_| b"absent".to_vec()),
            );
        }
    }
    current_state
        .update(std::fs::read(&manifest_path).unwrap_or_else(|_| b"absent-manifest".to_vec()));
    let operation_id = format!(
        "builtin-materialize:{:x}:{:x}:{:x}",
        Sha256::digest(manifest_content.as_bytes()),
        current_state.finalize(),
        Sha256::digest(retirement_archive_names.join("\n").as_bytes())
    );
    store
        .commit(SkillCommitRequest {
            operation_id,
            actor: SkillMutationActor::BuiltinInstaller {
                build_id: env!("CARGO_PKG_VERSION").to_string(),
            },
            operation: SkillOperationKind::BuiltinMaterialize,
            preconditions: Vec::new(),
            mutations,
            metadata: SkillMetadataDelta {
                builtin_manifest: manifest_changed.then(|| manifest_content.into_bytes()),
                ..Default::default()
            },
        })
        .context("failed to materialize built-in skill transaction")?;

    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SkillRegistry;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn materializes_embedded_skill_and_manifest() {
        let config = TempDir::new().unwrap();
        let root = ensure_builtin_skills(config.path()).unwrap();

        let skill = root.join("kcoder-settings/SKILL.md");
        assert_eq!(fs::read_to_string(skill).unwrap(), BUILTIN_SKILLS[0].1);

        let manifest: BuiltinManifest = serde_json::from_str(
            &fs::read_to_string(root.join(BUILTIN_MANIFEST_FILENAME)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.version, BUILTIN_MANIFEST_VERSION);
        assert_eq!(manifest.skills.len(), 14);
        assert_eq!(
            manifest.skills["kcoder-settings"].source,
            "kcoder_skills/assets/builtin/kcoder-settings/SKILL.md"
        );
        assert_eq!(
            manifest.skills["kcoder-settings"].content_hash,
            crate::skill_revision(&root.join("kcoder-settings"))
                .unwrap()
                .unwrap()
                .0
        );
    }

    #[test]
    fn materializes_embedded_skill_supporting_references() {
        let config = TempDir::new().unwrap();
        let root = ensure_builtin_skills(config.path()).unwrap();
        let skill = root.join("kcoder-settings");

        for reference in [
            "providers.md",
            "studio.md",
            "mcp.md",
            "skills.md",
            "hooks.md",
            "plugins.md",
            "training.md",
            "tui.md",
        ] {
            let path = skill.join("references").join(reference);
            assert!(path.is_file(), "缺少内置技能引用：{}", path.display());
            assert!(!fs::read_to_string(path).unwrap().trim().is_empty());
        }
    }

    #[test]
    fn provider_reference_examples_match_the_current_settings_schema() {
        let reference = BUILTIN_SKILL_ASSETS
            .iter()
            .find(|(_, path, _)| *path == "references/providers.md")
            .unwrap()
            .2;
        let examples: Vec<serde_json::Value> = reference
            .split("```json\n")
            .skip(1)
            .map(|block| serde_json::from_str(block.split("```").next().unwrap()).unwrap())
            .collect();
        assert_eq!(examples.len(), 2);
        for document in &examples {
            kcoder_config::validate_and_resolve_settings_document(document).unwrap();
        }
        let multi = kcoder_config::validate_and_resolve_settings_document(&examples[0]).unwrap();
        let provider = &multi.providers["shared"];
        assert_eq!(provider.model_profiles().len(), 2);
        assert_eq!(provider.default_model, "small");
        let large = provider.effective_for_model("large").unwrap();
        assert_eq!(large.context_window_tokens, 128000);
        assert_eq!(large.endpoint, provider.endpoint);
        assert!(large.capabilities.vision);
        assert_eq!(
            large.extra_body.get("temperature"),
            Some(&serde_json::json!(0.2))
        );
        assert!(
            provider
                .effective_for_model("small")
                .unwrap()
                .extra_body
                .is_empty()
        );
        let legacy = kcoder_config::validate_and_resolve_settings_document(&examples[1]).unwrap();
        assert_eq!(legacy.providers["shared"].model_profiles().len(), 1);
    }

    #[test]
    fn startup_replaces_stale_materialized_skill_idempotently() {
        let config = TempDir::new().unwrap();
        let root = ensure_builtin_skills(config.path()).unwrap();
        let skill = root.join("kcoder-settings/SKILL.md");
        let tui_reference = root.join("kcoder-settings/references/tui.md");
        let expected_tui = fs::read(&tui_reference).unwrap();
        fs::write(&skill, "stale").unwrap();
        fs::write(&tui_reference, "stale reference").unwrap();

        ensure_builtin_skills(config.path()).unwrap();
        assert_eq!(fs::read_to_string(&skill).unwrap(), BUILTIN_SKILLS[0].1);
        assert_eq!(fs::read(&tui_reference).unwrap(), expected_tui);

        let manifest_before = fs::read_to_string(root.join(BUILTIN_MANIFEST_FILENAME)).unwrap();
        ensure_builtin_skills(config.path()).unwrap();
        assert_eq!(
            fs::read_to_string(root.join(BUILTIN_MANIFEST_FILENAME)).unwrap(),
            manifest_before
        );
    }

    #[test]
    fn settings_skill_documents_extension_management_workflows() {
        let content = BUILTIN_SKILLS[0].1;

        for required in [
            "references/providers.md",
            "references/studio.md",
            "references/mcp.md",
            "references/skills.md",
            "references/hooks.md",
            "references/plugins.md",
            "references/training.md",
            "references/tui.md",
        ] {
            assert!(
                content.contains(required),
                "kcoder-settings 缺少扩展管理说明：{required}"
            );
        }
    }

    #[test]
    fn registry_loads_materialized_tui_reference() {
        let config = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let root = ensure_builtin_skills(config.path()).unwrap();
        let user_skills = config.path().join("skills");
        let registry = SkillRegistry::load_with_layers(
            project.path(),
            std::iter::empty::<PathBuf>(),
            Some(&user_skills),
            true,
        )
        .unwrap();
        let skill = registry.get_active("kcoder-settings").unwrap();
        assert_eq!(skill.source, root.join("kcoder-settings/SKILL.md"));
        for reference in ["tui.md", "providers.md"] {
            let expected =
                fs::read_to_string(root.join("kcoder-settings/references").join(reference))
                    .unwrap();
            assert!(
                skill.references.contains(&expected),
                "embedded reference must enter the registry: {reference}"
            );
        }
    }

    #[test]
    fn builtin_skill_is_loaded_before_user_override() {
        let config = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        ensure_builtin_skills(config.path()).unwrap();

        let user_skill = config.path().join("skills/kcoder-settings");
        fs::create_dir_all(&user_skill).unwrap();
        fs::write(
            user_skill.join("SKILL.md"),
            "---\nname: kcoder-settings\ndescription: User override\n---\n\n# User",
        )
        .unwrap();
        let user_before = fs::read(user_skill.join("SKILL.md")).unwrap();
        ensure_builtin_skills(config.path()).unwrap();
        assert_eq!(fs::read(user_skill.join("SKILL.md")).unwrap(), user_before);

        let user_skills = config.path().join("skills");
        let registry = SkillRegistry::load_with_layers(
            project.path(),
            std::iter::empty::<PathBuf>(),
            Some(&user_skills),
            true,
        )
        .unwrap();
        assert_eq!(
            registry.get("kcoder-settings").unwrap().description,
            "User override"
        );
    }

    #[test]
    fn retires_removed_builtin_skills_through_the_store() {
        let config = TempDir::new().unwrap();
        let root = builtin_skills_dir(config.path());
        fs::create_dir_all(root.join("brand-guidelines")).unwrap();
        fs::write(
            root.join("brand-guidelines/SKILL.md"),
            "---\nname: brand-guidelines\ndescription: stale bundled skill\n---\nOld content.",
        )
        .unwrap();
        let stale_manifest = BuiltinManifest {
            version: BUILTIN_MANIFEST_VERSION,
            skills: BTreeMap::from([(
                "brand-guidelines".to_string(),
                BuiltinManifestEntry {
                    content_hash: "sha256:e3b0c44298fc1c14".to_string(),
                    source: "skills/brand-guidelines/SKILL.md".to_string(),
                },
            )]),
        };
        fs::write(
            root.join(BUILTIN_MANIFEST_FILENAME),
            serde_json::to_string_pretty(&stale_manifest).unwrap(),
        )
        .unwrap();

        ensure_builtin_skills(config.path()).unwrap();

        assert!(
            !root.join("brand-guidelines").exists(),
            "retired skill must leave the live layer"
        );
        let archive_entries: Vec<_> = fs::read_dir(root.join(".archive"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            archive_entries
                .iter()
                .any(|name| name.starts_with("brand-guidelines-retired-")),
            "retired skill must be recoverable from the archive: {archive_entries:?}"
        );
        let manifest: BuiltinManifest = serde_json::from_str(
            &fs::read_to_string(root.join(BUILTIN_MANIFEST_FILENAME)).unwrap(),
        )
        .unwrap();
        assert!(!manifest.skills.contains_key("brand-guidelines"));
        let registry = SkillRegistry::load_with_layers(
            config.path(),
            std::iter::empty::<PathBuf>(),
            Some(config.path().join("skills").as_path()),
            true,
        )
        .unwrap();
        assert!(registry.get_active("brand-guidelines").is_none());
        // Idempotent: re-running must not fail because of a pre-existing archive.
        ensure_builtin_skills(config.path()).unwrap();
    }

    #[test]
    fn bundled_anthropics_assets_are_complete_and_user_override_wins() {
        let config = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let root = ensure_builtin_skills(config.path()).unwrap();
        let packages = crate::bundled_assets::packages();
        assert_eq!(packages.len(), 13);
        assert_eq!(
            packages
                .iter()
                .map(|package| package.files.len())
                .sum::<usize>(),
            321
        );
        for package in &packages {
            for file in &package.files {
                assert_eq!(
                    fs::read(root.join(&package.name).join(&file.relative_path)).unwrap(),
                    file.content,
                    "bundled asset differs: {}/{}",
                    package.name,
                    file.relative_path.display()
                );
            }
        }
        let user_skills = config.path().join("skills");
        let registry = SkillRegistry::load_with_layers(
            project.path(),
            std::iter::empty::<PathBuf>(),
            Some(&user_skills),
            true,
        )
        .unwrap();
        for package in &packages {
            assert_eq!(
                registry.get_active(&package.name).unwrap().source,
                root.join(&package.name).join("SKILL.md")
            );
        }
        let override_dir = user_skills.join("pdf");
        fs::create_dir_all(&override_dir).unwrap();
        let custom = "---\nname: pdf\ndescription: My PDF rules\n---\nUse my PDF workflow.";
        fs::write(override_dir.join("SKILL.md"), custom).unwrap();
        ensure_builtin_skills(config.path()).unwrap();
        let registry = SkillRegistry::load_with_layers(
            project.path(),
            std::iter::empty::<PathBuf>(),
            Some(&user_skills),
            true,
        )
        .unwrap();
        assert_eq!(
            registry.get_active("pdf").unwrap().description,
            "My PDF rules"
        );
        assert_eq!(
            fs::read_to_string(override_dir.join("SKILL.md")).unwrap(),
            custom
        );
    }
}
