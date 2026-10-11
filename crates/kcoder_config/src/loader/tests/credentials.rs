use super::*;

#[test]
fn credential_update_file_serializes_different_keys_and_preserves_existing_fields() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("credentials.json");
    CredentialStore::update_file(&path, |store| {
        store.set_api_key("VendorA", "fixture-preserved".into())
    })
    .unwrap();
    let barrier = std::sync::Barrier::new(8);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let path = &path;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    CredentialStore::update_file(path, |store| {
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        store.set_api_key(
                            &format!("provider-{index}"),
                            format!("fixture-key-{index}"),
                        )
                    })
                    .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
    });
    let stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(stored.as_object().unwrap().len(), 9);
    assert_eq!(
        stored["VendorA"],
        serde_json::json!({"type":"api", "key":"fixture-preserved"})
    );
    for index in 0..8 {
        assert_eq!(
            stored[format!("provider-{index}")],
            serde_json::json!({"type":"api", "key":format!("fixture-key-{index}")})
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn credential_update_file_error_closure_does_not_persist_partial_mutations() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("credentials.json");
    let original = b"{\n  \"VendorA\": {\"type\": \"api\", \"key\": \"fixture-original\"}\n}\n";
    fs::write(&path, original).unwrap();
    let result = CredentialStore::update_file(&path, |store| {
        store.remove_api_key("VendorA")?;
        store.set_api_key("other", "fixture-discarded".into())?;
        anyhow::bail!("fixture mutation rejected")
    });
    assert!(result.is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
    CredentialStore::update_file(&path, |store| {
        store.set_api_key("retry", "fixture-retry".into())
    })
    .unwrap();
    let reloaded = CredentialStore::load_from(&path).unwrap();
    assert!(reloaded.has_api_key("VendorA"));
    assert!(reloaded.has_api_key("retry"));
    assert!(!reloaded.has_api_key("other"));
}

#[test]
fn credential_store_preserves_exact_provider_ids_without_aliases() {
    let mut credentials = CredentialStore::default();
    credentials
        .set_api_key("VendorA", "upper-key".to_string())
        .unwrap();
    credentials
        .set_api_key("vendora", "lower-key".to_string())
        .unwrap();
    credentials
        .set_api_key("vllm", "vllm-key".to_string())
        .unwrap();

    assert_eq!(credentials.credentials["VendorA"], "upper-key");
    assert_eq!(credentials.credentials["vendora"], "lower-key");
    assert_eq!(credentials.credentials["vllm"], "vllm-key");
    assert!(!credentials.has_api_key("local"));
}

#[test]
fn credential_store_uses_root_provider_shape() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("credentials.json");
    let mut credentials = CredentialStore::default();
    credentials
        .set_api_key("kunlunmeta", "test-key".to_string())
        .unwrap();

    credentials.save_to(&path).unwrap();

    let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(value["kunlunmeta"]["type"], "api");
    assert_eq!(value["kunlunmeta"]["key"], "test-key");
    assert!(value.get("api_keys").is_none());
    assert_eq!(CredentialStore::load_from(&path).unwrap(), credentials);
}

#[test]
fn credential_store_reads_and_migrates_the_legacy_api_keys_wrapper() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("credentials.json");
    write(
        &path,
        r#"{"api_keys":{"minimax":"legacy-minimax","openai":"legacy-openai"}}"#,
    );

    let credentials = CredentialStore::load_from(&path).unwrap();
    assert_eq!(credentials.credentials["kunlunmeta"], "legacy-minimax");
    assert_eq!(credentials.credentials["openai"], "legacy-openai");

    credentials.save_to(&path).unwrap();
    let migrated: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(migrated["kunlunmeta"]["type"], "api");
    assert_eq!(migrated["kunlunmeta"]["key"], "legacy-minimax");
    assert!(migrated.get("minimax").is_none());
    assert!(migrated.get("api_keys").is_none());
}

#[test]
fn credential_store_rejects_mixed_legacy_and_current_documents_without_rewriting() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("credentials.json");
    let original = r#"{"api_keys":{"openai":"legacy"},"minimax":{"type":"api","key":"current"}}"#;
    write(&path, original);

    let error = CredentialStore::load_from(&path).unwrap_err();
    assert!(error.to_string().contains("failed to parse credentials"));
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
}

#[test]
fn credentials_are_loaded_outside_settings_json() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut credentials = CredentialStore::default();
    credentials
        .set_api_key("kunlunmeta", "kunlunmeta-secret".to_string())
        .unwrap();
    credentials
        .set_api_key("deepseek", "deepseek-secret".to_string())
        .unwrap();
    credentials
        .save_to(&config.join("credentials.json"))
        .unwrap();
    let mut raw: Value =
        serde_json::from_str(&fs::read_to_string(config.join("credentials.json")).unwrap())
            .unwrap();
    raw["minimax"] = serde_json::json!({"type": "api", "key": "retired-secret"});
    write(
        &config.join("credentials.json"),
        &serde_json::to_string_pretty(&raw).unwrap(),
    );

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .unwrap();
    assert_eq!(
        loaded.settings.kunlunmeta_api_key.as_deref(),
        Some("kunlunmeta-secret")
    );
    assert!(
        loaded
            .settings
            .stored_provider_credentials
            .contains_key("minimax")
    );
    assert_eq!(
        loaded
            .settings
            .stored_provider_credentials
            .get("deepseek")
            .map(String::as_str),
        Some("deepseek-secret")
    );
    let serialized = serde_json::to_string(&loaded.settings).unwrap();
    assert!(!serialized.contains("secret-value"));
    assert!(!serialized.contains("kunlunmeta-secret"));
    assert!(!serialized.contains("deepseek-secret"));
}
