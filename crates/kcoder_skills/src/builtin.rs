use crate::{
    ExpectedSkillRevision, SkillCommitRequest, SkillMetadataDelta, SkillMutation,
    SkillMutationActor, SkillOperationKind, SkillPackage, SkillPackageFile, SkillStore,
    canonical_package_revision,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::{collections::BTreeMap, ffi::OsStr};

/// Hidden directory used by skills bundled with the KCoder binary.
pub const BUILTIN_SKILLS_DIR_NAME: &str = ".builtin";

/// Names are available before materialization so imports cannot shadow shipped capabilities.
pub fn skill_names() -> impl Iterator<Item = &'static str> {
    BUILTIN_SKILLS.iter().map(|(name, _)| *name)
}
/// Bundled skill that guides the Studio inline visualization tool.
pub const INLINE_VISUALIZATION_SKILL: &str = "inline-visualization";
/// Former bundled names and their current names. An old name resolves only when
/// no skill is registered under it, so a user copy keeping the old name still wins.
pub const RENAMED_BUILTIN_SKILLS: &[(&str, &str)] =
    &[("kworker-visualization", INLINE_VISUALIZATION_SKILL)];

/// Current name of a renamed bundled skill, if `name` is a former bundled name.
pub fn renamed_builtin_skill(name: &str) -> Option<&'static str> {
    RENAMED_BUILTIN_SKILLS
        .iter()
        .find(|(former, _)| *former == name)
        .map(|(_, current)| *current)
}
const BUILTIN_MANIFEST_FILENAME: &str = ".builtin_manifest";
const BUILTIN_MANIFEST_VERSION: u32 = 1;

