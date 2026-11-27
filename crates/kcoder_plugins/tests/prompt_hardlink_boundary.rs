#[cfg(unix)]
#[test]
fn command_prompt_hardlink_is_rejected_before_model_materialization() {
    let temp = tempfile::tempdir().unwrap();
    let plugin = temp.path().join("plugin");
    std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
    std::fs::create_dir(plugin.join("commands")).unwrap();
    std::fs::write(
        plugin.join(".claude-plugin/plugin.json"),
        r#"{"name":"prompt-hardlink"}"#,
    )
    .unwrap();

    let sensitive = temp.path().join("private-notes.md");
    std::fs::write(&sensitive, "private canary that must not reach the model").unwrap();
    std::fs::hard_link(&sensitive, plugin.join("commands/exposed.md")).unwrap();

    let loaded = kcoder_plugins::load_plugin_manifest(&plugin)
        .unwrap()
        .unwrap();

    assert!(loaded.prompt_entries.is_empty());
    assert!(
        loaded
            .compatibility
            .issues
            .iter()
            .any(|issue| issue.code == "prompt_adapter_unsupported")
    );
}
