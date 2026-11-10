use super::*;
use crate::{
    asset_sources::AssetBundleBinding,
    assets::{AssetResolution, AssetTarget},
    store::MigrationStore,
};
use kcoder_config::imported_context::{ImportedContextScope, ImportedContextStore};
use kcoder_types::{imported_memory::ImportedMemoryLayout, migration::MigrationCategory};

#[test]
fn transferred_memory_keeps_unverified_origin_and_requires_explicit_inactive_target_mapping() {
    for source in [Kind::ClaudeCode, Kind::Codex] {
        let f = Fixture::new();
        let root = f.files.join("memory");
        std::fs::create_dir(&root).unwrap();
        let bytes = "---\ntype: feedback\n---\nAn unverified model-authored statement.\n";
        std::fs::write(root.join("MEMORY.md"), bytes).unwrap();
        let layout = if source == Kind::Codex {
            ImportedMemoryLayout::CodexMemoryFilesV1
        } else {
            ImportedMemoryLayout::ClaudeAutoMemoryV1
        };
        let binding = AssetBundleBinding::capture(
            &root,
            source,
            MigrationCategory::Memory,
            ImportedContextScope::Global,
            true,
        )
        .unwrap()
        .with_memory(layout, "opaque-original-group".into())
        .unwrap();
        let original = binding
            .memory_provenance(&binding.read("MEMORY.md").unwrap())
            .unwrap()
            .unwrap();
        let manifest = f.export(ExportSelection::Asset {
            binding,
            key: "MEMORY.md".into(),
        });
        let TransferContent::WorkAsset {
            memory_provenance, ..
        } = &manifest.entries[0].content
        else {
            panic!("expected memory")
        };
        assert_eq!(memory_provenance.as_deref(), Some(&original));
        assert!(!original.facts_verified);
        let receipt = f.copy(&manifest);
        std::fs::remove_dir_all(&f.files).unwrap();
        let received = IncomingTransfers::open_existing(&f.target_profile)
            .unwrap()
            .received_asset_binding(
                &f.request,
                &receipt.manifest_sha256,
                &manifest.entries[0].id,
                None,
            )
            .unwrap();
        let store = MigrationStore::open_or_create(&f.target_profile).unwrap();
        let job = store.create_asset_scan(received).unwrap();
        let item = job.inventory.items[0].preview.id.clone();
        let job = store
            .select(&job.job_id, job.sequence, std::slice::from_ref(&item))
            .unwrap();
        let target = AssetTarget::open(&f.target_profile).unwrap();
        let mut choice = AssetResolution {
            agent_adaptation: None,
            item_id: item,
            target_name: "reviewed-model-note".into(),
            enable_after_import: false,
            memory_scope: None,
        };
        assert!(
            store
                .prepare_asset(&job.job_id, job.sequence, &target, &choice)
                .is_err()
        );
        choice.memory_scope = Some(ImportedContextScope::Global);
        let job = store
            .prepare_asset(&job.job_id, job.sequence, &target, &choice)
            .unwrap();
        let plan = job.asset_plans[0].id().to_string();
        let published = store
            .apply_asset(&job.job_id, job.sequence, &plan, &target)
            .unwrap();
        let record = ImportedContextStore::open(&f.target_profile)
            .unwrap()
            .list()
            .unwrap()
            .remove(0);
        assert!(!record.enabled);
        assert_eq!(record.content, bytes);
        let mut expected = original;
        expected.migration_job_id = Some(job.job_id.clone());
        assert_eq!(record.memory_provenance.as_deref(), Some(&expected));
        store
            .rollback_asset(&job.job_id, published.sequence, &plan, &target)
            .unwrap();
        assert!(
            ImportedContextStore::open(&f.target_profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn old_memory_manifest_remains_exact_and_unverified_without_fabricating_origin() {
    let f = Fixture::new();
    let path = f.files.join("legacy.md");
    std::fs::write(&path, "An old static note.").unwrap();
    let binding = AssetBundleBinding::capture(
        &path,
        Kind::ClaudeCode,
        MigrationCategory::Memory,
        ImportedContextScope::Global,
        false,
    )
    .unwrap();
    let mut manifest = f.export(ExportSelection::Asset {
        binding,
        key: "legacy.md".into(),
    });
    let TransferContent::WorkAsset {
        memory_provenance, ..
    } = &mut manifest.entries[0].content
    else {
        panic!("expected memory")
    };
    *memory_provenance = None;
    let old = serde_json::to_vec(&manifest).unwrap();
    assert!(!String::from_utf8_lossy(&old).contains("memoryProvenance"));
    let reopened: TransferManifest = serde_json::from_slice(&old).unwrap();
    reopened.validate().unwrap();
    assert_eq!(serde_json::to_vec(&reopened).unwrap(), old);
    let mut bad = serde_json::to_value(&manifest).unwrap();
    bad["entries"][0]["content"]["memoryProvenance"] = serde_json::json!({"source":"claude-code","layout":"unclassified_static_notes","sourceGroup":"legacy","sourceFile":"legacy.md","sourceRevision":"a".repeat(64),"sourceModifiedAtMs":null,"factsVerified":true});
    assert!(serde_json::from_value::<TransferManifest>(bad).is_err());
}

#[test]
fn memory_logical_origin_does_not_change_when_a_fresh_snapshot_has_new_content() {
    let f = Fixture::new();
    let root = f.files.join("memories");
    std::fs::create_dir(&root).unwrap();
    let path = root.join("MEMORY.md");
    std::fs::write(&path, "First note").unwrap();
    let capture = || {
        AssetBundleBinding::capture(
            &root,
            Kind::Codex,
            MigrationCategory::Memory,
            ImportedContextScope::Global,
            true,
        )
        .unwrap()
        .with_memory(ImportedMemoryLayout::CodexMemoryFilesV1, "memories".into())
        .unwrap()
    };
    let first = capture();
    let old = first.read("MEMORY.md").unwrap().revision();
    std::fs::write(&path, "Changed note with a different byte length").unwrap();
    let next = capture();
    assert_eq!(
        first.stable_source_identity(),
        next.stable_source_identity()
    );
    assert_ne!(old, next.read("MEMORY.md").unwrap().revision());
    assert!(
        first.read("MEMORY.md").is_err(),
        "a frozen snapshot never follows content changes"
    );
}
