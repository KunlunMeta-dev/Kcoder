use super::*;
use std::fs;

struct Fixture {
    _root: tempfile::TempDir,
    user: PathBuf,
    project: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let user = root.path().join("user");
        let project = root.path().join("project");
        fs::create_dir(&user).unwrap();
        fs::create_dir(&project).unwrap();
        fs::create_dir(project.join(".claude")).unwrap();
        Self {
            _root: root,
            user,
            project,
        }
    }
    fn write(&self, scope: ConfigurationLayerScope, value: serde_json::Value) {
        let path = match scope {
            ConfigurationLayerScope::User => self.user.join("settings.json"),
            ConfigurationLayerScope::Project => self.project.join(".claude/settings.json"),
            ConfigurationLayerScope::Local => self.project.join(".claude/settings.local.json"),
        };
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    fn capture(&self) -> ConfigurationLayersBinding {
        ConfigurationLayersBinding::capture_claude(&self.user, Some(&self.project))
            .unwrap()
            .unwrap()
    }
}

#[test]
fn a_serialized_layer_report_cannot_redirect_the_selected_project_mapping() {
    let f = Fixture::new();
    f.write(
        ConfigurationLayerScope::User,
        serde_json::json!({"model":"source"}),
    );
    let mut stored = serde_json::to_value(f.capture()).unwrap();
    stored["project"] = serde_json::json!(f.user);
    let changed: ConfigurationLayersBinding = serde_json::from_value(stored).unwrap();
    assert_eq!(
        changed.report().unwrap_err().to_string(),
        "migration_invalid_source_binding"
    );
}
const USER_KEY: &str = "SYNTHETIC_LOWER_LAYER_PRIVATE_CANARY";
const LOCAL_KEY: &str = "SYNTHETIC_WINNING_LAYER_PRIVATE_CANARY";

#[test]
fn known_scalars_and_environment_fields_have_distinct_winning_layers_and_no_synthetic_api_key() {
    use ConfigurationLayerScope::*;
    let f = Fixture::new();
    f.write(User, serde_json::json!({"model":"user-model","env":{"ANTHROPIC_BASE_URL":"https://layered.example.invalid","ANTHROPIC_API_KEY":USER_KEY}}));
    f.write(Project, serde_json::json!({"model":"project-model"}));
    f.write(
        Local,
        serde_json::json!({"model":"local-model","env":{"ANTHROPIC_API_KEY":LOCAL_KEY}}),
    );
    let binding = f.capture();
    let source = binding.read().unwrap();
    let report = binding.report().unwrap();
    assert!(!source.text().contains(USER_KEY) && !source.text().contains(LOCAL_KEY));
    assert_eq!(
        binding
            .private_field("/env/ANTHROPIC_API_KEY")
            .unwrap()
            .as_str(),
        LOCAL_KEY
    );
    assert!(binding.private_field("/env/UNAUTHORIZED").is_err());
    let inventory = binding.inventory().unwrap();
    let provider = inventory.items[0].provider.as_ref().unwrap();
    assert_eq!(provider.model.as_deref(), Some("local-model"));
    assert_eq!(
        provider.endpoint.as_deref(),
        Some("https://layered.example.invalid")
    );
    for (field, scope) in [
        ("/model", Local),
        ("/env/ANTHROPIC_API_KEY", Local),
        ("/env/ANTHROPIC_BASE_URL", User),
    ] {
        assert_eq!(
            report
                .fields
                .iter()
                .find(|row| row.field.as_deref() == Some(field))
                .unwrap()
                .scopes,
            vec![scope]
        );
    }
    let public =
        serde_json::to_string(&report).unwrap() + &serde_json::to_string(&inventory).unwrap();
    assert!(!public.contains(USER_KEY) && !public.contains(LOCAL_KEY));
    assert!(!public.contains(f.user.to_str().unwrap()));
}

#[test]
fn missing_layers_and_superseded_secret_changes_invalidate_the_entire_snapshot() {
    use ConfigurationLayerScope::*;
    let f = Fixture::new();
    f.write(
        User,
        serde_json::json!({"model":"source","env":{"ANTHROPIC_API_KEY":USER_KEY}}),
    );
    let before = f.capture();
    assert_eq!(
        before
            .report()
            .unwrap()
            .layers
            .iter()
            .filter(|row| row.present)
            .count(),
        1
    );
    f.write(
        Local,
        serde_json::json!({"env":{"ANTHROPIC_API_KEY":LOCAL_KEY}}),
    );
    assert_eq!(
        before.read().unwrap_err().to_string(),
        "migration_source_changed"
    );
    let binding = f.capture();
    f.write(User, serde_json::json!({"model":"source","env":{"ANTHROPIC_API_KEY":"SYNTHETIC_CHANGED_UNUSED_SECRET"}}));
    assert_eq!(
        binding
            .private_field("/env/ANTHROPIC_API_KEY")
            .unwrap_err()
            .to_string(),
        "migration_source_changed"
    );
}

