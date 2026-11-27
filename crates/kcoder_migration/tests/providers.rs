use kcoder_migration::{
    parse_claude_settings, parse_codex_config,
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
};
use serde_json::json;

fn resolution(id: &str) -> ProviderResolution {
    ProviderResolution {
        item_id: id.into(),
        target_name: "Imported".into(),
        endpoint: None,
        model: None,
        limits: Some(ModelLimits {
            context_window_tokens: 128000,
            output_headroom_tokens: 8192,
            max_output_tokens: 8192,
        }),
    }
}

#[test]
fn both_source_adapters_require_explicit_missing_limits_without_guessing() {
    let root = tempfile::tempdir().unwrap();
    let target = ProviderTarget::open(root.path()).unwrap();
    let sources = [
        parse_claude_settings(r#"{"model":"claude-example","env":{"ANTHROPIC_BASE_URL":"https://example.invalid"}}"#).unwrap(),
        parse_codex_config("model='codex-example'\nmodel_provider='Team'\n[model_providers.Team]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\n").unwrap(),
    ];
    for source in sources {
        let item = &source.items[0];
        let mut options = resolution(&item.preview.id);
        options.limits = None;
        assert!(target.prepare(item, &options).is_err());
        options.limits = resolution(&item.preview.id).limits;
        let plan = target.prepare(item, &options).unwrap();
        assert_eq!(
            plan.item().provider.as_ref().unwrap().model,
            item.provider.as_ref().unwrap().model
        );
        assert!(
            plan.item().preview.issues.iter().any(
                |issue| issue.phase == kcoder_types::migration::MigrationIssuePhase::Activation
            )
        );
    }
    assert!(!root.path().join("settings.json").exists());
}

#[test]
fn unsafe_endpoints_invalid_limits_and_protocols_cannot_be_resolved_by_dropping_issues() {
    let root = tempfile::tempdir().unwrap();
    let target = ProviderTarget::open(root.path()).unwrap();
    let source = parse_claude_settings(
        r#"{"model":"example","env":{"ANTHROPIC_BASE_URL":"https://example.invalid"}}"#,
    )
    .unwrap();
    let item = &source.items[0];
    for endpoint in [
        "https://user:secret@example.invalid",
        "https://example.invalid?key=secret",
        "file:///private",
    ] {
        let mut options = resolution(&item.preview.id);
        options.endpoint = Some(endpoint.into());
        assert!(target.prepare(item, &options).is_err());
    }
    let mut options = resolution(&item.preview.id);
    options.limits.as_mut().unwrap().max_output_tokens = 128001;
    assert!(target.prepare(item, &options).is_err());
    let incompatible = parse_codex_config("model='example'\nmodel_provider='Team'\n[model_providers.Team]\nbase_url='https://example.invalid'\nwire_api='chat'\n").unwrap();
    assert!(
        target
            .prepare(
                &incompatible.items[0],
                &resolution(&incompatible.items[0].preview.id)
            )
            .is_err()
    );
}

#[test]
fn existing_provider_names_are_conflicts_and_explicit_empty_catalog_keeps_no_selection() {
    let root = tempfile::tempdir().unwrap();
    let target = ProviderTarget::open(root.path()).unwrap();
    let source = parse_claude_settings(
        r#"{"model":"example","env":{"ANTHROPIC_BASE_URL":"https://example.invalid"}}"#,
    )
    .unwrap();
    let item = &source.items[0];
    let mut options = resolution(&item.preview.id);
    // Fresh profiles ship no Provider, so declare the existing name explicitly.
    std::fs::write(
        root.path().join("settings.json"),
        json!({"providers": {"Existing": {
            "api_format": "anthropic_messages", "endpoint": "https://existing.example.invalid",
            "default_model": "existing-model", "context_window_tokens": 128000,
            "output_headroom_tokens": 8192, "max_output_tokens": 8192
        }}})
        .to_string(),
    )
    .unwrap();
    options.target_name = "Existing".into();
    assert!(target.prepare(item, &options).is_err());
    std::fs::write(
        root.path().join("settings.json"),
        json!({"providers": {}, "active_provider": null}).to_string(),
    )
    .unwrap();
    options.target_name = "Imported".into();
    assert!(target.prepare(item, &options).is_ok());
    options.target_name = "../outside".into();
    assert!(target.prepare(item, &options).is_err());
}

#[test]
fn codex_provider_publication_and_rollback_preserve_an_explicit_target_catalog() {
    use kcoder_migration::store::MigrationStore;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    let original = json!({
        "active_provider": "ExistingAPI",
        "providers": {"ExistingAPI": {
            "api_format": "anthropic_messages", "endpoint": "https://existing.example.invalid",
            "default_model": "existing-model", "context_window_tokens": 128000,
            "output_headroom_tokens": 8192, "max_output_tokens": 8192
        }}
    });
    kcoder_config::update_settings_file(&path, |value| {
        *value = original.clone();
        Ok(())
    })
    .unwrap();
    let source = parse_codex_config("model='source-model'\nmodel_provider='TeamGateway'\n[model_providers.TeamGateway]\nbase_url='https://codex.example.invalid/v1'\nwire_api='responses'\nenv_key='TEAM_GATEWAY_KEY'\n").unwrap();
    let id = source.items[0].preview.id.clone();
    let store = MigrationStore::open_or_create(root.path()).unwrap();
    let job = store.create_scan("selected-codex-source", source).unwrap();
    let job = store
        .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
        .unwrap();
    let target = ProviderTarget::open(root.path()).unwrap();
    let mut options = resolution(&id);
    options.target_name = "TeamGateway".into();
    let staged = store
        .prepare_provider(&job.job_id, job.sequence, &target, &options)
        .unwrap();
    let plan_id = staged.provider_plans[0].id().to_owned();
    let committed = store
        .apply_provider(&job.job_id, staged.sequence, &plan_id, &target)
        .unwrap();
    let value = kcoder_config::read_settings_file(&path).unwrap();
    let resolved = kcoder_config::validate_and_resolve_settings_document(&value).unwrap();
    assert_eq!(resolved.active_provider.as_deref(), Some("ExistingAPI"));
    assert_eq!(resolved.model, "existing-model");
    assert_eq!(resolved.providers.len(), 2);
    assert!(!resolved.providers.contains_key("kunlunmeta"));
    assert_eq!(
        resolved.providers["TeamGateway"].api_format,
        kcoder_config::ApiFormat::OpenaiResponses
    );
    assert!(resolved.providers["TeamGateway"].credential_env.is_empty());
    store
        .rollback_provider(&job.job_id, committed.sequence, &plan_id, &target)
        .unwrap();
    assert_eq!(kcoder_config::read_settings_file(&path).unwrap(), original);
}

#[test]
fn migration_does_not_adopt_existing_keyring_or_legacy_credential_namespaces() {
    for credentials in [
        json!({"Team.Gateway":{"type":"api","key":"keyring:kcoder/Team.Gateway"}}),
        json!({"api_keys":{"Team.Gateway":"SYNTHETIC_EXISTING_TARGET_SECRET"}}),
    ] {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("credentials.json"),
            credentials.to_string(),
        )
        .unwrap();
        let target = ProviderTarget::open(root.path()).unwrap();
        let inventory = parse_claude_settings(
            r#"{"model":"fixture","env":{"ANTHROPIC_BASE_URL":"https://example.invalid"}}"#,
        )
        .unwrap();
        let mut options = resolution(&inventory.items[0].preview.id);
        options.target_name = "Team.Gateway".into();
        let error = target.prepare(&inventory.items[0], &options).unwrap_err();
        assert_eq!(
            error.to_string(),
            "migration_existing_credentials_require_confirmation"
        );
        assert!(!root.path().join("settings.json").exists());
        assert_eq!(
            std::fs::read_to_string(root.path().join("credentials.json")).unwrap(),
            credentials.to_string()
        );
    }
}

