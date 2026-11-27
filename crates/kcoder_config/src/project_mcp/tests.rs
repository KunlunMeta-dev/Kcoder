use super::*;
use crate::{PrivateDirectory, SettingsLoader};
use serde_json::json;
use std::path::{Path, PathBuf};
const SECRET: &str = "SYNTHETIC_USER_MCP_PRIVATE_NOT_PROJECT";
struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    project: PathBuf,
    executable: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let project = root.path().join("workspace");
        let executable = root.path().join("exe");
        PrivateDirectory::open_or_create(&profile).unwrap();
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&executable).unwrap();
        Self {
            _root: root,
            profile,
            project,
            executable,
        }
    }
    fn write(&self, path: &Path, value: &Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }
    fn loader(&self) -> SettingsLoader {
        SettingsLoader::new(&self.project)
            .with_config_dir(&self.profile)
            .with_executable_dir(&self.executable)
    }
    fn user(&self) {
        self.write(&self.profile.join("settings.json"),&json!({"mcp_servers":[{"name":"keep","command":"NEVER_EXECUTE","env":{"TOKEN":SECRET}},{"name":"omit","command":"NEVER_EXECUTE"}]}));
    }
}
#[test]
fn explicit_project_names_inherit_values_in_memory_without_copying_lower_documents() {
    let f = Fixture::new();
    f.user();
    let document = json!({"mcp_inherited_servers":["keep"],"mcp_servers":[{"name":"project","command":"NEVER_EXECUTE"}],"mcp_disabled_servers":["project"]});
    f.write(&f.project.join(".kcoder/settings.json"), &document);
    let original = std::fs::read(f.profile.join("settings.json")).unwrap();
    let loaded = f.loader().load().unwrap().settings;
    assert_eq!(
        loaded
            .mcp_servers
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["keep", "project"]
    );
    assert_eq!(
        loaded.mcp_servers[0].env.get("TOKEN").map(String::as_str),
        Some(SECRET)
    );
    assert!(loaded.mcp_inherited_servers.is_none());
    assert!(!loaded.mcp_server_enabled("project"));
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        original
    );
    assert!(
        !String::from_utf8(std::fs::read(f.project.join(".kcoder/settings.json")).unwrap())
            .unwrap()
            .contains(SECRET)
    );
}
#[test]
fn legacy_arrays_explicit_empty_and_later_replacement_do_not_restore_removed_servers() {
    let f = Fixture::new();
    f.user();
    for directive in [None, Some(json!([])), Some(json!(["keep"]))] {
        let mut project = json!({"mcp_servers":[]});
        if let Some(directive) = directive {
            project[PROJECT_MCP_INHERITED_SERVERS] = directive;
        }
        f.write(&f.project.join(".kcoder/settings.json"), &project);
        f.write(
            &f.project.join(".kcoder/settings.local.json"),
            &json!({"mcp_servers":[]}),
        );
        assert!(f.loader().load().unwrap().settings.mcp_servers.is_empty());
        std::fs::remove_file(f.project.join(".kcoder/settings.local.json")).unwrap();
        let loaded = f.loader().load().unwrap().settings;
        assert_eq!(
            loaded.mcp_servers.len(),
            usize::from(project[PROJECT_MCP_INHERITED_SERVERS] == json!(["keep"]))
        );
    }
}
#[test]
fn project_directive_rejects_other_scopes_duplicates_ambiguous_names_and_missing_arrays() {
    let f = Fixture::new();
    f.user();
    for path in [
        f.profile.join("settings.json"),
        f.executable.join("settings.json"),
        f.project.join(".kcoder/settings.local.json"),
    ] {
        let original = std::fs::read(&path).ok();
        f.write(&path, &json!({"mcp_inherited_servers":[],"mcp_servers":[]}));
        assert!(f.loader().load().is_err());
        if let Some(bytes) = original {
            std::fs::write(path, bytes).unwrap();
        } else {
            std::fs::remove_file(path).unwrap();
        }
    }
    let overlay = f._root.path().join("explicit-overlay.json");
    f.write(
        &overlay,
        &json!({"mcp_inherited_servers":[],"mcp_servers":[]}),
    );
    assert_eq!(
        f.loader()
            .with_overlay_files([overlay])
            .load()
            .err()
            .unwrap()
            .to_string(),
        "migration_project_mcp_directive_project_only"
    );
    for document in [
        json!({"mcp_inherited_servers":["keep","keep"],"mcp_servers":[]}),
        json!({"mcp_inherited_servers":["keep"]}),
        json!({"mcp_inherited_servers":["keep"],"mcp_servers":[{"name":"keep","command":"NEVER_EXECUTE"}]}),
        json!({"mcp_inherited_servers":["bad\nname"],"mcp_servers":[]}),
    ] {
        f.write(&f.project.join(".kcoder/settings.json"), &document);
        assert!(f.loader().load().is_err());
    }
    f.write(
        &f.project.join(".kcoder/settings.json"),
        &json!({
            "mcp_inherited_servers":(0..1025).map(|i| format!("server-{i}")).collect::<Vec<_>>(),
            "mcp_servers":[]
        }),
    );
    assert!(f.loader().load().is_err());
    assert!(
        crate::validate_and_resolve_settings_document(
            &json!({"mcp_inherited_servers":[],"mcp_servers":[]})
        )
        .is_err()
    );
}
#[test]
fn lower_deletion_never_resurrects_a_name_and_revisions_bind_changes_without_secret_previews() {
    let f = Fixture::new();
    f.user();
    let before = ProjectMcpCatalog::from_settings(&f.loader().load().unwrap().settings).unwrap();
    let choice = before.select(vec!["keep".into()]).unwrap();
    assert!(!serde_json::to_string(&before).unwrap().contains(SECRET));
    f.write(
        &f.project.join(".kcoder/settings.json"),
        &json!({"mcp_inherited_servers":["keep"],"mcp_servers":[]}),
    );
    f.write(&f.profile.join("settings.json"), &json!({"mcp_servers":[]}));
    let loaded = f.loader().load().unwrap().settings;
    assert!(loaded.mcp_servers.is_empty());
    assert!(
        choice
            .verify(&ProjectMcpCatalog::from_settings(&loaded).unwrap())
            .is_err()
    );
}

