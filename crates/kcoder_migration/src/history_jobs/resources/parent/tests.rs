use super::*;
use crate::{
    assets::AssetTarget,
    batch::{BatchSource, default_resolution, history::HistoryBatchSource},
    history_discovery::HistoryCatalog,
    mcp::McpTarget,
    providers::ProviderTarget,
    store::{BatchTargets, MigrationJob, MigrationStore},
};
use kcoder_types::{
    external_history::HistoryImportStage,
    migration::{MigrationJobStatus, MigrationSourceKind},
};
use serde_json::json;
use std::{fs, path::Path};

struct Fixture {
    store: MigrationStore,
    _provider: ProviderTarget,
    _mcp: McpTarget,
    _assets: AssetTarget,
    history: HistoryJobStore,
    parent: MigrationJob,
    child: String,
    source: tempfile::TempDir,
    profile: tempfile::TempDir,
}
fn read(path: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn write(path: &Path, value: &serde_json::Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}
impl Fixture {
    fn new() -> Self {
        let profile = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let directory = source.path().join("projects/owned");
        fs::create_dir_all(&directory).unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        fs::write(
            directory.join(format!("{session}.jsonl")),
            format!(
                "{}\n",
                json!({
                    "type":"user", "uuid":"first", "sessionId":session,
                    "message":{"role":"user","content":"owned original history"}
                })
            ),
        )
        .unwrap();
        let catalog =
            HistoryCatalog::discover(source.path(), MigrationSourceKind::ClaudeCode, |_| true)
                .unwrap();
        let page = catalog.page(None, |_| true).unwrap();
        let selected = catalog
            .selection(&page.items[0].source_handle)
            .unwrap()
            .pin()
            .unwrap();
        let store = MigrationStore::open_or_create(profile.path()).unwrap();
        let provider = ProviderTarget::open(profile.path()).unwrap();
        let mcp = McpTarget::open(profile.path()).unwrap();
        let assets = AssetTarget::open(profile.path()).unwrap();
        let history = HistoryJobStore::open(profile.path()).unwrap();
        let targets = BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            history: Some(&history),
            credentials: None,
        };
        let scan = store
            .create_batch_scan(vec![BatchSource::History(Box::new(
                HistoryBatchSource::new(selected).unwrap(),
            ))])
            .unwrap();
        let choice = default_resolution(&scan, &scan.inventory.items[0]).unwrap();
        let plan = store
            .prepare_batch(&scan.job_id, scan.sequence, &[choice], &targets)
            .unwrap();
        let parent = store
            .run_batch(
                &plan.job_id,
                plan.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                "original_apply",
                plan.sequence,
                false,
                &targets,
            )
            .unwrap();
        assert_eq!(parent.status, MigrationJobStatus::Completed);
        let child = parent
            .batch
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .find_map(|action| match &action.action {
                crate::batch::BatchActionKind::History { plan } => {
                    Some(plan.history_job_id.clone())
                }
                _ => None,
            })
            .unwrap();
        Self {
            store,
            _provider: provider,
            _mcp: mcp,
            _assets: assets,
            history,
            parent,
            child,
            source,
            profile,
        }
    }

    fn legacy(&self, keep_parent_limits: bool) {
        let parent = self
            .profile
            .path()
            .join("migrations")
            .join(format!("{}.json", self.parent.job_id));
        if !keep_parent_limits {
            let mut document = read(&parent);
            document["batch"]
                .as_object_mut()
                .unwrap()
                .remove("resourceLimits");
            write(&parent, &document);
        }
        let child = self
            .profile
            .path()
            .join("migrations/history")
            .join(format!("{}.json", self.child));
        let mut document = read(&child);
        document["version"] = json!(3);
        document.as_object_mut().unwrap().remove("resourceBudget");
        write(&child, &document);
        fs::remove_file(
            self.profile
                .path()
                .join("migrations/history")
                .join(format!("{}.resource.birth", self.child)),
        )
        .unwrap();
        let ledger = self
            .profile
            .path()
            .join("external-history/managed-v2/lifecycle.json");
        let mut document = read(&ledger);
        document["resource_groups"] = json!({});
        for archive in document["archives"].as_object_mut().unwrap().values_mut() {
            archive.as_object_mut().unwrap().remove("resource_budget");
        }
        write(&ledger, &document);
    }
    fn attach(
        &self,
        limits: MigrationResourceLimits,
    ) -> Result<kcoder_types::migration_resource::MigrationResourceBudgetView> {
        self.store.attach_batch_resource_budget(
            &self.parent.job_id,
            self.parent
                .batch
                .as_ref()
                .unwrap()
                .plan_id
                .as_deref()
                .unwrap(),
            self.parent.sequence,
            limits,
            true,
            &self.history,
        )
    }
}
fn limits() -> MigrationResourceLimits {
    MigrationResourceLimits {
        max_total_bytes: 4 * 1024 * 1024,
        max_payload_files: 16,
        min_free_bytes: 1024 * 1024,
        min_free_file_nodes: 0,
    }
}

