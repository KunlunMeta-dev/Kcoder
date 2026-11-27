use super::*;
use crate::{
    assets::AssetTarget,
    batch::{BatchResolution, BatchSource, projects::ProjectBatchResolution},
    mcp::McpTarget,
    project_migration::*,
    providers::ProviderTarget,
    store::{BatchTargets, MigrationStore},
};
use kcoder_config::imported_projects::{
    ImportedProjectAssociationsStore, ProjectWorkspaceRegistry,
};
use kcoder_types::{
    migration::{MigrationItemStatus, MigrationJobStatus},
    migration_projects::*,
};

fn selected(f: &Fixture, kind: Kind) -> ProjectBatchSource {
    std::fs::write(f.files.join("auth.json"), b"PRIVATE_AUTH_MUST_NOT_LEAVE").unwrap();
    let capture = if kind == Kind::ClaudeCode {
        std::fs::write(f.files.join(".claude.json"),br#"{"oauthAccount":{"token":"PRIVATE_AUTH_MUST_NOT_LEAVE"},"projects":{"/foreign/project-never-opened":{"secret":"PRIVATE_OTHER_FIELDS","hasTrustDialogAccepted":true}}}"#).unwrap();
        ProjectRegistryCapture::capture_claude_registry_directory(&f.files, &Default::default())
            .unwrap()
    } else {
        let db = rusqlite::Connection::open(f.files.join("state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,metadata TEXT,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL);CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(project_id,position));CREATE TABLE private_tokens(token TEXT);INSERT INTO private_tokens VALUES('PRIVATE_UNRELATED_TABLE');INSERT INTO projects VALUES('original-project','Original source label','PRIVATE_OTHER_FIELDS',7,123,456);INSERT INTO project_roots VALUES('original-project',0,'D:\\foreign\\project-never-opened');").unwrap();
        drop(db);
        ProjectRegistryCapture::capture_codex_product_directory(&f.files, &Default::default())
            .unwrap()
    };
    capture
        .selected(&capture.records()[0].id, &Default::default())
        .unwrap()
}
#[test]
fn two_project_registries_transfer_only_the_known_projection_adopt_and_use_normal_mapping_publish_and_undo()
 {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let f = Fixture::new();
        let source = selected(&f, kind);
        let original = source.record().clone();
        let manifest = f.export(ExportSelection::Project(source));
        assert_eq!(manifest.entries.len(), 1);
        assert!(matches!(
            manifest.entries[0].content,
            TransferContent::ProjectInventory { .. }
        ));
        let chunk = f
            .source
            .chunk(
                &f.request,
                &f.destination,
                &manifest.digest().unwrap(),
                &manifest.entries[0].id,
                0,
            )
            .unwrap();
        let text = std::str::from_utf8(chunk.bytes()).unwrap();
        assert!(!text.contains("PRIVATE_"));
        assert!(!text.contains("SQLite format"));
        assert!(!text.contains(f.files.to_str().unwrap()));
        let value: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 5);
        let receipt = f.copy(&manifest);
        let page = f
            .target
            .received_sources(&f.request, &receipt.manifest_sha256, 0)
            .unwrap();
        assert_eq!(page.items[0].class, ReceivedSourceClass::Project);
        assert!(!page.items[0].project_scoped);
        assert!(page.items[0].project.is_some());
        std::fs::rename(&f.files, f._root.path().join("source-withheld")).unwrap();
        let adoption = uuid::Uuid::new_v4().to_string();
        let selections = vec![ReceivedAdoptionSelection {
            entry_id: manifest.entries[0].id.clone(),
            project_mapping: None,
        }];
        let (_, owner) = f
            .target
            .prepare_adoption(
                &f.request,
                &adoption,
                &receipt.manifest_sha256,
                selections,
                None,
            )
            .unwrap();
        let adopted = f.target.execute_adoption(owner.unwrap(), |_| true).unwrap();
        assert_eq!(adopted.phase, ReceivedAdoptionPhase::PreviewReady);
        assert_eq!(adopted.jobs.len(), 1);
        let store = MigrationStore::open_existing(&f.target_profile).unwrap();
        let job = store.read(&adopted.jobs[0].job_id).unwrap();
        let BatchSource::Project(binding) = job
            .batch
            .as_ref()
            .unwrap()
            .source_for(&job.inventory.items[0].preview.id)
            .unwrap()
        else {
            panic!("wrong received source class")
        };
        assert!(binding.record() == &original);
        assert!(
            !serde_json::to_string(binding)
                .unwrap()
                .contains(f.files.to_str().unwrap())
        );
        let another = f._root.path().join("another-target-profile");
        PrivateDirectory::open_or_create(&another).unwrap();
        let other = MigrationStore::open_or_create(&another).unwrap();
        assert!(
            other
                .create_batch_scan(vec![BatchSource::Project(binding.clone())])
                .is_err()
        );
        let workspace = f._root.path().join("target-workspace");
        PrivateDirectory::open_or_create(&workspace).unwrap();
        std::fs::write(workspace.join("USER_FILE"), b"KEEP_USER_FILE").unwrap();
        kcoder_config::FolderTrustStore::load(&f.target_profile)
            .trust(&workspace)
            .unwrap();
        let workspace_text = workspace.to_str().unwrap();
        let original_registry=serde_json::json!({"version":1,"projectOrder":["user-project"],"records":{workspace_text:{"workspacePath":workspace,"label":"User native label","projectKey":"user-project","roots":[workspace],"appearance":{"keep":true}}}}).to_string();
        let parent = PrivateDirectory::open_existing(&f.target_profile).unwrap();
        parent
            .atomic_replace(
                OsStr::new("client-workspaces.json"),
                original_registry.as_bytes(),
            )
            .unwrap();
        parent
            .open_read_write_file(OsStr::new("client-workspaces.lock"), true)
            .unwrap();
        let registry = ProjectWorkspaceRegistry::open_native(&f.target_profile).unwrap();
        let catalog = ProjectTargetCatalog::capture(
            &f.target_profile,
            &workspace,
            "user-project",
            Some(&registry),
        )
        .unwrap();
        let target = catalog.page(&f.target_profile, 0).unwrap().items.remove(0);
        let roots = catalog
            .roots(&f.target_profile, &target.target_handle, 0)
            .unwrap();
        let mapping = MigrationProjectMappingChoice {
            target_catalog_id: catalog.id().to_owned(),
            target_handle: target.target_handle,
            mappings: vec![MigrationProjectRootMapping {
                source_root_id: binding.source_root_id(0).unwrap(),
                target_root_handle: roots.roots[0].target_root_handle.clone(),
            }],
        };
        let selection = catalog
            .resolve(&f.target_profile, binding, &mapping)
            .unwrap();
        let choices = [BatchResolution::Project(Box::new(ProjectBatchResolution {
            item_id: job.inventory.items[0].preview.id.clone(),
            selection,
            mapping,
        }))];
        let provider = ProviderTarget::open(&f.target_profile).unwrap();
        let mcp = McpTarget::open(&f.target_profile).unwrap();
        let assets = AssetTarget::open(&f.target_profile).unwrap();
        let targets = BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            credentials: None,
            history: None,
        };
        let planned = store
            .prepare_batch(&job.job_id, job.sequence, &choices, &targets)
            .unwrap();
        assert!(
            ImportedProjectAssociationsStore::open(&f.target_profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        let applied = store
            .run_batch(
                &planned.job_id,
                planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                "project-apply",
                planned.sequence,
                false,
                &targets,
            )
            .unwrap();
        assert_eq!(applied.status, MigrationJobStatus::Completed);
        assert_eq!(
            applied.inventory.items[0].preview.status,
            MigrationItemStatus::Committed
        );
        let reopened = MigrationStore::open_existing(&f.target_profile)
            .unwrap()
            .read(&applied.job_id)
            .unwrap();
        let undone = store
            .run_batch(
                &reopened.job_id,
                reopened.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                "project-undo",
                reopened.sequence,
                true,
                &targets,
            )
            .unwrap();
        assert_eq!(undone.status, MigrationJobStatus::RolledBack);
        assert!(
            ImportedProjectAssociationsStore::open(&f.target_profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            std::fs::read(workspace.join("USER_FILE")).unwrap(),
            b"KEEP_USER_FILE"
        );
        assert_eq!(
            std::fs::read_to_string(f.target_profile.join("client-workspaces.json")).unwrap(),
            original_registry
        );
    }
}
