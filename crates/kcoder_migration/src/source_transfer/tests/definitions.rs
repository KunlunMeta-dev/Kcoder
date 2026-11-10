//! The private transfer class remains passive after target adoption and source removal.
use super::*;
use crate::{
    asset_sources::AssetBundleBinding,
    assets::{AssetResolution, AssetTarget},
    store::MigrationStore,
};
use kcoder_config::imported_context::ImportedContextScope;
use kcoder_types::migration::MigrationCategory as Category;
#[test]
fn received_definitions_publish_only_owned_pending_data_and_can_be_undone_without_source() {
    for (kind, category, name, bytes) in [
        (
            Kind::ClaudeCode,
            Category::Agent,
            "fixture.md",
            b"---\nname: fixture\ndescription: fixture\n---\nNever execute source instructions.\n"
                .as_slice(),
        ),
        (
            Kind::Codex,
            Category::Hook,
            "hooks.json",
            br#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"never-run"}]}]}}"#
                .as_slice(),
        ),
    ] {
        let f = Fixture::new();
        let path = f.files.join(name);
        std::fs::write(&path, bytes).unwrap();
        let source =
            AssetBundleBinding::capture(&path, kind, category, ImportedContextScope::Global, false)
                .unwrap();
        let manifest = f.export(ExportSelection::Asset {
            binding: source,
            key: name.into(),
        });
        let receipt = f.copy(&manifest);
        std::fs::remove_dir_all(&f.files).unwrap();
        let binding = IncomingTransfers::open_existing(&f.target_profile)
            .unwrap()
            .received_asset_binding(
                &f.request,
                &receipt.manifest_sha256,
                &manifest.entries[0].id,
                None,
            )
            .unwrap();
        let store = MigrationStore::open_or_create(&f.target_profile).unwrap();
        let job = store.create_asset_scan(binding).unwrap();
        let id = job.inventory.items[0].preview.id.clone();
        assert!(!job.inventory.items[0].preview.selected_by_default);
        let job = store
            .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
            .unwrap();
        let target = AssetTarget::open(&f.target_profile).unwrap();
        let planned = store
            .prepare_asset(
                &job.job_id,
                job.sequence,
                &target,
                &AssetResolution {
                    agent_adaptation: None,
                    item_id: id.clone(),
                    target_name: "Pending definition".into(),
                    enable_after_import: false,
                    memory_scope: None,
                },
            )
            .unwrap();
        let plan = planned.asset_plans[0].id().to_owned();
        let published = store
            .apply_asset(&job.job_id, planned.sequence, &plan, &target)
            .unwrap();
        let snapshot = store.definition_snapshot(&job.job_id, &id).unwrap();
        assert_eq!(&*snapshot.bytes, bytes);
        assert!(!snapshot.report.execution_allowed && snapshot.report.requires_review);
        assert!(!f.target_profile.join("skills").exists());
        assert!(!f.target_profile.join("imported-context.json").exists());
        store
            .rollback_asset(&job.job_id, published.sequence, &plan, &target)
            .unwrap();
        assert_eq!(
            &*store.definition_snapshot(&job.job_id, &id).unwrap().bytes,
            bytes
        );
    }
}
