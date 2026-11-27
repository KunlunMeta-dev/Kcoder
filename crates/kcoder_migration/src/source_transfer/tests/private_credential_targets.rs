//! Native saved-plan projection uses the original received entry, not display-name joins.
use super::*;
use crate::{
    assets::AssetTarget,
    batch::{BatchResolution, BatchSource},
    mcp::{McpResolution, McpTarget},
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    source_transfer::private_credentials::*,
    store::{BatchTargets, MigrationJob, MigrationStore},
};
use serde_json::json;

struct Planned {
    f: Fixture,
    manifest: TransferManifest,
    receipt: TransferReceipt,
    store: MigrationStore,
    job: MigrationJob,
    sources: Vec<TransferredConfigurationBinding>,
}
fn planned() -> Planned {
    planned_count(2)
}
fn planned_count(count: usize) -> Planned {
    let f = Fixture::new();
    std::fs::write(
        f.target_profile.join("settings.json"),
        r#"{"credential_store":"file","providers":{},"mcp_servers":[]}"#,
    )
    .unwrap();
    let mut selections = Vec::new();
    for index in 0..count {
        let root = f.files.join(format!("root-{index}"));
        PrivateDirectory::open_or_create(&root).unwrap();
        let path = root.join("settings.json");
        std::fs::write(&path, json!({"model":"fixture","env":{"ANTHROPIC_BASE_URL":format!("https://source-{index}.invalid/v1"),"ANTHROPIC_API_KEY":"SYNTHETIC_TARGET_MAP_PROVIDER"},
            "mcpServers":{"notes":{"command":"NEVER_EXECUTE_TARGET_MAP_SOURCE","env":{"TOKEN":"SYNTHETIC_TARGET_MAP_MCP"}}}}).to_string()).unwrap();
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
    let sources = manifest
        .entries
        .iter()
        .map(|entry| {
            f.target
                .configuration_binding(&f.request, f.source.authority(), &entry.id, &receipt)
                .unwrap()
        })
        .collect::<Vec<_>>();
    let store = MigrationStore::open_or_create(&f.target_profile).unwrap();
    let scan = store
        .create_batch_scan(
            sources
                .iter()
                .cloned()
                .map(|source| BatchSource::TransferredConfiguration(Box::new(source)))
                .collect(),
        )
        .unwrap();
    let choices = scan.inventory.items.iter().filter_map(|item| {
        let source = scan.batch.as_ref().unwrap().source_for(&item.preview.id).unwrap();
        let index = sources.iter().position(|candidate| matches!(source, BatchSource::TransferredConfiguration(binding) if **binding == *candidate)).unwrap();
        if item.provider.is_some() {
            Some(BatchResolution::Provider(ProviderResolution { item_id: item.preview.id.clone(), target_name: format!("Provider{index}"), endpoint: None, model: None,
                limits: Some(ModelLimits { context_window_tokens: 64000, output_headroom_tokens: 8192, max_output_tokens: 8192 }) }))
        } else if item.mcp.is_some() {
            Some(BatchResolution::Mcp(McpResolution { item_id: item.preview.id.clone(), target_name: format!("notes-{index}"), cwd: None, enable_after_import: false }))
        } else { None }
    }).collect::<Vec<_>>();
    let provider = ProviderTarget::open(&f.target_profile).unwrap();
    let mcp = McpTarget::open(&f.target_profile).unwrap();
    let assets = AssetTarget::open(&f.target_profile).unwrap();
    let job = store
        .prepare_batch(
            &scan.job_id,
            scan.sequence,
            &choices,
            &BatchTargets {
                provider: &provider,
                mcp: &mcp,
                assets: &assets,
                history: None,
                credentials: None,
            },
        )
        .unwrap();
    Planned {
        f,
        manifest,
        receipt,
        store,
        job,
        sources,
    }
}

#[path = "private_credential_targets/job_sources.rs"]
mod job_sources;
fn page(p: &Planned, index: usize) -> PrivateCredentialCandidatePage {
    private_credential_candidates(
        &p.f.target,
        p.f.source.authority(),
        &p.f.request,
        &p.receipt,
        &p.manifest.entries[index].id,
        0,
    )
    .unwrap()
}
fn map(p: &Planned, page: &mut PrivateCredentialCandidatePage) -> anyhow::Result<()> {
    private_credential_candidates_for_plan(
        &p.f.target,
        p.f.source.authority(),
        &p.receipt,
        page,
        &p.job.job_id,
        p.job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
    )
}
fn original_files(root: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, files: &mut std::collections::BTreeMap<PathBuf, Vec<u8>>) {
        for entry in std::fs::read_dir(root).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                visit(&entry.path(), files);
            } else {
                files.insert(entry.path(), std::fs::read(entry.path()).unwrap());
            }
        }
    }
    let mut files = Default::default();
    visit(root, &mut files);
    files
}
#[test]
fn saved_targets_bind_renamed_duplicate_names_to_their_exact_received_entry_and_read_without_writes()
 {
    let p = planned();
    std::fs::rename(&p.f.files, p.f.files.with_extension("withheld")).unwrap();
    let before = original_files(&p.f.target_profile);
    for index in 0..2 {
        let mut selected = page(&p, index);
        map(&p, &mut selected).unwrap();
        let first = serde_json::to_value(&selected).unwrap();
        assert_eq!(first["plan"]["sequence"], p.job.sequence);
        for row in first["items"].as_array().unwrap() {
            let targets = row["targets"].as_array().unwrap();
            assert_eq!(targets.len(), 1);
            assert_eq!(
                targets[0]["targetName"],
                if row["kind"] == "provider" {
                    format!("Provider{index}")
                } else {
                    format!("notes-{index}")
                }
            );
            let source = p
                .job
                .batch
                .as_ref()
                .unwrap()
                .source_for(targets[0]["batchItemId"].as_str().unwrap())
                .unwrap();
            assert!(
                matches!(source, BatchSource::TransferredConfiguration(binding) if **binding == p.sources[index])
            );
        }
        // Repeated pure observation must not accumulate another destination.
        map(&p, &mut selected).unwrap();
        assert_eq!(serde_json::to_value(&selected).unwrap(), first);
        assert!(!first.to_string().contains("SYNTHETIC_TARGET_MAP"));
    }
    assert_eq!(original_files(&p.f.target_profile), before);
    assert!(
        !p.f.target_profile
            .join("migrations/source-transfer/private-credentials")
            .exists()
    );
}
#[test]
fn mismatched_candidate_metadata_cannot_borrow_another_received_entrys_saved_targets() {
    let p = planned();
    let mut selected = page(&p, 0);
    selected.entry_id = p.manifest.entries[1].id.clone();
    assert!(map(&p, &mut selected).is_err());
    let mut selected = page(&p, 0);
    selected.source_binding_revision = "a".repeat(64);
    assert!(map(&p, &mut selected).is_err());
    let mut selected = page(&p, 0);
    selected.manifest_sha256 = "b".repeat(64);
    assert!(map(&p, &mut selected).is_err());
}
#[test]
fn unrelated_jobs_stale_plans_and_unprepared_jobs_never_claim_a_private_offer_or_repair_metadata() {
    let p = planned();
    let mut selected = page(&p, 0);
    let before = original_files(&p.f.target_profile);
    assert!(
        private_credential_candidates_for_plan(
            &p.f.target,
            p.f.source.authority(),
            &p.receipt,
            &mut selected,
            &p.job.job_id,
            "batch-wrong"
        )
        .is_err()
    );
    assert_eq!(original_files(&p.f.target_profile), before);
    let other = p
        .store
        .create_batch_scan(vec![BatchSource::TransferredConfiguration(Box::new(
            p.sources[1].clone(),
        ))])
        .unwrap();
    assert!(
        private_credential_candidates_for_plan(
            &p.f.target,
            p.f.source.authority(),
            &p.receipt,
            &mut selected,
            &other.job_id,
            "batch-unprepared"
        )
        .is_err()
    );
    let provider = ProviderTarget::open(&p.f.target_profile).unwrap();
    let mcp = McpTarget::open(&p.f.target_profile).unwrap();
    let assets = AssetTarget::open(&p.f.target_profile).unwrap();
    let choices = other
        .inventory
        .items
        .iter()
        .filter_map(|item| {
            if item.provider.is_some() {
                Some(BatchResolution::Provider(ProviderResolution {
                    item_id: item.preview.id.clone(),
                    target_name: "OtherProvider".into(),
                    endpoint: None,
                    model: None,
                    limits: Some(ModelLimits {
                        context_window_tokens: 64000,
                        output_headroom_tokens: 8192,
                        max_output_tokens: 8192,
                    }),
                }))
            } else if item.mcp.is_some() {
                Some(BatchResolution::Mcp(McpResolution {
                    item_id: item.preview.id.clone(),
                    target_name: "other-notes".into(),
                    cwd: None,
                    enable_after_import: false,
                }))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let other = p
        .store
        .prepare_batch(
            &other.job_id,
            other.sequence,
            &choices,
            &BatchTargets {
                provider: &provider,
                mcp: &mcp,
                assets: &assets,
                history: None,
                credentials: None,
            },
        )
        .unwrap();
    let before = original_files(&p.f.target_profile);
    assert_eq!(
        private_credential_candidates_for_plan(
            &p.f.target,
            p.f.source.authority(),
            &p.receipt,
            &mut selected,
            &other.job_id,
            other.batch.as_ref().unwrap().plan_id.as_deref().unwrap()
        )
        .unwrap_err()
        .to_string(),
        "private_credentials_source_not_selected"
    );
    assert_eq!(original_files(&p.f.target_profile), before);
    assert!(
        !p.f.target_profile
            .join("migrations/source-transfer/private-credentials")
            .exists()
    );
}

#[path = "private_credential_targets/bundle.rs"]
mod bundle;
