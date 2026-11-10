//! Reviewed static Agents use ordinary durable publication, disabled activation and owned Undo.
use kcoder_config::PrivateDirectory;
use kcoder_migration::{
    assets::{AssetResolution, AssetTarget},
    batch::{BatchResolution, BatchSource},
    discovery::SourceRegistry,
    mcp::McpTarget,
    providers::ProviderTarget,
    store::{BatchTargets, MigrationStore},
};
use kcoder_types::{
    migration::{MigrationJobStatus, MigrationSourceKind as Kind},
    migration_agent::{ImportedAgentModel, MigrationAgentAdaptation},
    plugin_prompt::PluginPromptProfile,
};
use sha2::{Digest, Sha256};
use std::fs;

#[test]
fn both_sources_publish_disabled_native_agents_and_original_batch_undo_survives_source_loss() {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        exercise(kind, false);
    }
}
#[test]
fn original_agent_undo_preserves_later_user_edits() {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        exercise(kind, true);
    }
}
fn exercise(kind: Kind, edit_after_publication: bool) {
    let root = tempfile::tempdir().unwrap();
    let product = root.path().join("source");
    let profile = root.path().join("profile");
    PrivateDirectory::open_or_create(&profile).unwrap();
    fs::write(profile.join("settings.json"), "{}").unwrap();
    fs::create_dir_all(product.join("agents")).unwrap();
    let (file, content) = match kind {
        Kind::ClaudeCode => (
            "reviewer.md",
            "---\nname: reviewer\ndescription: Inspect only\ntools: Read, Write\ndisallowedTools: Write\nmodel: source-alias\n---\nReview $0 literally.\n",
        ),
        Kind::Codex => (
            "reviewer.toml",
            "name='reviewer'\ndescription='Inspect only'\nmodel='source-alias'\ndeveloper_instructions='Review $0 literally.'\n",
        ),
    };
    fs::write(product.join("agents").join(file), content).unwrap();
    let mut registry = SourceRegistry::from_selected_product_directory(&product, kind).unwrap();
    let source = registry
        .discover_definitions(&[kind], false)
        .0
        .into_iter()
        .find(|source| source.scope == "user-agents")
        .unwrap();
    let binding = registry.selected_asset(&source.source_id).unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let job = store
        .create_batch_scan(vec![BatchSource::Assets(binding)])
        .unwrap();
    let item = &job.inventory.items[0];
    let item_id = item.preview.id.clone();
    let provider = ProviderTarget::open(&profile).unwrap();
    let mcp = McpTarget::open(&profile).unwrap();
    let assets = AssetTarget::open(&profile).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: None,
    };
    let choice = AssetResolution {
        item_id: item_id.clone(),
        target_name: "reviewed-agent".into(),
        enable_after_import: false,
        memory_scope: None,
        agent_adaptation: Some(MigrationAgentAdaptation {
            reviewed_source_sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
            model: ImportedAgentModel::Target {
                provider: "native-provider".into(),
                model: "native-model".into(),
            },
            tools: vec!["read".into()],
        }),
    };
    let planned = store
        .prepare_batch(
            &job.job_id,
            job.sequence,
            &[BatchResolution::Asset(choice)],
            &targets,
        )
        .unwrap();
    let plan_id = planned
        .batch
        .as_ref()
        .unwrap()
        .plan_id
        .as_deref()
        .unwrap()
        .to_owned();
    let published = store
        .run_batch(
            &job.job_id,
            &plan_id,
            "publish-reviewed",
            planned.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(published.status, MigrationJobStatus::Completed);
    let path = profile.join("skills/reviewed-agent/plugin-agent.json");
    let native_profile: PluginPromptProfile =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(native_profile.allowed_tools, Some(vec!["read".into()]));
    assert!(native_profile.instructions.contains("$0 literally"));
    assert_eq!(
        native_profile.imported_agent.unwrap().model,
        ImportedAgentModel::Target {
            provider: "native-provider".into(),
            model: "native-model".into()
        }
    );
    let load = || {
        kcoder_skills::SkillRegistry::load_for_profile(
            root.path(),
            std::iter::empty::<&std::path::Path>(),
            &profile,
            true,
        )
        .unwrap()
    };
    let registry = load();
    let skill = registry
        .list_catalog()
        .into_iter()
        .find(|skill| skill.name == "reviewed-agent")
        .unwrap();
    assert_eq!(skill.category.as_deref(), Some("plugin-prompt"));
    assert!(registry.get_active("reviewed-agent").is_none());
    let token = skill.activation.as_ref().unwrap().token.clone();
    kcoder_skills::activation::set_enabled_for_import(
        &profile,
        "reviewed-agent",
        true,
        Some(&token),
    )
    .unwrap();
    assert!(load().get_active("reviewed-agent").is_some());
    fs::rename(&product, root.path().join("source-unavailable")).unwrap();
    if edit_after_publication {
        let mut bytes = fs::read(&path).unwrap();
        bytes.extend_from_slice(b"\n");
        fs::write(&path, bytes).unwrap();
    }
    let store = MigrationStore::open_existing(&profile).unwrap();
    let snapshot = store.definition_snapshot(&job.job_id, &item_id).unwrap();
    assert_eq!(&*snapshot.bytes, content.as_bytes());
    let reopened = store.read(&job.job_id).unwrap();
    let undone = store
        .run_batch(
            &job.job_id,
            &plan_id,
            "undo-reviewed",
            reopened.sequence,
            true,
            &targets,
        )
        .unwrap();
    if edit_after_publication {
        assert_ne!(undone.status, MigrationJobStatus::RolledBack);
        assert!(path.exists());
    } else {
        assert_eq!(undone.status, MigrationJobStatus::RolledBack);
        assert!(!path.exists());
    }
    assert_eq!(fs::read(profile.join("settings.json")).unwrap(), b"{}");
    assert_eq!(
        &*store
            .definition_snapshot(&job.job_id, &item_id)
            .unwrap()
            .bytes,
        content.as_bytes()
    );
}