#[test]
fn missing_configuration_directory_is_bound_without_creating_it() {
    use ConfigurationLayerScope::*;
    let f = Fixture::new();
    fs::remove_dir(f.project.join(".claude")).unwrap();
    f.write(User, serde_json::json!({"model":"source"}));
    let binding = f.capture();
    assert!(!f.project.join(".claude").exists());
    fs::create_dir(f.project.join(".claude")).unwrap();
    assert_eq!(
        binding.read().unwrap_err().to_string(),
        "migration_source_changed"
    );
}

#[test]
fn an_empty_higher_environment_preserves_inherited_field_provenance() {
    use ConfigurationLayerScope::*;
    let f = Fixture::new();
    f.write(
        User,
        serde_json::json!({"model":"source","env":{"ANTHROPIC_API_KEY":USER_KEY}}),
    );
    f.write(Local, serde_json::json!({"env":{}}));
    let binding = f.capture();
    assert_eq!(
        binding
            .private_field("/env/ANTHROPIC_API_KEY")
            .unwrap()
            .as_str(),
        USER_KEY
    );
    assert_eq!(
        binding
            .report()
            .unwrap()
            .fields
            .iter()
            .find(|row| row.field.as_deref() == Some("/env/ANTHROPIC_API_KEY"))
            .unwrap()
            .scopes,
        vec![User]
    );
}

#[test]
fn explicit_refresh_can_add_an_authorized_missing_layer_but_cannot_follow_replaced_roots() {
    use ConfigurationLayerScope::*;
    let f = Fixture::new();
    f.write(User, serde_json::json!({"model":"source"}));
    let binding = f.capture();
    f.write(Local, serde_json::json!({"model":"new-local"}));
    let updated = binding.refreshed().unwrap();
    assert_eq!(
        updated.inventory().unwrap().items[0]
            .provider
            .as_ref()
            .unwrap()
            .model
            .as_deref(),
        Some("new-local")
    );
    fs::rename(&f.user, f._root.path().join("withheld-user")).unwrap();
    fs::create_dir(&f.user).unwrap();
    f.write(User, serde_json::json!({"model":"new-user"}));
    assert_eq!(
        binding.refreshed().unwrap_err().to_string(),
        "migration_source_changed"
    );
}

#[test]
fn overwritten_secrets_cannot_be_laundered_into_model_or_public_field_names() {
    use ConfigurationLayerScope::*;
    let f = Fixture::new();
    f.write(
        User,
        serde_json::json!({"env":{"ANTHROPIC_API_KEY":USER_KEY}}),
    );
    f.write(
        Local,
        serde_json::json!({"model":USER_KEY, USER_KEY:{"unrecognized":true}}),
    );
    let binding = f.capture();
    let inventory = binding.inventory().unwrap();
    let report = binding.report().unwrap();
    assert!(
        inventory.items[0]
            .provider
            .as_ref()
            .unwrap()
            .model
            .is_none()
    );
    assert!(
        report
            .fields
            .iter()
            .any(|field| field.field.is_none() && !field.supported)
    );
    assert!(
        !serde_json::to_string(&inventory)
            .unwrap()
            .contains(USER_KEY)
    );
    assert!(!serde_json::to_string(&report).unwrap().contains(USER_KEY));
    assert!(
        inventory.items[0]
            .preview
            .issues
            .iter()
            .any(|issue| issue.blocks_import())
    );
}

#[test]
fn current_settings_snapshot_rejects_jsonc_and_bounded_depth_without_echoing_the_payload() {
    let f = Fixture::new();
    fs::write(
        f.user.join("settings.json"),
        format!("// {USER_KEY}\n{{\"model\":\"x\",}}"),
    )
    .unwrap();
    let error = ConfigurationLayersBinding::capture_claude(&f.user, Some(&f.project)).unwrap_err();
    assert_eq!(error.to_string(), "migration_invalid_source_format");
    assert!(!error.to_string().contains(USER_KEY));
    let deep = format!("{{\"unknown\":{}0{}}}", "[".repeat(66), "]".repeat(66));
    fs::write(f.user.join("settings.json"), deep).unwrap();
    assert_eq!(
        ConfigurationLayersBinding::capture_claude(&f.user, Some(&f.project))
            .unwrap_err()
            .to_string(),
        "migration_source_budget_exceeded"
    );
}