#[test]
fn a_missing_old_parents_born_ledger_is_not_recreated_as_a_standalone_child() {
    let f = Fixture::new();
    f.legacy(true);
    let before = f.history.read(&f.child).unwrap();
    assert_eq!(
        f.history
            .resource_budget_owner(&f.child)
            .unwrap()
            .as_deref(),
        Some(f.parent.job_id.as_str())
    );
    assert_eq!(
        f.history
            .attach_resource_budget(&f.child, before.sequence, Default::default(), true)
            .unwrap_err()
            .to_string(),
        "history_resource_ledger_missing"
    );
    assert!(
        f.history
            .archives
            .recorded_resource_budget(&f.child)
            .unwrap()
            .is_none()
    );
    assert!(
        !f.profile
            .path()
            .join("migrations/history")
            .join(format!("{}.resource.birth", f.child))
            .exists()
    );
    assert_eq!(f.history.read(&f.child).unwrap(), before);
}

#[test]
fn a_completed_legacy_parent_can_attach_and_raise_without_replaying_publication() {
    let f = Fixture::new();
    f.legacy(false);
    fs::remove_dir_all(f.source.path().join("projects")).unwrap();
    let before = f.history.read(&f.child).unwrap();
    let policy = f.attach(limits()).unwrap();
    assert_eq!(policy.policy_revision(), Some(0));
    assert!(policy.usage().unwrap().committed_bytes > 0);
    assert_eq!(f.history.read(&f.child).unwrap(), before);
    assert_eq!(
        f.store.read(&f.parent.job_id).unwrap().sequence,
        f.parent.sequence
    );
    assert_eq!(f.attach(limits()).unwrap(), policy);
    let increased = MigrationResourceLimits {
        max_total_bytes: 8 * 1024 * 1024,
        ..limits()
    };
    let receipt = f
        .store
        .raise_batch_resource_budget(
            &f.parent.job_id,
            f.parent.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "original_policy_raise",
            0,
            increased,
            true,
        )
        .unwrap();
    assert_eq!(receipt.revision, 1);
    assert_eq!(f.history.read(&f.child).unwrap(), before);
    let after = f.store.read(&f.parent.job_id).unwrap();
    assert_eq!(after.status, MigrationJobStatus::Completed);
    assert_eq!(after.sequence, f.parent.sequence);
    assert_eq!(after.receipts, f.parent.receipts);
    assert_eq!(
        f.history
            .resource_budget_owner(&f.child)
            .unwrap()
            .as_deref(),
        Some(f.parent.job_id.as_str())
    );
}

#[test]
fn a_normalized_child_with_a_live_execution_lease_still_blocks_parent_attachment() {
    let f = Fixture::new();
    f.legacy(false);
    let before = f.history.read(&f.child).unwrap();
    assert_eq!(before.stage, HistoryImportStage::Normalized);
    let owner = f
        .history
        .claim_execution(&f.child, before.sequence)
        .unwrap();
    assert_eq!(
        f.attach(limits()).unwrap_err().to_string(),
        "history_job_execution_busy"
    );
    assert!(
        f.history
            .archives
            .recorded_resource_budget(&f.parent.job_id)
            .unwrap()
            .is_none()
    );
    assert!(
        !f.history
            .has_parent_resource_intent(&f.parent.job_id)
            .unwrap()
    );
    assert_eq!(
        f.history.execution_state(&f.child).unwrap(),
        HistoryExecutionState::Running
    );
    drop(owner);
}

