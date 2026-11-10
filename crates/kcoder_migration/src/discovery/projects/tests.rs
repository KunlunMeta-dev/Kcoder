use super::*;
#[test]
fn project_pages_are_catalog_bound_metadata_only_and_reject_changed_source_inputs() {
    let root = tempfile::tempdir().unwrap();
    let directory = PrivateDirectory::open_existing(root.path()).unwrap();
    let rows = (0..13)
        .map(|i| {
            (
                format!("/not-opened/{i:02}"),
                serde_json::json!({"secret":"PRIVATE_SOURCE_VALUE","hasTrustDialogAccepted":true}),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    directory
        .atomic_replace(
            OsStr::new(".claude.json"),
            serde_json::json!({"oauthAccount":{"token":"PRIVATE_TOKEN"},"projects":rows})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: root.path().into(),
        claude_config_dir: None,
        codex_home: None,
        project: None,
    });
    let cancel = ProjectReadCancellation::default();
    let first = registry
        .discover_projects(MigrationSourceKind::ClaudeCode, &cancel)
        .unwrap();
    assert_eq!(first.items.len(), 10);
    assert!(first.known_rows_complete);
    assert_eq!(first.next_page, Some(1));
    assert_eq!(
        registry
            .projects_page(&first.catalog_id, 1, &cancel)
            .unwrap()
            .items
            .len(),
        3
    );
    let text = serde_json::to_string(&first).unwrap();
    assert!(!text.contains("PRIVATE_"));
    assert!(!text.contains("hasTrustDialogAccepted"));
    assert!(
        first
            .items
            .iter()
            .all(|row| row.original_project_id.is_none())
    );
    let another = registry
        .discover_projects(MigrationSourceKind::ClaudeCode, &cancel)
        .unwrap();
    assert!(
        registry
            .selected_project(&another.catalog_id, &first.items[0].source_handle, &cancel)
            .is_err()
    );
    let selected = registry
        .selected_project(&first.catalog_id, &first.items[0].source_handle, &cancel)
        .unwrap();
    let roots = registry
        .project_source_roots(&first.catalog_id, &first.items[0].source_handle, 0, &cancel)
        .unwrap();
    assert_eq!(
        roots.roots[0].source_root_id,
        selected.source_root_id(0).unwrap()
    );
    assert_eq!(roots.roots[0].original_path, selected.record().roots[0]);
    directory
        .atomic_replace(
            OsStr::new(".claude.json"),
            b"{\"projects\":{\"/changed\":{}}}",
        )
        .unwrap();
    assert!(
        registry
            .projects_page(&first.catalog_id, 0, &cancel)
            .is_err()
    );
    assert!(
        registry
            .selected_project(&first.catalog_id, &first.items[0].source_handle, &cancel)
            .is_err()
    );
}
#[test]
fn selecting_the_product_subdirectory_never_grants_its_parent_registry() {
    let home = tempfile::tempdir().unwrap();
    let directory = PrivateDirectory::open_existing(home.path()).unwrap();
    directory
        .atomic_replace(
            OsStr::new(".claude.json"),
            b"{\"projects\":{\"/parent-must-not-be-read\":{}}}",
        )
        .unwrap();
    directory
        .create_private_child(OsStr::new(".claude"))
        .unwrap();
    let product = home.path().join(".claude");
    let mut selected =
        SourceRegistry::from_selected_product_directory(&product, MigrationSourceKind::ClaudeCode)
            .unwrap();
    let page = selected
        .discover_projects(MigrationSourceKind::ClaudeCode, &Default::default())
        .unwrap();
    assert!(!page.known_rows_complete);
    assert!(page.items.is_empty());
    assert!(!page.problems.is_empty());
    assert!(
        selected
            .discover_projects(MigrationSourceKind::Codex, &Default::default())
            .is_err()
    );
    assert!(!product.join(".claude.json").exists());
}

#[test]
fn uploaded_roots_are_explicitly_unsupported_until_the_registry_bytes_have_a_manifest_proof() {
    use crate::source_transfer::uploads::SourceUploads;
    use kcoder_types::migration_source_upload::{SourceUploadFile, SourceUploadManifest};
    use sha2::{Digest, Sha256};
    let profile = tempfile::tempdir().unwrap();
    let store = SourceUploads::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let bytes = b"Synthetic supplied file";
    let manifest = SourceUploadManifest {
        version: 1,
        source: MigrationSourceKind::Codex,
        files: vec![SourceUploadFile {
            relative_path: "AGENTS.md".into(),
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }],
    };
    let digest = store.prepare(&id, manifest).unwrap().manifest_sha256;
    store.part(&id, 0, 0, 0, bytes).unwrap();
    store.finish(&id, 0, |_, _| true).unwrap();
    let (_, worker) = store.prepare_materialization(&id, &digest).unwrap();
    worker.unwrap().run(|_, _| true).unwrap();
    let mut registry = store.product_registry(&id, &digest).unwrap();
    let error = registry
        .discover_projects(MigrationSourceKind::Codex, &Default::default())
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "migration_project_registry_unsupported");
}
