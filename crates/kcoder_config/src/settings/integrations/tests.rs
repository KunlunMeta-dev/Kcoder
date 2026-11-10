use super::*;
use crate::Settings;
use serde_json::json;

#[test]
fn typed_and_embedded_defaults_agree_and_enable_management_without_external_authority() {
    let typed = Settings::default();
    typed.integrations.validate().unwrap();
    assert!(typed.integrations.office.enabled);
    assert!(!typed.integrations.office.allow_external_delivery);
    assert!(!typed.integrations.office.allow_organization_templates);
    assert!(typed.integrations.connectivity.enabled);
    assert!(typed.integrations.services.enabled);
    assert!(!typed.integrations.remotes.enabled);
    assert!(!typed.integrations.knowledge.publications_enabled);
    assert!(!typed.integrations.knowledge.business_automation_enabled);
    assert!(!typed.integrations.knowledge.observer_candidates_enabled);
    assert_eq!(
        serde_json::to_value(&typed.integrations).unwrap(),
        crate::default_settings_document()["integrations"]
    );
    let legacy: Settings = serde_json::from_value(json!({})).unwrap();
    assert!(legacy.integrations.office.enabled);
    assert!(legacy.integrations.connectivity.enabled);
    assert!(legacy.integrations.services.enabled);
    assert!(!legacy.integrations.knowledge.publications_enabled);
    for source in [
        include_str!("../../../settting_inline.jsonc"),
        include_str!("../../../setting_dev_user.jsonc"),
    ] {
        let document: serde_json::Value =
            jsonc_parser::parse_to_serde_value(source, &Default::default()).unwrap();
        let parsed: IntegrationSettings =
            serde_json::from_value(document["integrations"].clone()).unwrap();
        assert!(parsed.connectivity.enabled);
        assert!(parsed.services.enabled);
    }
    for field in [
        "integrations.connectivity.enabled",
        "integrations.services.enabled",
    ] {
        assert_eq!(
            crate::settings_schema_for_path(field).unwrap()["default"],
            true
        );
    }
}

#[test]
fn management_defaults_preserve_explicit_disables_without_rewriting_user_settings() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    let config = temp.path().join("profile");
    let executable = temp.path().join("executable");
    for directory in [&project, &config, &executable] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let path = config.join("settings.json");
    for (document, connectivity, services) in [
        (None, true, true),
        (
            Some(json!({"integrations":{"connectivity":{"maxConnections":4},"services":{}}})),
            true,
            true,
        ),
        (
            Some(json!({"integrations":{"connectivity":{"enabled":false}}})),
            false,
            true,
        ),
        (
            Some(json!({"integrations":{"services":{"enabled":false}}})),
            true,
            false,
        ),
        (
            Some(
                json!({"integrations":{"connectivity":{"enabled":false},"services":{"enabled":false}}}),
            ),
            false,
            false,
        ),
    ] {
        let original = document.map(|document| serde_json::to_vec(&document).unwrap());
        if let Some(original) = &original {
            std::fs::write(&path, original).unwrap();
        }
        let settings = crate::SettingsLoader::new(&project)
            .with_config_dir(&config)
            .with_executable_dir(&executable)
            .load()
            .unwrap()
            .settings;
        assert_eq!(settings.integrations.connectivity.enabled, connectivity);
        assert_eq!(settings.integrations.services.enabled, services);
        assert!(!settings.integrations.remotes.enabled);
        assert!(!settings.integrations.office.allow_external_delivery);
        if let Some(original) = original {
            assert_eq!(std::fs::read(&path).unwrap(), original);
        } else {
            assert!(!path.exists());
        }
        let restored: Settings =
            serde_json::from_value(serde_json::to_value(settings).unwrap()).unwrap();
        assert_eq!(restored.integrations.connectivity.enabled, connectivity);
        assert_eq!(restored.integrations.services.enabled, services);
    }
}

#[test]
fn schema_accepts_partial_target_settings_and_rejects_credentials_and_unbounded_limits() {
    for value in [
        json!({"integrations":{"knowledge":{"publications_enabled":true}}}),
        json!({"integrations":{"office":{"enabled":true},"connectivity":{"maxConnections":4}}}),
    ] {
        crate::schema::validate_settings_schema(&value).unwrap();
        serde_json::from_value::<Settings>(value)
            .unwrap()
            .integrations
            .validate()
            .unwrap();
    }
    for value in [
        json!({"integrations":{"knowledge":{"token":"SYNTHETIC_PRIVATE_VALUE"}}}),
        json!({"integrations":{"office":{"maxOutputBytes":100_000_000}}}),
        json!({"integrations":{"connectivity":{"maxConnections":65}}}),
        json!({"integrations":{"knowledge":{"extraction_maximum_candidates":33}}}),
    ] {
        assert!(crate::schema::validate_settings_schema(&value).is_err());
    }
    let incompatible: IntegrationSettings = serde_json::from_value(json!({
        "knowledge":{"auxiliary_extraction_enabled":true,"observer_candidates_enabled":false}
    }))
    .unwrap();
    assert!(incompatible.validate().is_err());
}

#[test]
fn integration_cross_field_checks_use_the_final_layered_settings() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    let config = temp.path().join("profile");
    std::fs::create_dir_all(project.join(".kcoder")).unwrap();
    crate::PrivateDirectory::open_or_create(&config).unwrap();
    std::fs::write(
        config.join("settings.json"),
        serde_json::to_vec(&json!({
            "integrations":{"knowledge":{"observer_candidates_enabled":true}}
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        project.join(".kcoder/settings.json"),
        serde_json::to_vec(&json!({
            "integrations":{"knowledge":{"auxiliary_extraction_enabled":true}}
        }))
        .unwrap(),
    )
    .unwrap();
    let resolved = crate::SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .unwrap();
    assert!(
        resolved
            .settings
            .integrations
            .knowledge
            .observer_candidates_enabled
    );
    assert!(
        resolved
            .settings
            .integrations
            .knowledge
            .auxiliary_extraction_enabled
    );
    assert!(
        !resolved
            .settings
            .integrations
            .knowledge
            .business_automation_enabled
    );
    assert!(
        crate::validate_and_resolve_settings_document(&json!({
            "integrations":{"knowledge":{"auxiliary_extraction_enabled":true}}
        }))
        .is_err()
    );
}
