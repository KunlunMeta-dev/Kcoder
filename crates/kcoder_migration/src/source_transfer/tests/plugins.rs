use super::*;
use crate::{
    assets::AssetTarget,
    batch::{BatchSource, default_resolution},
    mcp::McpTarget,
    plugin_migration::{
        PluginMigrationStore, PluginSourceProject, discover, discover_with_project,
    },
    providers::ProviderTarget,
    store::{BatchTargets, MigrationStore},
};
use kcoder_config::FolderTrustStore;
use kcoder_plugins::{PluginCancellationToken, PluginStore};
use kcoder_types::migration::MigrationJobStatus;
mod uploaded;

fn selection(
    f: &Fixture,
    kind: Kind,
    scope: &str,
) -> crate::plugin_migration::PluginExportSelection {
    let package = f.files.join("plugins/cache/market/sample/1.0.0");
    let format = if kind == Kind::ClaudeCode {
        ".claude-plugin"
    } else {
        ".codex-plugin"
    };
    std::fs::create_dir_all(package.join(format)).unwrap();
    std::fs::create_dir_all(package.join("skills/check")).unwrap();
    std::fs::write(
        package.join(format).join("plugin.json"),
        r#"{"name":"sample","version":"1.0.0"}"#,
    )
    .unwrap();
    std::fs::write(
        package.join("skills/check/SKILL.md"),
        "---\nname: check\ndescription: Inert fixture\n---\nNever execute this fixture.",
    )
    .unwrap();
    let source_project = f._root.path().join("source-project");
    PrivateDirectory::open_or_create(&source_project).unwrap();
    FolderTrustStore::load(&f.source_profile)
        .trust(&source_project)
        .unwrap();
    if kind == Kind::ClaudeCode {
        std::fs::write(f.files.join("plugins/installed_plugins.json"), serde_json::json!({"version":2,"plugins":{"sample@market":[{"scope":scope,"projectPath":source_project,"installPath":package,"version":"1.0.0"}]}}).to_string()).unwrap();
        std::fs::write(
            f.files.join("settings.json"),
            r#"{"enabledPlugins":{"sample@market":true}}"#,
        )
        .unwrap();
        std::fs::create_dir(source_project.join(".claude")).unwrap();
        std::fs::write(
            source_project.join(".claude/settings.json"),
            r#"{"enabledPlugins":{"sample@market":true}}"#,
        )
        .unwrap();
    } else if scope == "user" {
        std::fs::write(
            f.files.join("config.toml"),
            "[plugins.\"sample@market\"]\nenabled=true\n",
        )
        .unwrap();
    } else {
        std::fs::create_dir(source_project.join(".codex")).unwrap();
        std::fs::write(
            source_project.join(".codex/config.toml"),
            "[plugins.\"sample@market\"]\nenabled=true\n",
        )
        .unwrap();
    }
    let token = PluginCancellationToken::default();
    let catalog = if scope == "user" {
        discover(&f.files, kind, &token).unwrap()
    } else {
        let grant = PluginSourceProject::capture(&f.source_profile, &source_project, kind).unwrap();
        discover_with_project(&f.files, kind, &grant, &token).unwrap()
    };
    assert_eq!(catalog.candidates.len(), 1);
    catalog.candidates[0].export_selection().unwrap()
}

