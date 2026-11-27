//! A user-only source must not gain a new reuse identity merely from separate project authorization.
use kcoder_config::PrivateDirectory;
use kcoder_migration::{
    assets::AssetTarget,
    batch::{BatchActionKind, BatchPlanPolicy, BatchResolution, BatchSource},
    discovery::{ConfigurationBinding, SourceRegistry},
    mcp::McpTarget,
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    store::{BatchTargets, MigrationJob, MigrationStore},
};
use kcoder_types::migration::MigrationSourceKind;
use serde_json::json;
use std::path::Path;
fn prepare(
    store: &MigrationStore,
    profile: &Path,
    binding: ConfigurationBinding,
    reuse: bool,
) -> anyhow::Result<MigrationJob> {
    let job = store.create_batch_scan(vec![BatchSource::Configuration(binding)])?;
    let item = job
        .inventory
        .items
        .iter()
        .find(|item| item.provider.is_some())
        .unwrap();
    let provider = ProviderTarget::open(profile)?;
    let mcp = McpTarget::open(profile)?;
    let assets = AssetTarget::open(profile)?;
    store.prepare_batch_with_policy(
        &job.job_id,
        job.sequence,
        &[BatchResolution::Provider(ProviderResolution {
            item_id: item.preview.id.clone(),
            target_name: "StableUserOffice".into(),
            endpoint: None,
            model: None,
            limits: Some(ModelLimits {
                context_window_tokens: 128000,
                output_headroom_tokens: 8192,
                max_output_tokens: 8192,
            }),
        })],
        &BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            credentials: None,
            history: None,
        },
        &BatchPlanPolicy {
            reuse_existing: reuse,
            ..Default::default()
        },
    )
}

