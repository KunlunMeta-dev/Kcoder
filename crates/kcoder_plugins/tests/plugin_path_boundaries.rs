use kcoder_plugins::load_plugin_manifest;
use std::path::Path;

fn write_manifest(root: &Path, contents: &str) {
    let manifest = root.join(".codex-plugin/plugin.json");
    std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
    std::fs::write(manifest, contents).unwrap();
}

#[test]
fn missing_schema_remains_a_legacy_manifest() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("plugin.json"), r#"{"name":"legacy"}"#).unwrap();

    let loaded = load_plugin_manifest(temp.path()).unwrap().unwrap();
    assert_eq!(loaded.manifest.name, "legacy");
}

#[test]
fn present_non_string_schema_is_rejected_instead_of_routed_to_legacy() {
    for schema in ["null", "1", "{}", "[]"] {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("plugin.json"),
            format!(r#"{{"$schema":{schema},"name":"legacy-fallback"}}"#),
        )
        .unwrap();

        let error = load_plugin_manifest(temp.path()).unwrap_err();
        assert_eq!(error.diagnostic_code(), "invalid_manifest", "{schema}");
        assert!(error.to_string().contains("`$schema` must be a string"));
    }
}

#[cfg(unix)]
#[test]
fn manifest_parent_symlink_is_rejected_before_manifest_parsing() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("outside");
    write_manifest(&outside, "not-json");
    let plugin_root = temp.path().join("plugin");
    std::fs::create_dir(&plugin_root).unwrap();
    symlink(
        outside.join(".codex-plugin"),
        plugin_root.join(".codex-plugin"),
    )
    .unwrap();

    let error = load_plugin_manifest(&plugin_root).unwrap_err();
    assert_eq!(error.diagnostic_code(), "unsafe_resource_path");
}

#[cfg(unix)]
#[test]
fn plugin_root_symlink_is_rejected() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("outside");
    write_manifest(&outside, r#"{"name":"outside"}"#);
    let plugin_root = temp.path().join("plugin-link");
    symlink(&outside, &plugin_root).unwrap();

    let error = load_plugin_manifest(&plugin_root).unwrap_err();
    assert_eq!(error.diagnostic_code(), "unsafe_resource_path");
}

#[cfg(unix)]
#[test]
fn symlinked_root_parent_is_resolved_but_manifest_path_uses_the_real_root() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let real_parent = temp.path().join("real-parent");
    let real_root = real_parent.join("plugin");
    write_manifest(&real_root, r#"{"name":"parent-alias"}"#);
    let parent_alias = temp.path().join("parent-alias");
    symlink(&real_parent, &parent_alias).unwrap();

    let loaded = load_plugin_manifest(&parent_alias.join("plugin"))
        .unwrap()
        .unwrap();
    assert_eq!(
        loaded.selected_manifest_path,
        real_root.join(".codex-plugin/plugin.json")
    );
}

#[test]
fn manifest_hard_link_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("outside.json");
    std::fs::write(&outside, r#"{"name":"outside"}"#).unwrap();
    let plugin_root = temp.path().join("plugin");
    let manifest = plugin_root.join(".codex-plugin/plugin.json");
    std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
    std::fs::hard_link(&outside, &manifest).unwrap();

    let error = load_plugin_manifest(&plugin_root).unwrap_err();
    assert_eq!(error.diagnostic_code(), "unsafe_resource_path");
}

#[cfg(unix)]
#[test]
fn declared_resource_parent_symlink_is_rejected() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let plugin_root = temp.path().join("plugin");
    write_manifest(
        &plugin_root,
        r#"{"name":"resource-link","skills":"linked/skill.md"}"#,
    );
    let outside = temp.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("skill.md"), "secret skill content").unwrap();
    symlink(&outside, plugin_root.join("linked")).unwrap();

    let error = load_plugin_manifest(&plugin_root).unwrap_err();
    assert_eq!(error.diagnostic_code(), "unsafe_resource_path");
}

#[test]
fn non_directory_plugin_root_is_an_error_and_missing_root_stays_empty() {
    let temp = tempfile::tempdir().unwrap();
    let file_root = temp.path().join("not-a-directory");
    std::fs::write(&file_root, "ordinary file").unwrap();

    let error = load_plugin_manifest(&file_root).unwrap_err();
    assert_eq!(error.diagnostic_code(), "unsafe_resource_path");
    assert!(
        load_plugin_manifest(&temp.path().join("missing"))
            .unwrap()
            .is_none()
    );
}

#[cfg(unix)]
#[test]
fn missing_root_under_a_symlinked_parent_stays_missing_without_creation() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let real_parent = temp.path().join("real-parent");
    std::fs::create_dir(&real_parent).unwrap();
    let parent_alias = temp.path().join("parent-alias");
    symlink(&real_parent, &parent_alias).unwrap();
    let root = parent_alias.join("future-plugin-data");

    assert!(load_plugin_manifest(&root).unwrap().is_none());
    assert!(!real_parent.join("future-plugin-data").exists());
}
