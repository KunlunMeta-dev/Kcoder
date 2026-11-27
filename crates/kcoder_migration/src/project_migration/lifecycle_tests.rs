use super::{
    binding::ProjectRegistryCapture, plan::ProjectAssociationPlan, target::ProjectTargetSelection,
    *,
};
use kcoder_config::{
    PrivateDirectory,
    imported_projects::{ImportedProjectAssociationsStore, ProjectWorkspaceRegistry},
};
use kcoder_types::imported_projects::ImportedProjectReceiptStage;
use std::{ffi::OsStr, path::PathBuf};

struct Fixture {
    root: tempfile::TempDir,
    profile: PathBuf,
    source: PathBuf,
    target: PathBuf,
    second_root: PathBuf,
    user_registry: Vec<u8>,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let source = root.path().join("source-registry");
        let target = root.path().join("target-existing");
        let second_root = root.path().join("target-second-root");
        for path in [&profile, &source, &target, &second_root] {
            PrivateDirectory::open_or_create(path).unwrap();
        }
        std::fs::write(target.join("USER_FILE"), b"NOT_COPIED_OR_DELETED").unwrap();
        let mut trust = kcoder_config::FolderTrustStore::load(&profile);
        trust.trust(&target).unwrap();
        trust.trust(&second_root).unwrap();
        let first = target.to_str().unwrap();
        let second = second_root.to_str().unwrap();
        let user_registry = serde_json::to_vec(&serde_json::json!({"version":1,"projectOrder":["native-project"],"pinnedTasks":["KEEP"],"records":{
            first:{"workspacePath":first,"label":"User title","projectKey":"native-project","roots":[first,second],"appearance":{"keep":true},"pinned":true},
            second:{"workspacePath":second,"label":"User title","projectKey":"native-project","roots":[first,second],"appearance":{"keep":true},"pinned":true}}})).unwrap();
        let parent = PrivateDirectory::open_existing(&profile).unwrap();
        parent
            .atomic_replace(OsStr::new("client-workspaces.json"), &user_registry)
            .unwrap();
        parent
            .open_read_write_file(OsStr::new("client-workspaces.lock"), true)
            .unwrap();
        Self {
            root,
            profile,
            source,
            target,
            second_root,
            user_registry,
        }
    }
    fn claude(&self, name: &str) -> ProjectBatchSource {
        let bytes = serde_json::to_vec(&serde_json::json!({"oauthAccount":{"secret":"PRIVATE_OAUTH_MUST_NOT_LEAVE"},"projects":{format!("/source-not-opened/{name}"):{"mcpServers":{"never-execute":{}}}}})).unwrap();
        PrivateDirectory::open_existing(&self.source)
            .unwrap()
            .atomic_replace(OsStr::new(".claude.json"), &bytes)
            .unwrap();
        let capture = ProjectRegistryCapture::capture_claude_registry_directory(
            &self.source,
            &ProjectReadCancellation::default(),
        )
        .unwrap();
        capture
            .selected(
                &capture.records()[0].id,
                &ProjectReadCancellation::default(),
            )
            .unwrap()
    }
    fn codex(&self) -> ProjectBatchSource {
        let db = rusqlite::Connection::open(self.source.join("state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,metadata TEXT,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL); CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(project_id,position)); INSERT INTO projects VALUES('original','Source name','DO_NOT_EXPORT_METADATA',0,123,456); INSERT INTO project_roots VALUES('original',0,'/source-not-opened/first'),('original',1,'D:\\source-not-opened-second');").unwrap();
        drop(db);
        let capture = ProjectRegistryCapture::capture_codex_product_directory(
            &self.source,
            &ProjectReadCancellation::default(),
        )
        .unwrap();
        capture
            .selected("original", &ProjectReadCancellation::default())
            .unwrap()
    }
    fn registered(&self, source: &ProjectBatchSource) -> ProjectTargetSelection {
        let registry = ProjectWorkspaceRegistry::open_native(&self.profile).unwrap();
        ProjectTargetSelection::registered(
            &self.profile,
            registry.pin("native-project").unwrap(),
            source,
            &(0..source.record().roots.len())
                .map(|index| (index, index))
                .collect::<Vec<_>>(),
        )
        .unwrap()
    }
    fn unchanged(&self) {
        assert_eq!(
            std::fs::read(self.target.join("USER_FILE")).unwrap(),
            b"NOT_COPIED_OR_DELETED"
        );
        assert_eq!(
            std::fs::read(self.profile.join("client-workspaces.json")).unwrap(),
            self.user_registry
        );
    }
}