#[test]
fn new_user_grants_keep_only_product_proof_but_old_combined_and_project_proofs_stay_strict() {
    for replace_workspace in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let product = root.path().join("product");
        let project = root.path().join("workspace");
        PrivateDirectory::open_or_create(&profile).unwrap();
        std::fs::create_dir(&product).unwrap();
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(project.join(".claude")).unwrap();
        std::fs::write(product.join("settings.json"), r#"{"model":"user"}"#).unwrap();
        std::fs::write(product.join("CLAUDE.md"), "User instructions").unwrap();
        std::fs::write(
            project.join(".claude/settings.json"),
            r#"{"model":"project"}"#,
        )
        .unwrap();
        std::fs::write(project.join("CLAUDE.md"), "Project instructions").unwrap();
        std::fs::write(
            profile.join("trusted-folders.json"),
            json!({"trusted":[project],"never":[]}).to_string(),
        )
        .unwrap();
        let mut registry = SourceRegistry::from_selected_product_directory(
            &product,
            MigrationSourceKind::ClaudeCode,
        )
        .unwrap();
        let before = registry
            .discover(&[MigrationSourceKind::ClaudeCode], false)
            .0;
        let before = registry
            .selected(
                &before
                    .iter()
                    .find(|row| row.scope == "user")
                    .unwrap()
                    .source_id,
            )
            .unwrap();
        registry
            .authorize_selected_project(&profile, Some(&project))
            .unwrap();
        let (rows, problems) = registry.discover(&[MigrationSourceKind::ClaudeCode], true);
        assert!(problems.is_empty(), "{problems:?}");
        let user = registry
            .selected(
                &rows
                    .iter()
                    .find(|row| row.scope == "user")
                    .unwrap()
                    .source_id,
            )
            .unwrap();
        let layered = registry
            .selected(
                &rows
                    .iter()
                    .find(|row| row.scope == "project-effective")
                    .unwrap()
                    .source_id,
            )
            .unwrap();
        let project_asset = registry
            .selected_asset(
                &rows
                    .iter()
                    .find(|row| row.scope == "project-instructions")
                    .unwrap()
                    .source_id,
            )
            .unwrap();
        let project_entry = project_asset.entries().unwrap().remove(0);
        let user_asset = registry
            .selected_asset(
                &rows
                    .iter()
                    .find(|row| row.scope == "user-instructions")
                    .unwrap()
                    .source_id,
            )
            .unwrap();
        let user_entry = user_asset.entries().unwrap().remove(0);
        let user_wire = serde_json::to_value(&user).unwrap();
        assert_eq!(serde_json::to_value(&before).unwrap(), user_wire);
        assert!(user_wire["selectedRoot"].get("project").is_none());
        let mut old_wire = user_wire.clone();
        old_wire["selectedRoot"]["project"] =
            serde_json::to_value(&layered).unwrap()["selectedRoot"]["project"].clone();
        // This reproduces the already-persisted combined proof shape. It must not be normalized away.
        let old_combined: ConfigurationBinding = serde_json::from_value(old_wire.clone()).unwrap();
        old_combined.read().unwrap();
        if replace_workspace {
            let saved = project.with_extension("original");
            std::fs::rename(&project, &saved).unwrap();
            std::fs::create_dir(&project).unwrap();
            for entry in std::fs::read_dir(&saved).unwrap() {
                let entry = entry.unwrap();
                std::fs::rename(entry.path(), project.join(entry.file_name())).unwrap();
            }
        } else {
            kcoder_config::FolderTrustStore::load(&profile)
                .revoke(&project)
                .unwrap();
        }
        user.read().unwrap();
        user_asset.read(&user_entry).unwrap();
        assert!(layered.read().is_err());
        assert!(project_asset.read(&project_entry).is_err());
        assert!(old_combined.read().is_err());
        assert_eq!(serde_json::to_value(&old_combined).unwrap(), old_wire);
        let (rows, problems) = registry.discover(&[MigrationSourceKind::ClaudeCode], true);
        assert!(rows.is_empty() && !problems.is_empty());
        assert!(
            registry
                .discover(&[MigrationSourceKind::ClaudeCode], false)
                .0
                .iter()
                .any(|row| row.scope == "user")
        );
        let saved = product.with_extension("original");
        std::fs::rename(&product, &saved).unwrap();
        std::fs::create_dir(&product).unwrap();
        for entry in std::fs::read_dir(&saved).unwrap() {
            let entry = entry.unwrap();
            std::fs::rename(entry.path(), product.join(entry.file_name())).unwrap();
        }
        assert!(user.read().is_err());
        assert!(user_asset.read(&user_entry).is_err());
    }
}
#[test]
fn user_source_reuse_survives_separate_project_authorization_without_changing_its_data() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let product = root.path().join("product");
    let project = root.path().join("workspace");
    PrivateDirectory::open_or_create(&profile).unwrap();
    std::fs::create_dir(&product).unwrap();
    std::fs::create_dir(&project).unwrap();
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    std::fs::write(
        profile.join("trusted-folders.json"),
        json!({"trusted":[project],"never":[]}).to_string(),
    )
    .unwrap();
    let original=br#"{"model":"fixture-model","env":{"ANTHROPIC_BASE_URL":"https://never-call.invalid/v1"}}"#;
    std::fs::write(product.join("settings.json"), original).unwrap();
    let mut registry =
        SourceRegistry::from_selected_product_directory(&product, MigrationSourceKind::ClaudeCode)
            .unwrap();
    let before = registry
        .discover(&[MigrationSourceKind::ClaudeCode], false)
        .0;
    let before = registry
        .selected(
            &before
                .iter()
                .find(|row| row.scope == "user")
                .unwrap()
                .source_id,
        )
        .unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let planned = prepare(&store, &profile, before.clone(), false).unwrap();
    let provider = ProviderTarget::open(&profile).unwrap();
    let mcp = McpTarget::open(&profile).unwrap();
    let assets = AssetTarget::open(&profile).unwrap();
    store
        .run_batch(
            &planned.job_id,
            planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "initial-user-import",
            planned.sequence,
            false,
            &BatchTargets {
                provider: &provider,
                mcp: &mcp,
                assets: &assets,
                credentials: None,
                history: None,
            },
        )
        .unwrap();
    let baseline = prepare(&store, &profile, before.clone(), true).unwrap();
    assert!(
        matches!(
            baseline.batch.as_ref().unwrap().actions[0].action,
            BatchActionKind::Reuse { .. }
        ),
        "control: unchanged user-only source already reuses its actual receipt"
    );
    registry
        .authorize_selected_project(&profile, Some(&project))
        .unwrap();
    let after = registry
        .discover(&[MigrationSourceKind::ClaudeCode], false)
        .0;
    let after = registry
        .selected(
            &after
                .iter()
                .find(|row| row.scope == "user")
                .unwrap()
                .source_id,
        )
        .unwrap();
    assert_eq!(before.revision, after.revision);
    assert_eq!(
        std::fs::read(product.join("settings.json")).unwrap(),
        original
    );
    let reused = prepare(&store, &profile, after, true)
        .expect("independent project authorization must not lose the saved user-only reuse proof");
    assert!(matches!(
        reused.batch.as_ref().unwrap().actions[0].action,
        BatchActionKind::Reuse { .. }
    ));
}
