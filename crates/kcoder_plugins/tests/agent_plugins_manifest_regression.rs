use kcoder_plugins::load_plugin_manifest;
use serde_json::{Value, json};
use std::path::Path;

const AGENT_PLUGIN_SCHEMA: &str = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

fn plugin_root() -> tempfile::TempDir {
    tempfile::tempdir().expect("temporary plugin root")
}

fn manifest(fields: Value) -> Value {
    let mut result = json!({
        "$schema": AGENT_PLUGIN_SCHEMA,
        "name": "manifest-regression"
    });
    result
        .as_object_mut()
        .expect("manifest object")
        .extend(fields.as_object().expect("field object").clone());
    result
}

fn load(root: &Path, value: &Value) -> Result<kcoder_plugins::LoadedPluginManifest, String> {
    std::fs::write(
        root.join("plugin.json"),
        serde_json::to_vec(value).expect("serialize manifest"),
    )
    .expect("write manifest");
    load_plugin_manifest(root)
        .map(|loaded| loaded.expect("plugin manifest should be found"))
        .map_err(|error| error.to_string())
}

#[test]
fn rejects_wrong_types_and_unknown_author_fields_from_v1_schema() {
    let root = plugin_root();
    let invalid_fields = [
        json!({"author": {"email": 42}}),
        json!({"author": {"url": false}}),
        json!({"author": {"name": "Ada", "handle": "ada"}}),
        json!({"version": 1}),
        json!({"description": false}),
        json!({"homepage": []}),
        json!({"repository": false}),
        json!({"license": null}),
        json!({"keywords": ["valid", 42]}),
    ];

    for fields in invalid_fields {
        let document = manifest(fields.clone());
        let error = load(root.path(), &document);
        assert!(
            error.is_err(),
            "Agent Plugins v1 manifest accepted invalid known fields: {fields}"
        );
    }
}

#[test]
fn rejects_non_string_schema_instead_of_falling_back_to_legacy_manifest() {
    let root = plugin_root();
    let document = manifest(json!({"$schema": 1}));

    let error = load(root.path(), &document).expect_err("non-string `$schema` must be invalid");

    assert!(
        error.contains("`$schema` must be a string"),
        "unexpected error: {error}"
    );
}

#[test]
fn reports_unknown_top_level_fields_without_rejecting_otherwise_valid_manifest() {
    let root = plugin_root();
    let document = manifest(json!({
        "futureVendorField": {"opaque": [1, true, null]}
    }));

    let loaded = load(root.path(), &document)
        .unwrap_or_else(|error| panic!("unknown top-level field should be ignored: {error}"));

    assert_eq!(loaded.manifest.name, "manifest-regression");
    assert!(loaded.compatibility.issues.iter().any(|issue| {
        issue.code == "manifest_field_ignored"
            && issue.message.contains("futureVendorField")
            && issue.message.contains("ignored")
    }));
}

#[test]
fn ignores_non_object_extensions_as_required_by_v1_specification() {
    let root = plugin_root();
    let document = manifest(json!({"extensions": ["invalid namespace data"]}));

    let loaded = load(root.path(), &document)
        .unwrap_or_else(|error| panic!("non-object extensions should be ignored: {error}"));

    assert_eq!(loaded.manifest.name, "manifest-regression");
    assert!(loaded.compatibility.issues.iter().any(|issue| {
        issue.code == "manifest_field_ignored"
            && issue.message.contains("extensions")
            && issue.message.contains("ignored")
    }));
}

#[test]
fn leaves_unimplemented_extension_namespace_values_opaque() {
    let root = plugin_root();
    let document = manifest(json!({
        "extensions": {
            "com.unknown.scalar": 42,
            "com.unknown.array": ["opaque", {"nested": false}]
        }
    }));

    let loaded = load(root.path(), &document)
        .unwrap_or_else(|error| panic!("unknown extension values should stay opaque: {error}"));

    assert_eq!(loaded.manifest.name, "manifest-regression");
}

#[test]
fn accepts_and_projects_valid_v1_metadata_fields() {
    let root = plugin_root();
    let document = manifest(json!({
        "version": "not-required-to-be-semver",
        "description": "Manifest schema regression fixture",
        "author": {
            "name": "Ada",
            "email": "not-required-to-be-an-email",
            "url": "not-required-to-be-a-url"
        },
        "homepage": "not-required-to-be-a-url",
        "repository": "not-required-to-be-a-url",
        "license": "not-required-to-be-an-spdx-id",
        "keywords": ["plugin", "schema"],
        "extensions": {"com.example.client": {"setting": true}}
    }));

    let loaded = load(root.path(), &document).expect("valid metadata should load");

    assert_eq!(
        loaded.manifest.version.as_deref(),
        Some("not-required-to-be-semver")
    );
    assert_eq!(loaded.manifest.keywords, ["plugin", "schema"]);
    assert_eq!(
        loaded
            .manifest
            .interface
            .as_ref()
            .and_then(|interface| interface.developer_name.as_deref()),
        Some("Ada")
    );
    assert_eq!(
        loaded
            .manifest
            .interface
            .as_ref()
            .and_then(|interface| interface.website_url.as_deref()),
        Some("not-required-to-be-a-url")
    );
}