#[test]
fn project_only_directive_never_publishes_into_a_user_or_local_settings_file() {
    use crate::{
        ConfigScope, ProfileSettingsFile, update_scope, update_settings_file, write_scope,
        write_scope_if_missing,
    };
    let f = Fixture::new();
    f.user();
    let original = std::fs::read(f.profile.join("settings.json")).unwrap();
    let paths = f.loader().paths().unwrap();
    let invalid = json!({"mcp_inherited_servers":[],"mcp_servers":[]});
    assert!(write_scope(&paths, ConfigScope::User, &invalid).is_err());
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        original
    );
    assert!(
        update_scope(&paths, ConfigScope::User, |document| {
            document[PROJECT_MCP_INHERITED_SERVERS] = json!([]);
            Ok(())
        })
        .is_err()
    );
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        original
    );
    assert!(
        update_settings_file(&paths.user_settings, |document| {
            document[PROJECT_MCP_INHERITED_SERVERS] = json!([]);
            Ok(())
        })
        .is_err()
    );
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        original
    );
    assert!(write_scope_if_missing(&paths, ConfigScope::Local, &invalid).is_err());
    assert!(!paths.local_settings.exists());
    let settings =
        ProfileSettingsFile::new(PrivateDirectory::open_existing(&f.profile).unwrap()).unwrap();
    assert!(
        settings
            .update(|document| {
                document[PROJECT_MCP_INHERITED_SERVERS] = json!([]);
                Ok(())
            })
            .is_err()
    );
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        original
    );
    write_scope(&paths, ConfigScope::Project, &invalid).unwrap();
    assert_eq!(
        crate::read_settings_file(&paths.project_settings).unwrap()[PROJECT_MCP_INHERITED_SERVERS],
        json!([])
    );
}