#[test]
fn two_vendors_prepare_associate_reopen_original_receipts_and_owned_undo_after_source_loss() {
    for kind in ["claude", "codex"] {
        let f = Fixture::new();
        let source = if kind == "claude" {
            f.claude("first")
        } else {
            f.codex()
        };
        let selection = f.registered(&source);
        let plan = ProjectAssociationPlan::prepare(
            &f.profile,
            "mig-original",
            "action-original",
            &source,
            selection,
            &ProjectReadCancellation::default(),
        )
        .unwrap();
        assert!(
            ImportedProjectAssociationsStore::open(&f.profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        let frozen_plan = serde_json::to_vec(&plan).unwrap();
        let frozen_source = serde_json::to_vec(&source).unwrap();
        assert!(
            !String::from_utf8(frozen_plan.clone())
                .unwrap()
                .contains("PRIVATE_OAUTH_MUST_NOT_LEAVE")
        );
        plan.publish(&f.profile, &source, &ProjectReadCancellation::default())
            .unwrap();
        std::fs::rename(&f.source, f.root.path().join("source-withheld")).unwrap();
        let reopened: ProjectAssociationPlan = serde_json::from_slice(&frozen_plan).unwrap();
        let original: ProjectBatchSource = serde_json::from_slice(&frozen_source).unwrap();
        assert_eq!(
            reopened.read_receipt(&f.profile).unwrap().unwrap().stage,
            ImportedProjectReceiptStage::Associated
        );
        let cancelled = ProjectReadCancellation::default();
        cancelled.cancel();
        assert_eq!(
            reopened
                .publish(&f.profile, &original, &cancelled)
                .unwrap()
                .stage,
            ImportedProjectReceiptStage::Associated
        );
        assert_eq!(
            reopened.undo(&f.profile).unwrap().stage,
            ImportedProjectReceiptStage::Removed
        );
        assert_eq!(
            reopened.undo(&f.profile).unwrap().stage,
            ImportedProjectReceiptStage::Removed
        );
        assert!(
            reopened
                .publish(&f.profile, &original, &ProjectReadCancellation::default())
                .is_err()
        );
        assert!(
            ImportedProjectAssociationsStore::open(&f.profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        f.unchanged();
    }
}
#[test]
fn source_target_or_trust_change_and_cancellation_before_publication_have_no_association_effect() {
    for boundary in ["source", "target", "trust", "cancel"] {
        let f = Fixture::new();
        let source = f.claude("first");
        let selection = f.registered(&source);
        let plan = ProjectAssociationPlan::prepare(
            &f.profile,
            "mig-original",
            "action-original",
            &source,
            selection,
            &ProjectReadCancellation::default(),
        )
        .unwrap();
        let cancel = ProjectReadCancellation::default();
        match boundary {
            "source" => {
                f.claude("changed");
            }
            "target" => {
                std::fs::rename(&f.second_root, f.root.path().join("old-second")).unwrap();
                PrivateDirectory::open_or_create(&f.second_root).unwrap();
                // This source has one root; replace the actual mapped primary too.
                std::fs::rename(&f.target, f.root.path().join("old-primary")).unwrap();
                PrivateDirectory::open_or_create(&f.target).unwrap();
            }
            "trust" => kcoder_config::FolderTrustStore::load(&f.profile)
                .revoke(&f.target)
                .unwrap(),
            "cancel" => cancel.cancel(),
            _ => unreachable!(),
        }
        assert!(plan.publish(&f.profile, &source, &cancel).is_err());
        assert!(plan.read_receipt(&f.profile).unwrap().is_none());
        assert!(
            ImportedProjectAssociationsStore::open(&f.profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            std::fs::read(f.profile.join("client-workspaces.json")).unwrap(),
            f.user_registry
        );
    }
}
#[test]
fn source_selection_and_mapping_are_bound_together_and_never_silently_reused_for_another_capture() {
    let f = Fixture::new();
    let first = f.claude("first");
    let selection = f.registered(&first);
    let second = f.claude("second");
    assert!(
        ProjectAssociationPlan::prepare(
            &f.profile,
            "mig-wrong",
            "action-wrong",
            &second,
            selection,
            &ProjectReadCancellation::default()
        )
        .is_err()
    );
    assert!(
        ImportedProjectAssociationsStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    f.unchanged();
}
#[test]
fn multi_root_order_is_explicit_and_same_owner_receipts_do_not_grant_peer_undo() {
    let f = Fixture::new();
    let source = f.codex();
    let registry = ProjectWorkspaceRegistry::open_native(&f.profile).unwrap();
    assert!(
        ProjectTargetSelection::registered(
            &f.profile,
            registry.pin("native-project").unwrap(),
            &source,
            &[(0, 0)]
        )
        .is_err()
    );
    assert!(
        ProjectTargetSelection::registered(
            &f.profile,
            registry.pin("native-project").unwrap(),
            &source,
            &[(0, 0), (1, 0)]
        )
        .is_err()
    );
    let selection = ProjectTargetSelection::registered(
        &f.profile,
        registry.pin("native-project").unwrap(),
        &source,
        &[(1, 0), (0, 1)],
    )
    .unwrap();
    let plan = ProjectAssociationPlan::prepare(
        &f.profile,
        "mig-original",
        "action-original",
        &source,
        selection,
        &ProjectReadCancellation::default(),
    )
    .unwrap();
    assert_eq!(plan.record().target.roots[0].target_root, f.second_root);
    assert_eq!(plan.record().target.roots[1].target_root, f.target);
    plan.publish(&f.profile, &source, &ProjectReadCancellation::default())
        .unwrap();
    let mut forged = serde_json::to_value(&plan).unwrap();
    forged["record"]["owner"]["operationId"] = "mig-peer".into();
    let forged: ProjectAssociationPlan = serde_json::from_value(forged).unwrap();
    assert!(forged.undo(&f.profile).is_err());
    assert_eq!(
        ImportedProjectAssociationsStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .len(),
        1
    );
    plan.undo(&f.profile).unwrap();
    f.unchanged();
}

#[test]
fn ordinary_batches_publish_reopen_reuse_and_undo_only_the_owned_project_association() {
    use crate::{
        assets::AssetTarget,
        batch::{BatchPlanPolicy, BatchResolution, BatchSource, projects::ProjectBatchResolution},
        mcp::McpTarget,
        providers::ProviderTarget,
        store::{BatchTargets, MigrationStore},
    };
    use kcoder_types::{
        migration::{MigrationItemStatus as ItemStatus, MigrationJobStatus as Status},
        migration_projects::*,
    };
    for codex in [false, true] {
        let f = Fixture::new();
        let source = if codex {
            f.codex()
        } else {
            f.claude("ordinary")
        };
        let registry = ProjectWorkspaceRegistry::open_native(&f.profile).unwrap();
        let catalog =
            ProjectTargetCatalog::capture(&f.profile, &f.target, "native-project", Some(&registry))
                .unwrap();
        let target = catalog.page(&f.profile, 0).unwrap().items.remove(0);
        let roots = catalog.roots(&f.profile, &target.target_handle, 0).unwrap();
        let mapping = MigrationProjectMappingChoice {
            target_catalog_id: catalog.id().to_owned(),
            target_handle: target.target_handle,
            mappings: source
                .record()
                .roots
                .iter()
                .enumerate()
                .map(|(i, _)| MigrationProjectRootMapping {
                    source_root_id: source.source_root_id(i).unwrap(),
                    target_root_handle: roots.roots[i].target_root_handle.clone(),
                })
                .collect(),
        };
        let provider = ProviderTarget::open(&f.profile).unwrap();
        let mcp = McpTarget::open(&f.profile).unwrap();
        let assets = AssetTarget::open(&f.profile).unwrap();
        let targets = BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            credentials: None,
            history: None,
        };
        let store = MigrationStore::open_or_create(&f.profile).unwrap();
        let prepare = |reuse| {
            let job = store
                .create_batch_scan(vec![BatchSource::Project(Box::new(source.clone()))])
                .unwrap();
            assert!(crate::batch::default_resolution(&job, &job.inventory.items[0]).is_none());
            let selection = catalog.resolve(&f.profile, &source, &mapping).unwrap();
            let choices = [BatchResolution::Project(Box::new(ProjectBatchResolution {
                item_id: job.inventory.items[0].preview.id.clone(),
                selection,
                mapping: mapping.clone(),
            }))];
            store
                .prepare_batch_with_policy(
                    &job.job_id,
                    job.sequence,
                    &choices,
                    &targets,
                    &BatchPlanPolicy {
                        reuse_existing: reuse,
                        ..Default::default()
                    },
                )
                .unwrap()
        };
        let run = |job: &crate::store::MigrationJob, undo, request: &str| {
            store
                .run_batch(
                    &job.job_id,
                    job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                    request,
                    job.sequence,
                    undo,
                    &targets,
                )
                .unwrap()
        };
        let first = prepare(false);
        assert!(
            ImportedProjectAssociationsStore::open(&f.profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        let first = run(&first, false, "first-apply");
        assert_eq!(first.status, Status::Completed);
        assert_eq!(first.receipts.len(), 1);
        assert!(first.receipts[0].ownership_confirmed);
        let peer = run(&prepare(true), false, "peer-apply");
        assert_eq!(peer.inventory.items[0].preview.status, ItemStatus::Skipped);
        assert!(!peer.receipts[0].ownership_confirmed);
        std::fs::rename(&f.source, f.root.path().join("source-withheld")).unwrap();
        let first = MigrationStore::open_existing(&f.profile)
            .unwrap()
            .read(&first.job_id)
            .unwrap();
        let blocked = run(&first, true, "first-undo-blocked");
        assert_eq!(blocked.status, Status::RollbackConflict);
        assert_eq!(
            blocked.batch.as_ref().unwrap().actions[0].error.as_deref(),
            Some("migration_result_referenced")
        );
        assert_eq!(
            ImportedProjectAssociationsStore::open(&f.profile)
                .unwrap()
                .list()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(run(&peer, true, "peer-release").status, Status::RolledBack);
        assert_eq!(
            run(&blocked, true, "first-undo-after-release").status,
            Status::RolledBack
        );
        assert!(
            ImportedProjectAssociationsStore::open(&f.profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            std::fs::read(f.target.join("USER_FILE")).unwrap(),
            b"NOT_COPIED_OR_DELETED"
        );
        assert_eq!(
            std::fs::read(f.profile.join("client-workspaces.json")).unwrap(),
            f.user_registry
        );
    }
}

#[test]
fn an_observed_target_catalog_never_rebinds_a_replacement_and_native_contexts_stay_separate() {
    use kcoder_types::migration_projects::{
        MigrationProjectMappingChoice, MigrationProjectRootMapping,
    };
    let f = Fixture::new();
    let source = f.claude("catalog-fence");
    let registry = ProjectWorkspaceRegistry::open_native(&f.profile).unwrap();
    let catalog =
        ProjectTargetCatalog::capture(&f.profile, &f.target, "native-project", Some(&registry))
            .unwrap();
    let target = catalog.page(&f.profile, 0).unwrap().items.remove(0);
    let roots = catalog.roots(&f.profile, &target.target_handle, 0).unwrap();
    let mapping = MigrationProjectMappingChoice {
        target_catalog_id: catalog.id().to_owned(),
        target_handle: target.target_handle.clone(),
        mappings: vec![MigrationProjectRootMapping {
            source_root_id: source.source_root_id(0).unwrap(),
            target_root_handle: roots.roots[0].target_root_handle.clone(),
        }],
    };
    let selected = catalog.resolve(&f.profile, &source, &mapping).unwrap();
    selected
        .verify_host_context(&f.profile, &f.target, Some(&f.profile))
        .unwrap();
    let peer = f.root.path().join("peer-native-registry");
    PrivateDirectory::open_or_create(&peer).unwrap();
    assert!(
        selected
            .verify_host_context(&f.profile, &f.target, Some(&peer))
            .is_err()
    );
    std::fs::rename(&f.target, f.root.path().join("original-target")).unwrap();
    PrivateDirectory::open_or_create(&f.target).unwrap();
    assert!(
        !catalog
            .roots(&f.profile, &target.target_handle, 0)
            .unwrap()
            .roots[0]
            .available
    );
    assert!(catalog.resolve(&f.profile, &source, &mapping).is_err());
    assert!(
        ImportedProjectAssociationsStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        std::fs::read(f.root.path().join("original-target/USER_FILE")).unwrap(),
        b"NOT_COPIED_OR_DELETED"
    );
}
