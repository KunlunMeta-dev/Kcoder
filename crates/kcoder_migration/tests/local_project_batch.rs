use kcoder_config::PrivateDirectory;
use kcoder_migration::{
    assets::AssetTarget,
    batch::{BatchResolution, BatchSource},
    discovery::{DiscoveryRoots, SourceRegistry},
    mcp::{McpResolution, McpTarget},
    providers::ProviderTarget,
    store::{BatchTargets, MigrationStore},
};
use kcoder_types::migration::MigrationSourceKind;
use serde_json::json;

struct Fixture {
    _root: tempfile::TempDir,
    profile: std::path::PathBuf,
    project: std::path::PathBuf,
    source: std::path::PathBuf,
    inputs: Vec<BatchSource>,
}
fn fixture(trusted: bool) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let project = root.path().join("workspace");
    let source = root.path().join("claude");
    PrivateDirectory::open_or_create(&profile).unwrap();
    std::fs::create_dir(&project).unwrap();
    std::fs::create_dir(&source).unwrap();
    std::fs::write(profile.join("settings.json"), r#"{"mcp_servers":[]}"#).unwrap();
    if trusted {
        std::fs::write(
            profile.join("trusted-folders.json"),
            serde_json::to_vec(&json!({"trusted":[project],"never":[]})).unwrap(),
        )
        .unwrap();
    }
    std::fs::write(
        source.join("settings.json"),
        r#"{"mcpServers":{"docs":{"command":"NEVER_RUN_LOCAL_PROJECT_FIXTURE"}}}"#,
    )
    .unwrap();
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: root.path().to_owned(),
        claude_config_dir: Some(source.clone()),
        codex_home: None,
        project: None,
    });
    let found = registry
        .discover(&[MigrationSourceKind::ClaudeCode], false)
        .0;
    let entry = found.iter().find(|entry| entry.scope == "user").unwrap();
    let inputs = vec![BatchSource::Configuration(
        registry.selected(&entry.source_id).unwrap(),
    )];
    Fixture {
        _root: root,
        profile,
        project,
        source,
        inputs,
    }
}

#[test]
fn local_project_is_sealed_without_received_provenance_and_reopens_for_undo() {
    let f = fixture(true);
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    let job = store
        .create_batch_scan_in_project(f.inputs, &f.project)
        .unwrap();
    assert!(job.batch.as_ref().unwrap().received.is_none());
    let reopened = MigrationStore::open_existing(&f.profile)
        .unwrap()
        .read(&job.job_id)
        .unwrap();
    let binding = reopened.project_target().unwrap();
    assert_eq!(binding.root(), f.project.canonicalize().unwrap());
    let assets = AssetTarget::open(&f.profile).unwrap();
    let provider = ProviderTarget::open_project(&f.profile, binding, true).unwrap();
    let mcp = McpTarget::open_project(&f.profile, binding, true).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: None,
    };
    let item = job
        .inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap();
    let resolution = BatchResolution::Mcp(McpResolution {
        item_id: item.preview.id.clone(),
        target_name: "project-docs".into(),
        cwd: None,
        enable_after_import: false,
    });
    let wrong_provider = ProviderTarget::open(&f.profile).unwrap();
    let wrong_mcp = McpTarget::open(&f.profile).unwrap();
    let wrong = BatchTargets {
        provider: &wrong_provider,
        mcp: &wrong_mcp,
        assets: &assets,
        credentials: None,
        history: None,
    };
    assert!(
        store
            .prepare_batch(
                &job.job_id,
                job.sequence,
                std::slice::from_ref(&resolution),
                &wrong
            )
            .unwrap_err()
            .to_string()
            .contains("migration_wrong_target")
    );
    let planned = store
        .prepare_batch(&job.job_id, job.sequence, &[resolution], &targets)
        .unwrap();
    let plan = planned.batch.as_ref().unwrap().plan_id.as_ref().unwrap();
    assert!(
        store
            .run_batch(
                &job.job_id,
                plan,
                "wrong-target-request",
                planned.sequence,
                false,
                &wrong
            )
            .is_err()
    );
    let applied = store
        .run_batch(
            &job.job_id,
            plan,
            "project-apply-request",
            planned.sequence,
            false,
            &targets,
        )
        .unwrap();
    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.project.join(".kcoder/settings.json")).unwrap())
            .unwrap();
    assert_eq!(settings["mcp_servers"][0]["name"], "project-docs");
    assert_eq!(
        settings["mcp_servers"][0]["policy"]["workspace"],
        f.project.to_string_lossy().as_ref()
    );
    assert_eq!(
        std::fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        r#"{"mcp_servers":[]}"#
    );
    std::fs::remove_dir_all(&f.source).unwrap();
    drop(provider);
    drop(mcp);
    let stored = MigrationStore::open_existing(&f.profile)
        .unwrap()
        .read(&job.job_id)
        .unwrap();
    let provider =
        ProviderTarget::open_project(&f.profile, stored.project_target().unwrap(), false).unwrap();
    let mcp = McpTarget::open_project(&f.profile, stored.project_target().unwrap(), false).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: None,
    };
    store
        .run_batch(
            &job.job_id,
            plan,
            "project-undo-request",
            applied.sequence,
            true,
            &targets,
        )
        .unwrap();
    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.project.join(".kcoder/settings.json")).unwrap())
            .unwrap();
    assert!(
        settings
            .get("mcp_servers")
            .is_none_or(|value| value.as_array().is_some_and(Vec::is_empty))
    );
}

