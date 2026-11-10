use super::*;
use crate::asset_sources::AssetBundleBinding;
use kcoder_config::imported_context::ImportedContextScope;
use kcoder_types::migration::MigrationCategory;
use std::io::Seek;

fn binding(path: &Path) -> AssetBundleBinding {
    AssetBundleBinding::capture(
        path,
        Kind::ClaudeCode,
        MigrationCategory::Instructions,
        ImportedContextScope::Global,
        false,
    )
    .unwrap()
}

#[test]
fn work_asset_logical_origin_survives_content_changes_and_separates_other_source_roots() {
    let f = Fixture::new();
    let mut captured = Vec::new();
    for index in 0..3 {
        let root = f.files.join(if index < 2 { "first" } else { "second" });
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("CLAUDE.md");
        std::fs::write(&path, if index == 0 { "First" } else { "Changed" }).unwrap();
        let request = uuid::Uuid::new_v4().to_string();
        let destination = f
            .target
            .issue_destination(&request, f.source.authority())
            .unwrap();
        f.source
            .prepare(
                &request,
                &destination,
                vec![ExportSelection::Asset {
                    binding: binding(&path),
                    key: "CLAUDE.md".into(),
                }],
            )
            .unwrap();
        let manifest = f.source.capture(&request, &destination, |_| true).unwrap();
        let TransferContent::WorkAsset {
            source_identity,
            source_revision,
            ..
        } = &manifest.entries[0].content
        else {
            panic!("wrong fixture kind")
        };
        captured.push((source_identity.clone().unwrap(), source_revision.clone()));
    }
    assert_eq!(captured[0].0, captured[1].0);
    assert_ne!(captured[0].1, captured[1].1);
    assert_ne!(captured[1].0, captured[2].0);
}

#[test]
fn old_work_asset_receipts_keep_their_exact_manifest_without_fabricating_a_source_identity() {
    let f = Fixture::new();
    let path = f.files.join("CLAUDE.md");
    let bytes = b"Inert legacy instructions";
    std::fs::write(&path, bytes).unwrap();
    let mut manifest = f.export(ExportSelection::Asset {
        binding: binding(&path),
        key: "CLAUDE.md".into(),
    });
    let TransferContent::WorkAsset {
        source_identity, ..
    } = &mut manifest.entries[0].content
    else {
        panic!("wrong fixture kind")
    };
    *source_identity = None;
    let old_bytes = serde_json::to_vec(&manifest).unwrap();
    assert!(!String::from_utf8_lossy(&old_bytes).contains("sourceIdentity"));
    let reopened: TransferManifest = serde_json::from_slice(&old_bytes).unwrap();
    assert_eq!(serde_json::to_vec(&reopened).unwrap(), old_bytes);
    assert_eq!(reopened.digest().unwrap(), manifest.digest().unwrap());
    f.target.begin(&reopened, f.source.authority()).unwrap();
    let entry = &reopened.entries[0];
    let chunk = TransferChunk::received(
        f.request.clone(),
        reopened.digest().unwrap(),
        entry.id.clone(),
        0,
        entry.sha256.clone(),
        bytes.to_vec(),
    )
    .unwrap();
    f.target.write_part(f.source.authority(), &chunk).unwrap();
    let receipt = f
        .target
        .finish(&f.request, f.source.authority(), |_| true)
        .unwrap();
    let restored = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let asset = restored
        .work_asset(&f.request, f.source.authority(), &entry.id, &receipt)
        .unwrap();
    assert!(asset.source_identity.is_none());
    assert_eq!(asset.asset.files[0].content, bytes);
    let legacy = restored
        .received_asset_binding(&f.request, &receipt.manifest_sha256, &entry.id, None)
        .unwrap();
    assert!(!legacy.allows_reuse());
    assert!(
        legacy.stable_source_identity().is_none(),
        "re-export must not turn an artifact ID into a source origin"
    );
}

#[test]
fn returned_work_asset_bytes_are_verified_after_a_same_inode_change_between_hash_and_delivery() {
    let f = Fixture::new();
    let path = f.files.join("CLAUDE.md");
    let original = b"Original instructions";
    let changed = b"Modified instructions";
    assert_eq!(original.len(), changed.len());
    std::fs::write(&path, original).unwrap();
    let manifest = f.export(ExportSelection::Asset {
        binding: binding(&path),
        key: "CLAUDE.md".into(),
    });
    let receipt = f.copy(&manifest);
    let entry = &manifest.entries[0];
    let directory = PrivateDirectory::open_existing(
        &f.target_profile
            .join("migrations/source-transfer/incoming")
            .join(&f.request),
    )
    .unwrap();
    let leaf = crate::source_transfer::source::payload_name(entry);
    let expected_identity = directory
        .portable_regular_identity(OsStr::new(&leaf))
        .unwrap();
    let mut changed_once = false;
    let result = f.target.work_asset_checked(
        &f.request,
        f.source.authority(),
        &entry.id,
        &receipt,
        |consumed| {
            if consumed == original.len() as u64 && !changed_once {
                changed_once = true;
                let mut same_file = directory
                    .open_read_write_file(OsStr::new(&leaf), false)
                    .unwrap();
                same_file.seek(std::io::SeekFrom::Start(0)).unwrap();
                same_file.write_all(changed).unwrap();
                same_file.sync_all().unwrap();
            }
            true
        },
    );
    assert!(changed_once);
    assert_eq!(
        directory
            .portable_regular_identity(OsStr::new(&leaf))
            .unwrap(),
        expected_identity
    );
    if let Ok(asset) = result {
        assert_eq!(
            asset.asset.files[0].content, original,
            "never deliver the unverified second read"
        );
    }
}

#[test]
fn returned_configuration_inventory_cannot_substitute_equal_length_bytes_after_the_original_hash() {
    let f = Fixture::new();
    let original_binding = f.config(Kind::ClaudeCode);
    let manifest = f.export(ExportSelection::Configuration(original_binding));
    let receipt = f.copy(&manifest);
    let entry = &manifest.entries[0];
    let directory = PrivateDirectory::open_existing(
        &f.target_profile
            .join("migrations/source-transfer/incoming")
            .join(&f.request),
    )
    .unwrap();
    let leaf = crate::source_transfer::source::payload_name(entry);
    let original = std::fs::read(
        f.target_profile
            .join("migrations/source-transfer/incoming")
            .join(&f.request)
            .join(&leaf),
    )
    .unwrap();
    let changed = String::from_utf8(original.clone())
        .unwrap()
        .replace("fixture-model", "mutated-model")
        .into_bytes();
    assert_eq!(changed.len(), original.len());
    assert_ne!(changed, original);
    let identity = directory
        .portable_regular_identity(OsStr::new(&leaf))
        .unwrap();
    let mut mutated = false;
    let result = f.target.configuration_inventory_checked(
        &f.request,
        f.source.authority(),
        &entry.id,
        &receipt,
        |consumed| {
            if consumed == entry.bytes && !mutated {
                mutated = true;
                let mut file = directory
                    .open_read_write_file(OsStr::new(&leaf), false)
                    .unwrap();
                file.seek(std::io::SeekFrom::Start(0)).unwrap();
                file.write_all(&changed).unwrap();
                file.sync_all().unwrap();
            }
            true
        },
    );
    assert!(mutated);
    assert_eq!(
        directory
            .portable_regular_identity(OsStr::new(&leaf))
            .unwrap(),
        identity
    );
    assert_eq!(
        result.err().unwrap().to_string(),
        "source_transfer_payload_changed"
    );
}