#[test]
fn newly_added_credentials_after_preview_block_publication_without_touching_either_document() {
    use kcoder_migration::store::MigrationStore;
    let root = tempfile::tempdir().unwrap();
    let inventory = parse_claude_settings(
        r#"{"model":"fixture","env":{"ANTHROPIC_BASE_URL":"https://example.invalid"}}"#,
    )
    .unwrap();
    let id = inventory.items[0].preview.id.clone();
    let store = MigrationStore::open_or_create(root.path()).unwrap();
    let job = store.create_scan("source", inventory).unwrap();
    let selected = store
        .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
        .unwrap();
    let target = ProviderTarget::open(root.path()).unwrap();
    let mut options = resolution(&id);
    options.target_name = "Team.Gateway".into();
    let staged = store
        .prepare_provider(&job.job_id, selected.sequence, &target, &options)
        .unwrap();
    let credentials =
        json!({"Team.Gateway":{"type":"api","key":"keyring:kcoder/Team.Gateway"}}).to_string();
    std::fs::write(root.path().join("credentials.json"), &credentials).unwrap();
    assert_eq!(
        store
            .apply_provider(
                &job.job_id,
                staged.sequence,
                staged.provider_plans[0].id(),
                &target
            )
            .unwrap_err()
            .to_string(),
        "migration_existing_credentials_require_confirmation"
    );
    assert!(!root.path().join("settings.json").exists());
    assert_eq!(
        std::fs::read_to_string(root.path().join("credentials.json")).unwrap(),
        credentials
    );
}