#[test]
fn an_accepted_parent_group_lost_reply_reconciles_the_original_intent_without_recreating_it() {
    let f = Fixture::new();
    f.legacy(false);
    LOSE_NEXT_PARENT_GROUP_REPLY.with(|flag| flag.set(true));
    assert_eq!(
        f.attach(limits()).unwrap_err().to_string(),
        "history_resource_parent_preparation_unknown"
    );
    let original = f
        .history
        .archives
        .recorded_resource_budget(&f.parent.job_id)
        .unwrap()
        .unwrap();
    assert!(
        f.store
            .read(&f.parent.job_id)
            .unwrap()
            .batch
            .unwrap()
            .resource_limits
            .is_none()
    );
    let mut changed = limits();
    changed.max_payload_files += 1;
    assert!(f.attach(changed).is_err());
    let _ = f.attach(limits()).unwrap();
    assert_eq!(
        f.history
            .archives
            .recorded_resource_budget(&f.parent.job_id)
            .unwrap(),
        Some(original)
    );
    assert_eq!(
        f.store.read(&f.parent.job_id).unwrap().sequence,
        f.parent.sequence
    );
}

#[test]
fn attachment_read_recovers_the_frozen_parent_intent_after_a_lost_group_reply() {
    use crate::history_jobs::ResourceAttachmentPhase;
    let f = Fixture::new();
    f.legacy(false);
    let absent = f.store.resource_attachment(&f.parent.job_id).unwrap();
    assert_eq!(absent.phase, ResourceAttachmentPhase::Untracked);
    assert!(absent.original_intent.is_none());
    LOSE_NEXT_PARENT_GROUP_REPLY.with(|flag| flag.set(true));
    assert!(f.attach(limits()).is_err());
    let marker = f
        .profile
        .path()
        .join("migrations/history")
        .join(format!("{}.resource-parent.birth", f.parent.job_id));
    let before = fs::read(&marker).unwrap();
    let pending = f.store.resource_attachment(&f.parent.job_id).unwrap();
    assert_eq!(pending.phase, ResourceAttachmentPhase::Pending);
    let original = pending.original_intent.unwrap();
    assert_eq!(original.expected_sequence, f.parent.sequence);
    assert_eq!(
        original.plan_id.as_deref(),
        f.parent.batch.as_ref().unwrap().plan_id.as_deref()
    );
    assert_eq!(original.initial_limits, limits());
    assert_eq!(
        fs::read(&marker).unwrap(),
        before,
        "observation does not finish the intent"
    );
    fs::remove_dir_all(f.source.path().join("projects")).unwrap();
    f.attach(limits()).unwrap();
    let attached = f.store.resource_attachment(&f.parent.job_id).unwrap();
    assert_eq!(attached.phase, ResourceAttachmentPhase::Attached);
    assert_eq!(attached.original_intent, Some(original));
    assert_eq!(attached.current_sequence, f.parent.sequence);
}

#[test]
fn attachment_read_does_not_repair_a_born_parent_with_a_missing_group() {
    use crate::history_jobs::ResourceAttachmentPhase;
    let f = Fixture::new();
    f.legacy(false);
    f.attach(limits()).unwrap();
    let ledger = f
        .profile
        .path()
        .join("external-history/managed-v2/lifecycle.json");
    let mut body = read(&ledger);
    body["resource_groups"] = json!({});
    write(&ledger, &body);
    let before = fs::read(&ledger).unwrap();
    let observed = f.store.resource_attachment(&f.parent.job_id).unwrap();
    assert_eq!(observed.phase, ResourceAttachmentPhase::Unknown);
    assert_eq!(observed.issue_code, Some("history_resource_ledger_missing"));
    assert!(observed.original_intent.is_some());
    assert_eq!(fs::read(&ledger).unwrap(), before);
}

#[test]
fn attachment_read_never_recreates_a_missing_parent_coordinator() {
    let f = Fixture::new();
    let directory = f.profile.path().join("migrations");
    let original = directory.join(".lock");
    let held = directory.join(".owned-held-lock");
    std::fs::rename(&original, &held).unwrap();
    assert_eq!(
        f.store
            .resource_attachment(&f.parent.job_id)
            .unwrap_err()
            .to_string(),
        "history_resource_parent_unknown"
    );
    assert!(
        !original.exists(),
        "a readonly observation cannot replace the original coordinator"
    );
    std::fs::rename(held, original).unwrap();
    assert_eq!(
        f.store.read(&f.parent.job_id).unwrap().sequence,
        f.parent.sequence
    );
}
