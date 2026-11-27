use super::*;
use serde_json::json;

#[test]
fn legacy_fixture_is_normalized_without_materializing_defaults() {
    let mut value: Value = serde_json::from_str(include_str!("fixtures/unversioned.json")).unwrap();
    migrate_settings_document(&mut value).unwrap();
    assert_eq!(value["meta"]["config_version"], 1);
    assert_eq!(value["active_provider"], "custom");
    assert_eq!(
        value["providers"]["custom"]["default_model"],
        "chosen-model"
    );
    assert_eq!(value["providers"].as_object().unwrap().len(), 1);
    assert!(value.get("active_profile").is_none());
    assert!(value.get("max_concurrent_subagents").is_none());
    let once = value.clone();
    migrate_settings_document(&mut value).unwrap();
    assert_eq!(value, once);
}

#[test]
fn unsupported_versions_and_malformed_metadata_are_not_modified() {
    for mut value in [
        json!({"meta":{"config_version":0}, "active_profile":"old"}),
        json!({"meta":{"config_version":2}, "active_profile":"old"}),
        json!({"meta":{"config_version":-1}}),
        json!({"meta":{"config_version":"1"}}),
        json!({"meta":null}),
        json!([]),
    ] {
        let before = value.clone();
        assert!(migrate_settings_document(&mut value).is_err());
        assert_eq!(value, before);
    }
}

#[test]
fn explicit_current_fields_win_and_empty_provider_catalog_stays_empty() {
    let mut value = json!({"meta":{"config_version":1}, "active_provider":"current",
        "active_profile":"old", "providers":{}, "provider_profiles":{"old":{}}});
    migrate_settings_document(&mut value).unwrap();
    assert_eq!(value["active_provider"], "current");
    assert_eq!(value["providers"], json!({}));
    assert!(value.get("active_profile").is_none());
    assert!(value.get("provider_profiles").is_none());
}

#[test]
fn legacy_provider_catalog_and_name_are_migrated_in_one_pass() {
    let mut value = json!({"active_profile":"minimax", "provider_profiles":{
        "minimax":{"model":"selected", "api_format":"anthropic_messages"}
    }});
    migrate_settings_document(&mut value).unwrap();
    assert_eq!(value["active_provider"], "kunlunmeta");
    assert_eq!(
        value["providers"]["kunlunmeta"]["default_model"],
        "selected"
    );
    assert!(value["providers"].get("minimax").is_none());
    let once = value.clone();
    migrate_settings_document(&mut value).unwrap();
    assert_eq!(value, once);
}

#[test]
fn file_and_scope_writers_cannot_hide_a_future_version_in_their_update_callback() {
    let temp = tempfile::tempdir().unwrap();
    let paths = crate::ConfigPaths::with_config_dir(temp.path(), temp.path().to_owned());
    let path = paths.for_scope(crate::ConfigScope::User);
    let bytes = r#"{"meta":{"config_version":2},"model":"retained"}"#;
    std::fs::write(path, bytes).unwrap();
    assert!(crate::write_scope(&paths, crate::ConfigScope::User, &json!({})).is_err());
    let called = std::cell::Cell::new(false);
    assert!(
        crate::update_settings_file(path, |document| {
            called.set(true);
            *document = json!({});
            Ok(())
        })
        .is_err()
    );
    assert!(!called.get());
    let directory = crate::PrivateDirectory::open_existing(temp.path()).unwrap();
    let profile = crate::ProfileSettingsFile::new(directory).unwrap();
    assert!(
        profile
            .update(|document| {
                called.set(true);
                *document = json!({});
                Ok(())
            })
            .is_err()
    );
    assert!(
        crate::update_settings_and_credentials(path, |document, _| {
            called.set(true);
            *document = json!({});
            Ok(())
        })
        .is_err()
    );
    assert!(!called.get());
    assert_eq!(std::fs::read_to_string(path).unwrap(), bytes);
}