#[test]
fn settings_layers_do_not_merge_separate_mcp_namespaces_or_allow_their_private_values() {
    use ConfigurationLayerScope::*;
    let f = Fixture::new();
    f.write(User, serde_json::json!({"model":"source", "mcpServers":{"lower":{"command":"must-not-run","env":{"TOKEN":USER_KEY}}}}));
    f.write(Local, serde_json::json!({"mcpServers":{"higher":{"command":"must-not-run","env":{"TOKEN":LOCAL_KEY}}}}));
    let binding = f.capture();
    assert!(!binding.read().unwrap().text().contains("mcpServers"));
    let report = binding.report().unwrap();
    let field = report
        .fields
        .iter()
        .find(|field| field.field.as_deref() == Some("/mcpServers"))
        .unwrap();
    assert_eq!(field.scopes, vec![User, Local]);
    assert!(!field.supported);
    let inventory = binding.inventory().unwrap();
    assert!(inventory.items.iter().all(|item| item.mcp.is_none()));
    assert!(inventory.items.iter().any(|item| {
        item.preview.category == kcoder_types::migration::MigrationCategory::Mcp
            && item
                .preview
                .issues
                .iter()
                .any(|issue| issue.blocks_import())
    }));
}

#[test]
#[cfg(unix)]
fn replacement_links_and_directory_changes_do_not_grant_a_new_source() {
    use ConfigurationLayerScope::*;
    let f = Fixture::new();
    f.write(User, serde_json::json!({"model":"source"}));
    let binding = f.capture();
    fs::rename(f.user.join("settings.json"), f.user.join("old.json")).unwrap();
    fs::write(f.user.join("settings.json"), "{\"model\":\"source\"}").unwrap();
    assert!(binding.read().is_err());
    fs::remove_file(f.user.join("settings.json")).unwrap();
    std::os::unix::fs::symlink(f.user.join("old.json"), f.user.join("settings.json")).unwrap();
    assert!(f.capture_result().is_err());
}
impl Fixture {
    fn capture_result(&self) -> Result<Option<ConfigurationLayersBinding>> {
        ConfigurationLayersBinding::capture_claude(&self.user, Some(&self.project))
    }
}

#[test]
fn saved_report_is_safe_and_survives_source_removal_without_a_reinterpretation() {
    let f = Fixture::new();
    f.write(ConfigurationLayerScope::User, serde_json::json!({"model":"source","env":{"ANTHROPIC_API_KEY":"PRIVATE_CANARY"},"PRIVATE_KEY_NAME_CANARY":true}));
    let binding = f.capture();
    let report = binding.snapshot_report().unwrap().unwrap();
    let text = serde_json::to_string(&report).unwrap();
    assert!(!text.contains("PRIVATE_CANARY"));
    assert!(!text.contains("PRIVATE_KEY_NAME_CANARY"));
    fs::remove_file(f.user.join("settings.json")).unwrap();
    assert!(binding.read().is_err());
    assert_eq!(binding.snapshot_report().unwrap().unwrap(), report);
}

#[test]
fn legacy_binding_omits_saved_report_and_keeps_its_original_serialized_identity() {
    let f = Fixture::new();
    f.write(
        ConfigurationLayerScope::User,
        serde_json::json!({"model":"source"}),
    );
    let mut old = serde_json::to_value(f.capture()).unwrap();
    old.as_object_mut().unwrap().remove("snapshotReport");
    let binding: ConfigurationLayersBinding = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(serde_json::to_value(&binding).unwrap(), old);
    assert_eq!(binding.snapshot_report().unwrap(), None);
    assert!(binding.report().is_ok());
}

#[test]
fn persisted_report_cannot_export_unknown_names_or_forged_authority() {
    let f = Fixture::new();
    f.write(
        ConfigurationLayerScope::User,
        serde_json::json!({"model":"source"}),
    );
    let original = serde_json::to_value(f.capture()).unwrap();
    for (pointer, value) in [
        (
            "/snapshotReport/fields/0/field",
            serde_json::json!("SECRET_KEY_NAME"),
        ),
        (
            "/snapshotReport/unobserved/0",
            serde_json::json!("secret-process-argument"),
        ),
        (
            "/snapshotReport/fields/0/scopes",
            serde_json::json!(["local"]),
        ),
    ] {
        let mut altered = original.clone();
        *altered.pointer_mut(pointer).unwrap() = value;
        let binding: ConfigurationLayersBinding = serde_json::from_value(altered).unwrap();
        assert_eq!(
            binding.snapshot_report().unwrap_err().to_string(),
            "migration_invalid_source_binding"
        );
    }
}