#[test]
fn both_plugin_formats_transfer_into_owned_previews_and_normal_disabled_install_and_undo() {
    for (kind, scope, uploaded) in [
        (Kind::ClaudeCode, "user", false),
        (Kind::Codex, "user", false),
        (Kind::ClaudeCode, "local", false),
        (Kind::Codex, "project", false),
        (Kind::ClaudeCode, "user", true),
        (Kind::Codex, "user", true),
        (Kind::ClaudeCode, "local", true),
    ] {
        let f = Fixture::new();
        let selected = if uploaded {
            uploaded::selection(&f, kind, scope)
        } else {
            selection(&f, kind, scope)
        };
        let manifest = f.export(ExportSelection::Plugin(selected));
        assert_eq!(
            manifest.entries[0].content.uploaded_source().is_some(),
            uploaded
        );
        if !uploaded {
            assert!(
                !serde_json::to_string(&manifest)
                    .unwrap()
                    .contains("uploadedSource")
            );
        }
        let receipt = f.copy(&manifest);
        let page = f
            .target
            .received_sources(&f.request, &receipt.manifest_sha256, 0)
            .unwrap();
        assert_eq!(page.items[0].class, ReceivedSourceClass::Plugin);
        assert_eq!(page.items[0].project_scoped, scope != "user");
        let workspace = f._root.path().join("target-workspace");
        PrivateDirectory::open_or_create(&workspace).unwrap();
        FolderTrustStore::load(&f.target_profile)
            .trust(&workspace)
            .unwrap();
        let project = (scope != "user")
            .then(|| ReceivedProjectTarget::capture(&f.target_profile, &workspace).unwrap());
        let chosen = vec![ReceivedAdoptionSelection {
            entry_id: manifest.entries[0].id.clone(),
            project_mapping: project
                .as_ref()
                .map(|_| ReceivedProjectMapping::CurrentWorkspace),
        }];
        let adoption = uuid::Uuid::new_v4().to_string();
        let (_, owner) = f
            .target
            .prepare_adoption(
                &f.request,
                &adoption,
                &receipt.manifest_sha256,
                chosen.clone(),
                project.clone(),
            )
            .unwrap();
        if uploaded {
            std::fs::rename(
                &f.source_profile,
                f._root.path().join("source-profile-withheld"),
            )
            .unwrap();
        } else {
            std::fs::remove_dir_all(&f.files).unwrap();
        }
        let ready = f.target.execute_adoption(owner.unwrap(), |_| true).unwrap();
        assert_eq!(
            ready.phase,
            ReceivedAdoptionPhase::PreviewReady,
            "{ready:?}"
        );
        let store = MigrationStore::open_existing(&f.target_profile).unwrap();
        let scan = store.read(&ready.jobs[0].job_id).unwrap();
        let BatchSource::Plugin(source) = &scan.batch.as_ref().unwrap().sources[0] else {
            panic!("expected plugin")
        };
        let operation = source.operation_id().to_owned();
        let native = PluginMigrationStore::open_existing(&f.target_profile)
            .unwrap()
            .unwrap();
        let child = native
            .read(&operation, &PluginCancellationToken::default())
            .unwrap();
        assert!(!child.imported);
        assert!(
            native
                .apply(
                    &operation,
                    child.sequence,
                    &PluginCancellationToken::default()
                )
                .is_err(),
            "an unclaimed received child is still owned by its preview"
        );
        let unrelated = if project.is_some() {
            store
                .create_batch_scan_in_project(vec![BatchSource::Plugin(source.clone())], &workspace)
        } else {
            store.create_batch_scan(vec![BatchSource::Plugin(source.clone())])
        }
        .unwrap();
        let provider = match &project {
            Some(project) => ProviderTarget::open_project(&f.target_profile, project, true),
            None => ProviderTarget::open(&f.target_profile),
        }
        .unwrap();
        let mcp = match &project {
            Some(project) => McpTarget::open_project(&f.target_profile, project, true),
            None => McpTarget::open(&f.target_profile),
        }
        .unwrap();
        let assets = AssetTarget::open(&f.target_profile).unwrap();
        let targets = BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            history: None,
            credentials: None,
        };
        let other_choices = unrelated
            .inventory
            .items
            .iter()
            .filter_map(|item| default_resolution(&unrelated, item))
            .collect::<Vec<_>>();
        let other_plan = store
            .prepare_batch(
                &unrelated.job_id,
                unrelated.sequence,
                &other_choices,
                &targets,
            )
            .unwrap();
        let other = store
            .run_batch(
                &other_plan.job_id,
                other_plan.batch.as_ref().unwrap().plan_id.as_ref().unwrap(),
                "cannot-steal-received",
                other_plan.sequence,
                false,
                &targets,
            )
            .unwrap();
        assert_eq!(other.status, MigrationJobStatus::CompletedWithIssues);
        assert!(
            !native
                .read(&operation, &PluginCancellationToken::default())
                .unwrap()
                .imported
        );
        let choices = scan
            .inventory
            .items
            .iter()
            .filter_map(|item| default_resolution(&scan, item))
            .collect::<Vec<_>>();
        assert_eq!(choices.len(), 1);
        let plan = store
            .prepare_batch(&scan.job_id, scan.sequence, &choices, &targets)
            .unwrap();
        let plan_id = plan.batch.as_ref().unwrap().plan_id.as_ref().unwrap();
        let done = store
            .run_batch(
                &plan.job_id,
                plan_id,
                "explicit-install",
                plan.sequence,
                false,
                &targets,
            )
            .unwrap();
        assert_eq!(
            done.status,
            MigrationJobStatus::Completed,
            "{:?}",
            done.inventory.issues
        );
        let child = native
            .read(&operation, &PluginCancellationToken::default())
            .unwrap();
        assert!(child.imported);
        let target = child.target_id.unwrap().parse().unwrap();
        let plugins =
            PluginStore::open_for_migration(&f.target_profile.join("plugin_store")).unwrap();
        let record = plugins.read(&target).unwrap().unwrap();
        assert!(!record.enabled_by_default);
        assert_eq!(record.project_identity.is_some(), scope != "user");
        let reopened = MigrationStore::open_existing(&f.target_profile).unwrap();
        assert_eq!(
            reopened.read(&plan.job_id).unwrap().status,
            MigrationJobStatus::Completed
        );
        let undone = reopened
            .run_batch(
                &plan.job_id,
                plan_id,
                "explicit-undo",
                done.sequence,
                true,
                &targets,
            )
            .unwrap();
        assert_eq!(undone.status, MigrationJobStatus::RolledBack);
        assert!(plugins.read(&target).unwrap().is_none());
        assert!(
            native
                .read(&operation, &PluginCancellationToken::default())
                .unwrap()
                .imported,
            "Imported remains an audit fact"
        );
    }
}