#[test]
fn local_project_requires_current_trust_and_original_directory_identity() {
    let f = fixture(false);
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    assert!(
        store
            .create_batch_scan_in_project(f.inputs.clone(), &f.project)
            .is_err()
    );
    std::fs::write(
        f.profile.join("trusted-folders.json"),
        serde_json::to_vec(&json!({"trusted":[f.project],"never":[]})).unwrap(),
    )
    .unwrap();
    let job = store
        .create_batch_scan_in_project(f.inputs, &f.project)
        .unwrap();
    std::fs::rename(&f.project, f.project.with_extension("original")).unwrap();
    std::fs::create_dir(&f.project).unwrap();
    assert!(ProviderTarget::open_project(&f.profile, job.project_target().unwrap(), true).is_err());
}

#[test]
fn local_destination_does_not_change_legacy_shape_or_survive_trust_revocation() {
    let f = fixture(true);
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    let legacy = store.create_batch_scan(f.inputs.clone()).unwrap();
    assert!(legacy.project_target().is_none());
    assert!(
        serde_json::to_value(&legacy).unwrap()["batch"]
            .get("localProject")
            .is_none()
    );
    let job = store
        .create_batch_scan_in_project(f.inputs, &f.project)
        .unwrap();
    let provider =
        ProviderTarget::open_project(&f.profile, job.project_target().unwrap(), true).unwrap();
    let mcp = McpTarget::open_project(&f.profile, job.project_target().unwrap(), true).unwrap();
    let assets = AssetTarget::open(&f.profile).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: None,
    };
    let item = job
        .inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap();
    let resolution = BatchResolution::Mcp(McpResolution {
        item_id: item.preview.id.clone(),
        target_name: "revoked-docs".into(),
        cwd: None,
        enable_after_import: false,
    });
    std::fs::write(
        f.profile.join("trusted-folders.json"),
        r#"{"trusted":[],"never":[]}"#,
    )
    .unwrap();
    assert!(
        store
            .prepare_batch(&job.job_id, job.sequence, &[resolution], &targets)
            .unwrap_err()
            .to_string()
            .contains("migration_project_target_untrusted")
    );
    assert_eq!(store.read(&job.job_id).unwrap().sequence, job.sequence);
    assert!(!f.project.join(".kcoder/settings.json").exists());
}