const BUILTIN_SKILLS: &[(&str, &str)] = &[(
    "kcoder-settings",
    include_str!("assets/builtin/kcoder-settings/SKILL.md"),
)];
const BUILTIN_SKILL_ASSETS: &[(&str, &str, &str)] = &[
    (
        "kcoder-settings",
        "references/settings/providers.md",
        include_str!("assets/builtin/kcoder-settings/references/settings/providers.md"),
    ),
    (
        "kcoder-settings",
        "references/settings/studio.md",
        include_str!("assets/builtin/kcoder-settings/references/settings/studio.md"),
    ),
    (
        "kcoder-settings",
        "references/settings/mcp.md",
        include_str!("assets/builtin/kcoder-settings/references/settings/mcp.md"),
    ),
    (
        "kcoder-settings",
        "references/settings/skills.md",
        include_str!("assets/builtin/kcoder-settings/references/settings/skills.md"),
    ),
    (
        "kcoder-settings",
        "references/settings/hooks.md",
        include_str!("assets/builtin/kcoder-settings/references/settings/hooks.md"),
    ),
    (
        "kcoder-settings",
        "references/settings/plugins.md",
        include_str!("assets/builtin/kcoder-settings/references/settings/plugins.md"),
    ),
    (
        "kcoder-settings",
        "references/settings/training.md",
        include_str!("assets/builtin/kcoder-settings/references/settings/training.md"),
    ),
    (
        "kcoder-settings",
        "references/settings/tui.md",
        include_str!("assets/builtin/kcoder-settings/references/settings/tui.md"),
    ),
    (
        "kcoder-settings",
        "references/settings/wiki.md",
        include_str!("assets/builtin/kcoder-settings/references/settings/wiki.md"),
    ),
    (
        "kcoder-settings",
        "references/settings/runtime.md",
        include_str!("assets/builtin/kcoder-settings/references/settings/runtime.md"),
    ),
    (
        "kcoder-settings",
        "references/settings/evolution.md",
        include_str!("assets/builtin/kcoder-settings/references/settings/evolution.md"),
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
    let profile = kcoder_config::PrivateDirectory::open_config_root(config_dir)?;
    let skills_directory = profile.open_child(OsStr::new("skills"), true)?;
    skills_directory.verify_trusted_config_directory()?;
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

    fn test_config_dir() -> TempDir {
        TempDir::new().unwrap()
    }

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
        assert_eq!(manifest.skills.len(), 40);
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
        let config = test_config_dir();
        let root = ensure_builtin_skills(config.path()).unwrap();
        let skill = root.join("kcoder-settings");

        for (_, relative, expected) in BUILTIN_SKILL_ASSETS {
            let path = skill.join(relative);
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                *expected,
                "{}",
                path.display()
            );
        }
        for (relative, text) in std::iter::once(("SKILL.md", BUILTIN_SKILLS[0].1)).chain(
            BUILTIN_SKILL_ASSETS
                .iter()
                .map(|(_, path, body)| (*path, *body)),
        ) {
            let parent = skill.join(relative).parent().unwrap().to_path_buf();
            for target in text.split("](").skip(1) {
                let target = target.split(')').next().unwrap().split('#').next().unwrap();
                let linked = parent.join(target).canonicalize().unwrap();
                assert!(linked.starts_with(skill.canonicalize().unwrap()));
                assert!(linked.is_file(), "{relative} -> {target}");
            }
        }
    }

    #[test]
    fn settings_activation_injects_only_the_entry_and_locates_readable_guides() {
        let config = test_config_dir();
        let project = TempDir::new().unwrap();
        let root = ensure_builtin_skills(config.path()).unwrap();
        let registry = SkillRegistry::load_for_profile(
            project.path(),
            std::iter::empty::<PathBuf>(),
            config.path(),
            true,
        )
        .unwrap();
        let skill = registry.get_active("kcoder-settings").unwrap();
        assert!(skill.references.is_empty());
        let prompt = skill.invocation_text(&[]);
        assert!(prompt.contains(&serde_json::to_string(&root.join("kcoder-settings")).unwrap()));
        let package_bytes: usize = BUILTIN_SKILL_ASSETS
            .iter()
            .map(|(_, _, body)| body.len())
            .sum();
        assert!(
            prompt.len() < package_bytes / 4,
            "settings activation should not inline its reference library"
        );
        for (_, _, body) in BUILTIN_SKILL_ASSETS {
            assert!(!prompt.contains(body.trim()));
        }
    }

    #[test]
    fn settings_upgrade_removes_legacy_eager_references_transactionally() {
        let config = test_config_dir();
        let root = ensure_builtin_skills(config.path()).unwrap();
        SkillStore::open(&root)
            .unwrap()
            .commit(SkillCommitRequest {
                operation_id: "install-legacy-settings-fixture".into(),
                actor: SkillMutationActor::BuiltinInstaller {
                    build_id: "legacy-fixture".into(),
                },
                operation: SkillOperationKind::BuiltinMaterialize,
                preconditions: Vec::new(),
                mutations: vec![SkillMutation::PutPackage {
                    expected: ExpectedSkillRevision::Unconditional,
                    package: SkillPackage {
                        name: "kcoder-settings".into(),
                        files: vec![
                            SkillPackageFile {
                                relative_path: "SKILL.md".into(),
                                content: b"---\nname: kcoder-settings\ndescription: Legacy settings fixture\n---\nLegacy entry".to_vec(),
                                executable: false,
                            },
                            SkillPackageFile {
                                relative_path: "references/studio.md".into(),
                                content: b"LEGACY_EAGER_REFERENCE".to_vec(),
                                executable: false,
                            },
                        ],
                    },
                }],
                metadata: SkillMetadataDelta::default(),
            })
            .unwrap();
        assert!(root.join("kcoder-settings/references/studio.md").is_file());
        ensure_builtin_skills(config.path()).unwrap();
        assert!(!root.join("kcoder-settings/references/studio.md").exists());
        let skill = crate::parse_skill_file(&root.join("kcoder-settings/SKILL.md")).unwrap();
        assert!(skill.references.is_empty());
        assert!(!skill.prompt_text().contains("LEGACY_EAGER_REFERENCE"));
        assert!(
            root.join("kcoder-settings/references/settings/studio.md")
                .is_file()
        );
    }

    #[test]
    fn settings_runtime_and_mcp_examples_load_in_their_actual_scopes() {
        for path in [
            "references/settings/runtime.md",
            "references/settings/mcp.md",
        ] {
            let body = BUILTIN_SKILL_ASSETS
                .iter()
                .find(|(_, name, _)| *name == path)
                .unwrap()
                .2;
            let documents: Vec<serde_json::Value> = body
                .split("```json\n")
                .skip(1)
                .map(|block| serde_json::from_str(block.split("```").next().unwrap()).unwrap())
                .collect();
            assert!(!documents.is_empty());
            for document in documents {
                let temp = test_config_dir();
                let profile = temp.path().join("profile");
                let project = temp.path().join("project");
                let executable = temp.path().join("bin");
                for directory in [&profile, &project, &executable] {
                    fs::create_dir_all(directory).unwrap();
                }
                let project_only = document.get("mcp_inherited_servers").is_some();
                let destination = if project_only {
                    fs::write(
                        profile.join("settings.json"),
                        r#"{"mcp_servers":[{"name":"user-search","command":"NEVER_EXECUTE"}]}"#,
                    )
                    .unwrap();
                    fs::create_dir_all(project.join(".kcoder")).unwrap();
                    project.join(".kcoder/settings.json")
                } else {
                    profile.join("settings.json")
                };
                fs::write(destination, serde_json::to_vec(&document).unwrap()).unwrap();
                let loaded = kcoder_config::SettingsLoader::new(&project)
                    .with_config_dir(&profile)
                    .with_executable_dir(&executable)
                    .load_read_only_configuration_for_management()
                    .unwrap();
                if project_only {
                    assert_eq!(
                        loaded
                            .settings
                            .mcp_servers
                            .iter()
                            .map(|server| server.name.as_str())
                            .collect::<Vec<_>>(),
                        ["user-search", "project-docs"]
                    );
                    assert!(
                        kcoder_config::validate_and_resolve_settings_document(&document).is_err()
                    );
                } else {
                    kcoder_config::validate_and_resolve_settings_document(&document).unwrap();
                }
            }
        }
    }

    #[test]
    fn provider_reference_examples_match_the_current_settings_schema() {
        let reference = BUILTIN_SKILL_ASSETS
            .iter()
            .find(|(_, path, _)| *path == "references/settings/providers.md")
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
        let config = test_config_dir();
        let root = ensure_builtin_skills(config.path()).unwrap();
        let skill = root.join("kcoder-settings/SKILL.md");
        let tui_reference = root.join("kcoder-settings/references/settings/tui.md");
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
            "references/settings/providers.md",
            "references/settings/studio.md",
            "references/settings/mcp.md",
            "references/settings/skills.md",
            "references/settings/hooks.md",
            "references/settings/plugins.md",
            "references/settings/training.md",
            "references/settings/tui.md",
            "references/settings/evolution.md",
        ] {
            assert!(
                content.contains(required),
                "kcoder-settings 缺少扩展管理说明：{required}"
            );
        }
    }

    #[test]
    fn registry_materializes_settings_references_without_eager_injection() {
        let config = test_config_dir();
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
        for reference in ["tui.md", "providers.md", "evolution.md"] {
            let expected = fs::read_to_string(
                root.join("kcoder-settings/references/settings")
                    .join(reference),
            )
            .unwrap();
            assert!(
                !skill.references.contains(&expected),
                "settings reference must remain available for on-demand read: {reference}"
            );
        }
    }

    #[test]
    fn builtin_skill_is_loaded_before_user_override() {
        let config = test_config_dir();
        let project = TempDir::new().unwrap();
        ensure_builtin_skills(config.path()).unwrap();

        let user_skill = config.path().join("skills/kcoder-settings");
        fs::create_dir_all(&user_skill).unwrap();
        fs::write(
            user_skill.join("SKILL.md"),
            "---\nname: kcoder-settings\ndescription: User override\n---\n\n# User",
        )
        .unwrap();
        fs::create_dir_all(user_skill.join("references")).unwrap();
        fs::write(
            user_skill.join("references/user.md"),
            "USER_OWNED_REFERENCE",
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
        assert!(
            registry
                .get("kcoder-settings")
                .unwrap()
                .prompt_text()
                .contains("USER_OWNED_REFERENCE")
        );
    }

    #[test]
    fn retires_removed_builtin_skills_through_the_store() {
        let config = test_config_dir();
        kcoder_config::PrivateDirectory::open_existing(config.path())
            .unwrap()
            .open_child(OsStr::new("skills"), true)
            .unwrap()
            .open_child(OsStr::new(BUILTIN_SKILLS_DIR_NAME), true)
            .unwrap();
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
    fn renamed_visualization_skill_retires_old_bundled_copy_and_keeps_user_copy() {
        let config = test_config_dir();
        kcoder_config::PrivateDirectory::open_existing(config.path())
            .unwrap()
            .open_child(OsStr::new("skills"), true)
            .unwrap()
            .open_child(OsStr::new(BUILTIN_SKILLS_DIR_NAME), true)
            .unwrap();
        let root = builtin_skills_dir(config.path());
        let old = "kworker-visualization";
        fs::create_dir_all(root.join(old)).unwrap();
        fs::write(
            root.join(old).join("SKILL.md"),
            format!("---\nname: {old}\ndescription: previous bundled copy\n---\nOld."),
        )
        .unwrap();
        let stale_manifest = BuiltinManifest {
            version: BUILTIN_MANIFEST_VERSION,
            skills: BTreeMap::from([(
                old.to_string(),
                BuiltinManifestEntry {
                    content_hash: "sha256:0123456789abcdef".to_string(),
                    source: format!("skills/{old}/SKILL.md"),
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
            !root.join(old).exists(),
            "unmodified old bundled copy retires"
        );
        assert!(
            root.join(INLINE_VISUALIZATION_SKILL)
                .join("SKILL.md")
                .is_file()
        );
        assert!(
            fs::read_dir(root.join(".archive"))
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("kworker-visualization-retired-")),
            "the retired bundled copy stays recoverable"
        );
        let user_skills = config.path().join("skills");
        let load = || {
            SkillRegistry::load_with_layers(
                config.path(),
                std::iter::empty::<PathBuf>(),
                Some(user_skills.as_path()),
                true,
            )
            .unwrap()
        };
        let registry = load();
        assert!(registry.get_active(old).is_none());
        assert_eq!(registry.resolve_renamed(old), INLINE_VISUALIZATION_SKILL);
        assert_eq!(registry.resolve_renamed("ordinary"), "ordinary");

        // A user-layer copy under the former name is never touched and keeps its name.
        let user_copy = user_skills.join(old);
        fs::create_dir_all(&user_copy).unwrap();
        let custom = format!("---\nname: {old}\ndescription: My edits\n---\nMine.");
        fs::write(user_copy.join("SKILL.md"), &custom).unwrap();
        ensure_builtin_skills(config.path()).unwrap();
        assert_eq!(
            fs::read_to_string(user_copy.join("SKILL.md")).unwrap(),
            custom
        );
        let registry = load();
        assert_eq!(registry.resolve_renamed(old), old);
        assert_eq!(registry.get_active(old).unwrap().description, "My edits");
        assert!(registry.get_active(old).unwrap().requires_inline_widgets());
    }

    #[test]
    fn bundled_anthropics_assets_are_complete_and_user_override_wins() {
        let config = test_config_dir();
        let project = TempDir::new().unwrap();
        let root = ensure_builtin_skills(config.path()).unwrap();
        let packages = crate::bundled_assets::packages();
        assert_eq!(packages.len(), 39);
        assert_eq!(
            packages
                .iter()
                .map(|package| package.files.len())
                .sum::<usize>(),
            903
        );
        assert!(
            packages.iter().any(|package| {
                package.name == "skill-creator"
                    && package.files.iter().any(|file| {
                        file.relative_path.as_path() == Path::new("scripts/agent_cli.py")
                    })
            }),
            "the bundled skill creator must include its KCoder CLI adapter"
        );
        let visualization = packages
            .iter()
            .find(|package| package.name == "inline-visualization")
            .unwrap();
        assert!(
            visualization
                .files
                .iter()
                .any(|file| file.relative_path == Path::new("LICENSE"))
        );
        let skill = crate::parse_skill_file(&root.join("inline-visualization/SKILL.md")).unwrap();
        assert!(skill.requires_inline_widgets());
        assert_eq!(skill.requires_tools, ["show_widget"]);
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
