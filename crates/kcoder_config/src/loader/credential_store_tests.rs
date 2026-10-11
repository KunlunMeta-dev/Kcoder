use super::*;

fn write_credentials(path: &Path, provider: &str, value: &str) {
    std::fs::write(
        path,
        format!("{{\"{provider}\": {{\"type\": \"api\", \"key\": \"{value}\"}}}}"),
    )
    .unwrap();
}

#[test]
fn revocation_survives_reload_blocks_fallback_and_login_clears_it() {
    let temp = tempfile::tempdir().unwrap();
    let loader = SettingsLoader::new(temp.path()).with_config_dir(temp.path());
    let paths = loader.paths().unwrap();
    let mut store = CredentialStore::default();
    store
        .set_api_key("openai", "stored-fixture".into())
        .unwrap();
    assert!(store.remove_api_key("openai").unwrap());
    store.save_to(&paths.credentials).unwrap();
    let document: Value = serde_json::from_slice(&fs::read(&paths.credentials).unwrap()).unwrap();
    assert_eq!(document["openai"], serde_json::json!({"type":"revoked"}));
    // The old wire shape requires a key, so an old client cannot silently fall back.
    #[derive(Deserialize)]
    struct OldEntry {
        #[serde(rename = "key")]
        _key: String,
    }
    assert!(serde_json::from_value::<BTreeMap<String, OldEntry>>(document).is_err());
    let mut settings = Settings {
        openai_api_key: Some("legacy-fixture".into()),
        api_key: Some("global-fixture".into()),
        ..Settings::default()
    };
    loader
        .refresh_stored_provider_credentials(&mut settings)
        .unwrap();
    assert!(
        settings
            .resolve_provider_api_key(Some("openai"), None)
            .is_none()
    );
    assert_eq!(
        settings
            .resolve_provider_api_key(Some("openai"), Some("explicit-fixture".into()))
            .as_deref(),
        Some("explicit-fixture")
    );
    let mut restored = CredentialStore::load_from(&paths.credentials).unwrap();
    assert!(restored.set_api_key("openai", " ".into()).is_err());
    assert!(restored.revoked.contains("openai"));
    restored
        .set_api_key("openai", "replacement-fixture".into())
        .unwrap();
    restored.save_to(&paths.credentials).unwrap();
    loader
        .refresh_stored_provider_credentials(&mut settings)
        .unwrap();
    assert_eq!(
        settings
            .resolve_provider_api_key(Some("openai"), None)
            .as_deref(),
        Some("replacement-fixture")
    );
}

#[test]
fn revocation_only_update_is_persisted_and_conflicting_entries_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("credentials.json");
    CredentialStore::update_file(&path, |store| {
        store.remove_api_key("fixture")?;
        Ok(())
    })
    .unwrap();
    assert!(
        CredentialStore::load_from(&path)
            .unwrap()
            .revoked
            .contains("fixture")
    );
    assert!(
        serde_json::from_value::<CredentialStore>(
            serde_json::json!({"fixture":{"type":"revoked","key":"secret-fixture"}})
        )
        .is_err()
    );
    let mut conflicting = CredentialStore::default();
    conflicting.revoked.insert("fixture".into());
    conflicting
        .credentials
        .insert("fixture".into(), "secret-fixture".into());
    assert!(serde_json::to_value(&conflicting).is_err());
}

#[test]
fn credential_refresh_preserves_semantics_and_observes_rotation_and_removal() {
    let temp = tempfile::tempdir().unwrap();
    let loader = SettingsLoader::new(temp.path()).with_config_dir(temp.path());
    let paths = loader.paths().unwrap();
    // An unrelated invalid edit must not invalidate an in-flight model snapshot.
    std::fs::write(&paths.user_settings, "invalid settings document").unwrap();
    let mut settings = Settings {
        model: "pinned-model".into(),
        max_tokens: Some(1234),
        credential_store: crate::CredentialStoreMode::File,
        ..Settings::default()
    };
    write_credentials(&paths.credentials, "openai", "first-fixture");
    loader
        .refresh_stored_provider_credentials(&mut settings)
        .unwrap();
    let source = settings
        .resolve_provider_api_key_with_source(Some("openai"), None)
        .unwrap()
        .source;
    write_credentials(&paths.credentials, "openai", "rotated-fixture");
    loader
        .refresh_stored_provider_credentials(&mut settings)
        .unwrap();
    assert_eq!(
        settings
            .resolve_bound_provider_api_key(Some("openai"), None, &source)
            .unwrap()
            .into_key(),
        "rotated-fixture"
    );
    assert_eq!(settings.model, "pinned-model");
    assert_eq!(settings.max_tokens, Some(1234));
    std::fs::write(&paths.credentials, "{}").unwrap();
    loader
        .refresh_stored_provider_credentials(&mut settings)
        .unwrap();
    assert!(
        settings
            .resolve_bound_provider_api_key(Some("openai"), None, &source)
            .is_err()
    );
    assert!(settings.openai_api_key.is_none());
}

#[test]
fn markers_are_dropped_when_the_credential_store_is_file() {
    let temp = tempfile::tempdir().unwrap();
    let credentials = temp.path().join("credentials.json");
    write_credentials(&credentials, "deepseek", "keyring:kcoder/deepseek");
    let mut settings = Settings {
        credential_store: crate::CredentialStoreMode::File,
        ..Settings::default()
    };
    let store = CredentialStore::load_from(&credentials).unwrap();
    apply_credentials(&mut settings, &store);
    assert!(settings.stored_provider_credentials.is_empty());

    write_credentials(&credentials, "deepseek", "sk-plaintext");
    let store = CredentialStore::load_from(&credentials).unwrap();
    apply_credentials(&mut settings, &store);
    assert_eq!(
        settings
            .stored_provider_credentials
            .get("deepseek")
            .map(String::as_str),
        Some("sk-plaintext")
    );

    write_credentials(&credentials, "openai", "sk-legacy-openai");
    let store = CredentialStore::load_from(&credentials).unwrap();
    apply_credentials(&mut settings, &store);
    assert_eq!(settings.openai_api_key.as_deref(), Some("sk-legacy-openai"));
}
