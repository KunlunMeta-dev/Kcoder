use super::*;
use serde_json::json;

#[test]
fn office_new_profiles_are_available_and_explicit_user_settings_are_preserved() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("project");
    let config = temp.path().join("config");
    let executable = temp.path().join("executable");
    for path in [&project, &config, &executable] {
        std::fs::create_dir_all(path).unwrap();
    }
    let path = config.join("settings.json");
    for configured in [None, Some(false), Some(true)] {
        let original = configured.map(|enabled| {
            format!("{{\"integrations\":{{\"office\":{{\"enabled\":{enabled}}}}}}}\n")
        });
        if let Some(original) = &original {
            std::fs::write(&path, original).unwrap();
        }
        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .with_executable_dir(&executable)
            .load()
            .unwrap()
            .settings;
        let expected = configured.unwrap_or(true);
        assert_eq!(loaded.integrations.office.enabled, expected);
        assert!(!loaded.integrations.office.allow_external_delivery);
        assert!(!loaded.integrations.office.allow_organization_templates);
        if let Some(original) = original {
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        } else {
            assert!(!path.exists());
        }
        let serialized = serde_json::to_value(&loaded).unwrap();
        assert_eq!(serialized["integrations"]["office"]["enabled"], expected);
        let restored: Settings = serde_json::from_value(serialized).unwrap();
        assert_eq!(restored.integrations.office.enabled, expected);
    }
}

#[test]
fn office_defaults_agree_across_typed_inline_development_and_schema() {
    let expected = serde_json::to_value(integrations::office::OfficeSettings::default()).unwrap();
    assert_eq!(expected["enabled"], true);
    let empty: Settings = serde_json::from_value(json!({})).unwrap();
    assert_eq!(
        serde_json::to_value(empty.integrations.office).unwrap(),
        expected
    );
    assert_eq!(
        serde_json::to_value(Settings::default().integrations.office).unwrap(),
        expected
    );
    for source in [
        include_str!("../../settting_inline.jsonc"),
        include_str!("../../setting_dev_user.jsonc"),
    ] {
        let document = jsonc_parser::parse_to_serde_value(source, &Default::default()).unwrap();
        crate::schema::validate_settings_schema(&document).unwrap();
        let parsed: integrations::IntegrationSettings =
            serde_json::from_value(document["integrations"].clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed.office).unwrap(), expected);
    }
    for (field, value) in expected.as_object().unwrap() {
        let schema = settings_schema_for_path(&format!("integrations.office.{field}")).unwrap();
        assert_eq!(schema["default"], *value, "default mismatch for {field}");
    }
}

#[test]
fn office_strict_schema_and_loader_reject_unknown_types_and_out_of_range_values() {
    let invalid = [
        json!({"integrations": null}),
        json!({"integrations": {"unsupportedDomain": {}}}),
        json!({"integrations": {"office": null}}),
        json!({"integrations": {"office": {"unknown": true}}}),
        json!({"integrations": {"office": {"enabled": "true"}}}),
        json!({"integrations": {"office": {"allowExternalDelivery": 1}}}),
        json!({"integrations": {"office": {"allowedFormats": []}}}),
        json!({"integrations": {"office": {"allowedFormats": ["html"]}}}),
        json!({"integrations": {"office": {"allowedFormats": ["docx", "docx", "docx", "docx", "docx", "docx", "docx"]}}}),
        json!({"integrations": {"office": {"maxOutputBytes": 0}}}),
        json!({"integrations": {"office": {"maxOutputBytes": 20971521}}}),
        json!({"integrations": {"office": {"maxDatasetRows": 10001}}}),
        json!({"integrations": {"office": {"maxDatasetRows": 0}}}),
        json!({"integrations": {"office": {"datasetPageRows": 101}}}),
        json!({"integrations": {"office": {"datasetPageRows": 0}}}),
        json!({"integrations": {"office": {"projectionPreviewChars": 127}}}),
        json!({"integrations": {"office": {"projectionPreviewChars": 8001}}}),
        json!({"integrations": {"office": {"generationTimeoutMs": 60001}}}),
        json!({"integrations": {"office": {"generationTimeoutMs": 0}}}),
        json!({"integrations": {"office": {"maxOutputBytes": 1.5}}}),
    ];
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    let executable = temp.path().join("executable");
    for directory in [&config, &project, &executable] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let path = config.join("settings.json");
    for document in invalid {
        assert!(
            crate::schema::validate_settings_schema(&document).is_err(),
            "schema accepted {document}"
        );
        let original = serde_json::to_vec(&document).unwrap();
        std::fs::write(&path, &original).unwrap();
        assert!(
            SettingsLoader::new(&project)
                .with_config_dir(&config)
                .with_executable_dir(&executable)
                .load()
                .is_err(),
            "loader accepted {document}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }
}

#[test]
fn office_all_existing_fields_and_limit_boundaries_survive_resolution() {
    for (field, lower, upper) in [
        ("maxOutputBytes", 1, 20971520),
        ("maxDatasetRows", 1, 10000),
        ("datasetPageRows", 1, 100),
        ("projectionPreviewChars", 128, 8000),
        ("generationTimeoutMs", 1, 60000),
    ] {
        for value in [lower, upper] {
            let mut document = json!({"integrations": {"office": {}}});
            document["integrations"]["office"][field] = json!(value);
            let settings = validate_and_resolve_settings_document(&document).unwrap();
            settings.integrations.office.validate().unwrap();
            assert_eq!(
                serde_json::to_value(settings).unwrap()["integrations"]["office"][field],
                value
            );
        }
    }
    let document = json!({"integrations": {"office": {
        "enabled": true, "allowOrganizationTemplates": true, "allowExternalDelivery": true,
        "allowedFormats": ["docx", "xlsx", "pptx", "pdf", "csv", "json"]
    }}});
    let settings = validate_and_resolve_settings_document(&document).unwrap();
    let serialized = serde_json::to_value(&settings).unwrap();
    for (field, value) in document["integrations"]["office"].as_object().unwrap() {
        assert_eq!(serialized["integrations"]["office"][field], *value);
    }
}
