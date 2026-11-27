//! Source-format witnesses and owned direct consumers do not execute vendor programs.
use kcoder_config::PrivateDirectory;
use kcoder_migration::{
    discovery::{DiscoveryRoots, SourceRegistry},
    plugin_migration::discover,
    project_migration::{ProjectReadCancellation, ProjectReadLimits, read_codex_registry},
};
use kcoder_plugins::PluginCancellationToken;
use kcoder_types::migration::MigrationSourceKind as Kind;
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, fs, path::Path};

const FIXTURES: &str = "tests/fixtures/component-formats";
fn fixture(name: &str) -> Vec<u8> {
    fs::read(
        std::path::PathBuf::from(
            std::env::var_os("KCODER_WORKSPACE_ROOT").expect("current workspace root"),
        )
        .join("crates/kcoder_migration")
        .join(FIXTURES)
        .join(name),
    )
    .unwrap()
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn component_roster_binds_fixed_inputs_and_existing_direct_consumers_without_vendor_certification()
{
    let root = std::path::PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT").expect("current workspace root"),
    )
    .join("crates/kcoder_migration");
    let matrix: Value = serde_json::from_str(include_str!(
        "../fixtures/component-format-support-matrix.json"
    ))
    .unwrap();
    assert_eq!(matrix["nativeVendorAcceptance"], false);
    assert_eq!(
        matrix["historyMatrix"],
        "fixtures/versioned-history-support-matrix.json"
    );
    let witnesses = matrix["witnesses"].as_array().unwrap();
    let mut ids = std::collections::BTreeSet::new();
    for witness in witnesses {
        assert!(ids.insert(witness["id"].as_str().unwrap()));
        assert!(witness["url"].as_str().unwrap().starts_with("https://"));
        assert_eq!(witness["sha256"].as_str().unwrap().len(), 64);
        assert!(witness["capturedAtUtc"].as_str().is_some());
    }
    let rows = matrix["entries"].as_array().unwrap();
    assert!(rows.len() >= 14);
    for row in rows {
        let file = row["fixture"].as_str().unwrap();
        assert!(!file.starts_with('/') && !file.split('/').any(|part| part == ".."));
        assert_eq!(digest(&fs::read(root.join(file)).unwrap()), row["sha256"]);
        let consumer = row["consumer"].as_str().unwrap();
        let source =
            fs::read_to_string(root.join(row["consumerSource"].as_str().unwrap())).unwrap();
        assert!(source.contains(&format!("fn {consumer}(")));
        for reference in row["references"].as_array().unwrap() {
            assert!(ids.contains(reference.as_str().unwrap()));
        }
        assert!(row["productVersion"].is_null() || row["productVersion"].is_string());
        assert!(
            row["boundary"]
                .as_str()
                .is_some_and(|text| !text.is_empty())
        );
    }
}

fn profile_registry(path: &Path) -> SourceRegistry {
    SourceRegistry::new(DiscoveryRoots {
        home: path.into(),
        claude_config_dir: None,
        codex_home: Some(path.into()),
        project: None,
    })
}

