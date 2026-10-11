use kcoder_plugins::{PluginManager, PluginSource, load_marketplace_manifest};
use std::path::PathBuf;
use tempfile::TempDir;

fn fixture_root() -> PathBuf {
    PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT").expect("Cargo 应提供当前 KCoder 工作区根目录"),
    )
    .join("crates/kcoder_plugins/tests/fixtures/marketplaces/local")
}

#[test]
fn public_marketplace_loader_resolves_local_sources_and_stable_ids() {
    let marketplace = load_marketplace_manifest(&fixture_root()).unwrap();

    assert_eq!(marketplace.name, "fixture-market");
    assert_eq!(marketplace.plugins.len(), 2);
    assert_eq!(
        marketplace.plugins[0].plugin_id.to_string(),
        "fixture-one@fixture-market"
    );
    assert!(marketplace.plugins.iter().all(|entry| {
        matches!(&entry.source, PluginSource::Local { path } if path.is_absolute())
    }));
}

#[test]
fn configured_marketplace_installs_and_uninstalls_through_plugin_manager() {
    let temp = TempDir::new().unwrap();
    let manager = PluginManager::open(&temp.path().join("plugin_store")).unwrap();
    manager
        .marketplace_add("fixture-market", &fixture_root())
        .unwrap();

    let installed = manager
        .install_from_marketplace(temp.path(), true, "fixture-market", "fixture-one")
        .unwrap();

    assert_eq!(
        installed.plugin_id.to_string(),
        "fixture-one@fixture-market"
    );
    assert!(installed.root(manager.store().root()).is_dir());
    assert!(manager.uninstall(&installed.plugin_id, true).unwrap());
    assert!(
        manager
            .store()
            .read(&installed.plugin_id)
            .unwrap()
            .is_none()
    );
}
