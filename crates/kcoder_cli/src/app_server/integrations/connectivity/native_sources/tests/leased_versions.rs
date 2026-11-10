use super::*;

#[test]
fn unproved_old_plugin_configuration_cannot_reuse_a_retained_native_ref() -> Result<()> {
    let (temp, context) = super::super::super::lease::tests::fixture()?;
    let source = temp.path().join("owned-plugin-source");
    std::fs::create_dir_all(source.join(".codex-plugin"))?;
    let write = |version: &str, payload: &str| -> Result<()> {
        std::fs::write(
            source.join(".codex-plugin/plugin.json"),
            json!({"name":"lease-source","version":version}).to_string(),
        )?;
        std::fs::write(source.join("payload.txt"), payload)?;
        Ok(())
    };
    write("1.0.0", "original-version")?;
    let store = kcoder_plugins::PluginStore::open(&context.profile_path()?.join("plugin_store"))?;
    let first = store.install_local(&source, "owned-native-lease")?;
    let (_, held_original_lease) = store.snapshot_with_leases()?;
    assert_eq!(held_original_lease.len(), 1);
    let plugin = first.plugin_id.to_string();
    let settings = Settings::default();
    let mut first_config = config("owned-lease-server");
    first_config
        .args
        .push(first.root(store.root()).to_string_lossy().into_owned());
    let old_facts = vec![fact(&context, &settings, &first_config, Some(&plugin))?];
    let catalog = NativeConnectivitySourceCatalog::initialize(&context, "actual-old-lease-opt-in")?;
    catalog.register(&context, "actual-version-one", &old_facts)?;
    let original = catalog
        .inventory(
            &context,
            &old_facts,
            &registry(&first_config.name, Some(&plugin)),
        )?
        .task_sources
        .remove(0);
    let original_choice = choice(&original);
    assert!(
        catalog
            .resolve_choice(&context, &original_choice, &old_facts)
            .is_ok()
    );
    write("2.0.0", "current-version")?;
    let second = store.install_local(&source, "owned-native-lease")?;
    assert_ne!(first.operation_id, second.operation_id);
    assert_eq!(
        std::fs::read_to_string(first.root(store.root()).join("payload.txt"))?,
        "original-version"
    );
    let mut current_config = first_config.clone();
    current_config.args = vec![second.root(store.root()).to_string_lossy().into_owned()];
    let current = vec![fact(&context, &settings, &current_config, Some(&plugin))?];
    catalog.register(&context, "actual-version-two", &current)?;
    let current_choice = choice(
        &catalog
            .inventory(
                &context,
                &current,
                &registry(&current_config.name, Some(&plugin)),
            )?
            .task_sources
            .remove(0),
    );
    assert_ne!(current_choice.source_ref, original_choice.source_ref);
    let original_resolution = catalog.resolve_choice(&context, &original_choice, &old_facts);
    assert!(
        original_resolution.is_err(),
        "A retained file and old configuration cannot replace an actual native Tool/origin/Engine lease witness"
    );
    assert_eq!(held_original_lease.len(), 1);
    Ok(())
}