#[test]
fn fixed_current_and_legacy_profile_shapes_remain_distinct_and_unknown_table_is_not_a_profile() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let base = fixture("codex-profile-base.toml");
    fs::write(root.join("config.toml"), &base).unwrap();
    fs::write(
        root.join("review.config.toml"),
        fixture("review.config.toml"),
    )
    .unwrap();
    let mut registry = profile_registry(root);
    let (sources, problems) = registry.discover_with_assets(&[Kind::Codex], false, false);
    assert!(problems.is_empty());
    let named = sources
        .iter()
        .find(|row| row.display_name.ends_with("review.config.toml"))
        .unwrap();
    let binding = registry.selected(&named.source_id).unwrap();
    let current_binding_sha = digest(&serde_json::to_vec(&binding).unwrap());
    let inventory = binding.inventory().unwrap();
    assert_eq!(inventory.adapter_revision, "codex-profile-file/v1");
    assert_eq!(
        inventory
            .items
            .iter()
            .find_map(|item| item.provider.as_ref())
            .unwrap()
            .model
            .as_deref(),
        Some("named-model")
    );
    assert_eq!(fs::read(root.join("config.toml")).unwrap(), base);

    fs::write(
        root.join("config.toml"),
        fixture("codex-profile-legacy.toml"),
    )
    .unwrap();
    fs::remove_file(root.join("review.config.toml")).unwrap();
    let (sources, problems) = registry.discover_with_assets(&[Kind::Codex], false, false);
    assert!(problems.is_empty());
    let legacy = sources
        .iter()
        .find_map(|source| {
            let selected = registry.selected(&source.source_id).unwrap();
            (selected.inventory().unwrap().adapter_revision == "codex-profile-table/v1")
                .then_some(selected)
        })
        .unwrap();
    assert_ne!(
        current_binding_sha,
        digest(&serde_json::to_vec(&legacy).unwrap())
    );
    assert_eq!(
        legacy
            .inventory()
            .unwrap()
            .items
            .iter()
            .find_map(|item| item.provider.as_ref())
            .unwrap()
            .model
            .as_deref(),
        Some("legacy-model")
    );

    fs::write(
        root.join("config.toml"),
        fixture("codex-profile-unknown.toml"),
    )
    .unwrap();
    let (sources, problems) = registry.discover_with_assets(&[Kind::Codex], false, false);
    assert!(!problems.is_empty());
    assert!(sources.iter().all(|source| {
        registry
            .selected(&source.source_id)
            .unwrap()
            .inventory()
            .unwrap()
            .adapter_revision
            != "codex-profile-table/v1"
    }));
}

#[test]
fn lower_and_future_plugin_index_numbers_are_explicitly_unsupported_without_installing_anything() {
    let temp = tempfile::tempdir().unwrap();
    let directory = PrivateDirectory::open_or_create(temp.path()).unwrap();
    fs::create_dir(temp.path().join("plugins")).unwrap();
    let index = temp.path().join("plugins/installed_plugins.json");
    for name in [
        "claude-plugin-index-lower-number.json",
        "claude-plugin-index-unknown.json",
    ] {
        let input = fixture(name);
        fs::write(&index, &input).unwrap();
        let result = discover(
            temp.path(),
            Kind::ClaudeCode,
            &PluginCancellationToken::default(),
        );
        assert!(
            matches!(result, Err(ref error) if error.to_string() == "plugin_migration_unsupported_index")
        );
        assert_eq!(fs::read(&index).unwrap(), input);
        assert_eq!(
            fs::read_dir(temp.path().join("plugins")).unwrap().count(),
            1
        );
        directory.verify_private_directory().unwrap();
    }
}

#[test]
fn observed_project_tables_before_and_after_recency_index_preserve_projection_and_unknown_schema_fails()
 {
    let temp = tempfile::tempdir().unwrap();
    let source = PrivateDirectory::open_or_create(temp.path()).unwrap();
    let path = temp.path().join("state_5.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(std::str::from_utf8(&fixture("codex-project-tables.sql")).unwrap())
        .unwrap();
    drop(db);
    let read = || {
        read_codex_registry(
            &source,
            OsStr::new("state_5.sqlite"),
            &ProjectReadCancellation::default(),
            ProjectReadLimits::default(),
        )
    };
    let before = fs::read(&path).unwrap();
    let old = read().unwrap();
    assert_eq!(old.projects.len(), 1);
    assert_eq!(old.proof.source_write_attempts, 0);
    assert_eq!(before, fs::read(&path).unwrap());
    let db = Connection::open(&path).unwrap();
    db.execute_batch(std::str::from_utf8(&fixture("codex-project-recency.sql")).unwrap())
        .unwrap();
    drop(db);
    let before = fs::read(&path).unwrap();
    let current = read().unwrap();
    assert_eq!(
        serde_json::to_value(&old.projects).unwrap(),
        serde_json::to_value(&current.projects).unwrap()
    );
    assert_eq!(current.proof.source_write_attempts, 0);
    assert_eq!(before, fs::read(&path).unwrap());
    fs::remove_file(&path).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch(std::str::from_utf8(&fixture("codex-project-unknown.sql")).unwrap())
        .unwrap();
    drop(db);
    let before = fs::read(&path).unwrap();
    assert!(
        matches!(read(), Err(ref error) if error.to_string() == "migration_project_source_schema_unsupported")
    );
    assert_eq!(before, fs::read(&path).unwrap());
    assert!(!temp.path().join("state_5.sqlite-wal").exists());
    assert!(!temp.path().join("state_5.sqlite-shm").exists());
}
