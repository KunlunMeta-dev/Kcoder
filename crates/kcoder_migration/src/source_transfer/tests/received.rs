use super::*;

#[test]
fn received_catalog_pages_original_receipts_after_source_removal_without_private_metadata() {
    let f = Fixture::new();
    let mut selections = Vec::new();
    for index in 0..13 {
        let root = f.files.join(format!("source-{index}"));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("settings.json");
        std::fs::write(
            &path,
            r#"{"model":"fixture","env":{"ANTHROPIC_API_KEY":"PRIVATE_NOT_IN_CATALOG"}}"#,
        )
        .unwrap();
        selections.push(ExportSelection::Configuration(
            ConfigurationBinding::capture_selected(&path, Kind::ClaudeCode).unwrap(),
        ));
    }
    f.source
        .prepare(&f.request, &f.destination, selections)
        .unwrap();
    let manifest = f
        .source
        .capture(&f.request, &f.destination, |_| true)
        .unwrap();
    let receipt = f.copy(&manifest);
    std::fs::remove_dir_all(&f.files).unwrap();
    let reopened = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let first = reopened
        .received_sources(&f.request, &receipt.manifest_sha256, 0)
        .unwrap();
    let second = reopened
        .received_sources(&f.request, &receipt.manifest_sha256, 1)
        .unwrap();
    assert_eq!(first.items.len(), 10);
    assert_eq!(second.items.len(), 3);
    assert_eq!(first.total_sources, 13);
    assert_eq!(first.next_page, Some(1));
    assert_eq!(second.next_page, None);
    assert_eq!(first.receipt, receipt);
    assert!(
        first
            .items
            .iter()
            .all(|item| item.class == ReceivedSourceClass::Configuration && item.files == 1)
    );
    let public = format!("{first:?}");
    assert!(!public.contains("PRIVATE_NOT_IN_CATALOG"));
    assert!(!public.contains(&f.source_profile.to_string_lossy().to_string()));
    assert!(
        reopened
            .received_sources(&f.request, &"0".repeat(64), 0)
            .is_err()
    );
    assert!(
        reopened
            .received_sources(&f.request, &receipt.manifest_sha256, 2)
            .is_err()
    );
    let peer = IncomingTransfers::open(&f._root.path().join("peer")).unwrap();
    assert!(
        peer.received_sources(&f.request, &receipt.manifest_sha256, 0)
            .is_err()
    );
}

#[test]
fn received_catalog_keeps_configuration_asset_and_history_classes_distinct() {
    let f = Fixture::new();
    let config = f.config(Kind::ClaudeCode);
    let history = f.history();
    let file = f.files.join("CLAUDE.md");
    std::fs::write(&file, "Inert instructions").unwrap();
    let asset = crate::asset_sources::AssetBundleBinding::capture(
        &file,
        Kind::ClaudeCode,
        kcoder_types::migration::MigrationCategory::Instructions,
        kcoder_config::imported_context::ImportedContextScope::Global,
        false,
    )
    .unwrap();
    f.source
        .prepare(
            &f.request,
            &f.destination,
            vec![
                ExportSelection::Configuration(config),
                ExportSelection::CapturedHistory(history),
                ExportSelection::Asset {
                    binding: asset,
                    key: "CLAUDE.md".into(),
                },
            ],
        )
        .unwrap();
    let manifest = f
        .source
        .capture(&f.request, &f.destination, |_| true)
        .unwrap();
    assert!(
        f.target
            .received_sources(&f.request, &manifest.digest().unwrap(), 0)
            .is_err()
    );
    let receipt = f.copy(&manifest);
    let page = f
        .target
        .received_sources(&f.request, &receipt.manifest_sha256, 0)
        .unwrap();
    assert_eq!(
        page.items.iter().map(|item| item.class).collect::<Vec<_>>(),
        vec![
            ReceivedSourceClass::Configuration,
            ReceivedSourceClass::History,
            ReceivedSourceClass::WorkAsset
        ]
    );
    f.target
        .cancel_target(
            &f.request,
            f.source.authority(),
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    assert!(
        f.target
            .received_sources(&f.request, &receipt.manifest_sha256, 0)
            .is_err()
    );
}

#[test]
fn received_catalog_counts_a_multifile_asset_as_one_source_without_installing_it() {
    let f = Fixture::new();
    let directory = f.files.join("sample-skill");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(
        directory.join("SKILL.md"),
        "---\nname: sample-skill\ndescription: Static fixture\n---\nDo not execute sources.\n",
    )
    .unwrap();
    std::fs::write(directory.join("guide.txt"), "Companion static file").unwrap();
    let asset = crate::asset_sources::AssetBundleBinding::capture(
        &directory,
        Kind::ClaudeCode,
        kcoder_types::migration::MigrationCategory::Skill,
        kcoder_config::imported_context::ImportedContextScope::Global,
        false,
    )
    .unwrap();
    let manifest = f.export(ExportSelection::Asset {
        binding: asset,
        key: "sample-skill".into(),
    });
    assert_eq!(manifest.entries.len(), 2);
    let receipt = f.copy(&manifest);
    let page = f
        .target
        .received_sources(&f.request, &receipt.manifest_sha256, 0)
        .unwrap();
    assert_eq!(page.total_sources, 1);
    assert_eq!(page.items[0].files, 2);
    assert_eq!(
        page.items[0].bytes,
        manifest
            .entries
            .iter()
            .map(|entry| entry.bytes)
            .sum::<u64>()
    );
    assert_eq!(
        page.items[0].category,
        Some(kcoder_types::migration::MigrationCategory::Skill)
    );
    assert!(!f.target_profile.join("skills").exists());
}
