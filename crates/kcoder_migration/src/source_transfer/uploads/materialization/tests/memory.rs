use super::*;
use crate::source_transfer::{
    ExportSelection, IncomingTransfers, SourceTransfers, TransferContent,
};
use kcoder_types::migration::MigrationSourceKind;

#[test]
fn uploaded_memory_never_invents_an_original_mtime_and_received_provenance_retains_unknown_time() {
    let bytes = b"An explicitly supplied unverified static note.\n";
    let (profile, uploads, id, digest) = upload(&[("memories/MEMORY.md", bytes)]);
    let (_, worker) = uploads.prepare_materialization(&id, &digest).unwrap();
    worker.unwrap().run(|_, _| true).unwrap();
    let mut registry = uploads.product_registry(&id, &digest).unwrap();
    let page = registry
        .discover_memories(MigrationSourceKind::Codex, &mut |_| true)
        .unwrap();
    assert!(page.problems.is_empty());
    assert_eq!(page.items.len(), 1);
    let binding = registry.selected_asset(&page.items[0].source_id).unwrap();
    let origin = binding
        .memory_provenance(&binding.read("MEMORY.md").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        origin.source_modified_at_ms, None,
        "the materialized file mtime is not evidence of the supplied original mtime"
    );
    let uploaded = kcoder_types::migration_source_upload::SourceUploadProvenance {
        operation_id: id,
        manifest_sha256: digest,
    };
    assert_eq!(binding.uploaded_source().unwrap(), Some(uploaded.clone()));

    let source = SourceTransfers::open(profile.path()).unwrap();
    let receiver = tempfile::tempdir().unwrap();
    let target = IncomingTransfers::open(receiver.path()).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let grant = target
        .issue_destination(&request, source.authority())
        .unwrap();
    source
        .prepare(
            &request,
            &grant,
            vec![ExportSelection::Asset {
                binding,
                key: "MEMORY.md".into(),
            }],
        )
        .unwrap();
    let manifest = source.capture(&request, &grant, |_| true).unwrap();
    let TransferContent::WorkAsset {
        memory_provenance,
        uploaded_source,
        ..
    } = &manifest.entries[0].content
    else {
        panic!("expected a static memory file");
    };
    assert_eq!(uploaded_source.as_ref(), Some(&uploaded));
    assert_eq!(memory_provenance.as_deref(), Some(&origin));
    target.begin(&manifest, source.authority()).unwrap();
    let manifest_sha = manifest.digest().unwrap();
    let entry = &manifest.entries[0];
    for part in 0..entry
        .bytes
        .div_ceil(crate::source_transfer::TRANSFER_CHUNK_BYTES as u64) as u32
    {
        let chunk = source
            .chunk(&request, &grant, &manifest_sha, &entry.id, part)
            .unwrap();
        target.write_part(source.authority(), &chunk).unwrap();
    }
    target
        .finish(&request, source.authority(), |_| true)
        .unwrap();
    let owner = tempfile::tempdir().unwrap();
    std::fs::rename(profile.path(), owner.path().join("source-offline")).unwrap();
    let received = target
        .received_asset_binding(&request, &manifest_sha, &entry.id, None)
        .unwrap();
    let received: crate::asset_sources::AssetBundleBinding =
        serde_json::from_slice(&serde_json::to_vec(&received).unwrap()).unwrap();
    let restored = received
        .memory_provenance(&received.read("MEMORY.md").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(restored, origin);
    assert_eq!(restored.source_modified_at_ms, None);
    assert_eq!(received.uploaded_source().unwrap(), Some(uploaded));
}

#[test]
fn a_fresh_memory_inventory_cannot_recapture_same_inode_changed_uploaded_bytes() {
    let original = b"An original uploaded static note.\n";
    let (profile, uploads, id, digest) = upload(&[("memories/MEMORY.md", original)]);
    let (_, worker) = uploads.prepare_materialization(&id, &digest).unwrap();
    worker.unwrap().run(|_, _| true).unwrap();
    let path = profile
        .path()
        .join("migrations/source-transfer/browser-products")
        .join(&id)
        .join(PRODUCT)
        .join("memories/MEMORY.md");
    let parent = PrivateDirectory::open_existing(path.parent().unwrap()).unwrap();
    let before = parent
        .portable_regular_identity(OsStr::new("MEMORY.md"))
        .unwrap();
    let mut mutated = original.to_vec();
    mutated[0] ^= 1;
    let mut file = parent
        .open_read_write_file(OsStr::new("MEMORY.md"), false)
        .unwrap();
    std::io::Write::write_all(&mut file, &mutated).unwrap();
    file.sync_all().unwrap();
    drop(file);
    assert_eq!(
        parent
            .portable_regular_identity(OsStr::new("MEMORY.md"))
            .unwrap(),
        before
    );
    let mut registry = uploads.product_registry(&id, &digest).unwrap();
    let page = registry
        .discover_memories(MigrationSourceKind::Codex, &mut |_| true)
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].blocked_items, 1);
    let binding = registry.selected_asset(&page.items[0].source_id).unwrap();
    assert_eq!(
        binding.read("MEMORY.md").err().unwrap().to_string(),
        "source_upload_product_content_changed"
    );
}