#[test]
fn plugin_publication_lost_selection_checkpoint_recovers_original_bytes_after_source_disappears() {
    let f = Fixture::new();
    let manifest = f.export(ExportSelection::Plugin(selection(
        &f,
        Kind::ClaudeCode,
        "user",
    )));
    let directory = PrivateDirectory::open_existing(
        &f.source_profile
            .join("migrations/source-transfer/exports")
            .join(&f.request),
    )
    .unwrap();
    // Keep the pre-publication FD proof and immutable payload, simulating missing later receipts.
    for name in ["selection-0000.json", "manifest.json", "receipt.json"] {
        directory.remove_regular_file(OsStr::new(name)).unwrap();
    }
    std::fs::remove_dir_all(&f.files).unwrap();
    let recovered = f
        .source
        .capture(&f.request, &f.destination, |_| true)
        .unwrap();
    assert!(recovered == manifest);
    let receipt = f.copy(&recovered);
    assert_eq!(receipt.manifest_sha256, recovered.digest().unwrap());
}

#[test]
fn received_plugin_cancellation_and_lost_preview_ack_keep_the_same_original_owner() {
    let f = Fixture::new();
    let manifest = f.export(ExportSelection::Plugin(selection(&f, Kind::Codex, "user")));
    let receipt = f.copy(&manifest);
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
            selections.clone(),
            None,
        )
        .unwrap();
    let cancelled = f
        .target
        .cancel_adoption(&f.request, &adoption, &uuid::Uuid::new_v4().to_string())
        .unwrap();
    assert_eq!(cancelled.cancel_requested, Some(true));
    let stopped = f.target.execute_adoption(owner.unwrap(), |_| true).unwrap();
    assert_eq!(stopped.phase, ReceivedAdoptionPhase::Cancelled);
    assert!(!f.target_profile.join("plugin_store").exists());
    let before = stopped.control.unwrap();
    let changed = f
        .target
        .cancel_adoption(&f.request, &adoption, &uuid::Uuid::new_v4().to_string())
        .unwrap();
    assert!(
        f.target
            .resume_adoption(&f.request, &adoption, before)
            .is_err()
    );
    let (_, owner) = f
        .target
        .resume_adoption(&f.request, &adoption, changed.control.unwrap())
        .unwrap();
    std::fs::remove_dir_all(&f.files).unwrap();
    crate::source_transfer::target::FAIL_AFTER_PREVIEW_PUBLICATION.with(|flag| flag.set(true));
    let interrupted = f.target.execute_adoption(owner, |_| true).unwrap();
    assert_ne!(interrupted.phase, ReceivedAdoptionPhase::PreviewReady);
    let store = MigrationStore::open_existing(&f.target_profile).unwrap();
    let saved = store.read(&interrupted.jobs[0].job_id).unwrap();
    let (_, duplicate) = f
        .target
        .prepare_adoption(
            &f.request,
            &adoption,
            &receipt.manifest_sha256,
            selections,
            None,
        )
        .unwrap();
    assert!(
        duplicate.is_none(),
        "prepare cannot silently resume the lost publication acknowledgement"
    );
    let (_, owner) = f
        .target
        .resume_adoption(&f.request, &adoption, interrupted.control.unwrap())
        .unwrap();
    let recovered = f.target.execute_adoption(owner, |_| true).unwrap();
    assert_eq!(recovered.phase, ReceivedAdoptionPhase::PreviewReady);
    assert_eq!(recovered.jobs[0].job_id, saved.job_id);
    let reopened = store.read(&saved.job_id).unwrap();
    assert!(serde_json::to_vec(&reopened).unwrap() == serde_json::to_vec(&saved).unwrap());
    assert!(!f.target_profile.join("plugin_store").exists());
}
