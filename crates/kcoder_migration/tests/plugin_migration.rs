use kcoder_migration::plugin_migration::{
    PluginMigrationStage as Stage, PluginMigrationStore, discover,
};
use kcoder_plugins::{PluginCancellationToken, PluginStore};
use kcoder_types::migration::MigrationSourceKind as Kind;
use std::path::{Path, PathBuf};
fn private(path: &Path) {
    kcoder_config::PrivateDirectory::open_or_create(path).unwrap();
}
fn package(path: &Path, kind: Kind, version: &str) {
    std::fs::create_dir_all(path.join(if kind == Kind::ClaudeCode {
        ".claude-plugin"
    } else {
        ".codex-plugin"
    }))
    .unwrap();
    std::fs::write(
        path.join(if kind == Kind::ClaudeCode {
            ".claude-plugin/plugin.json"
        } else {
            ".codex-plugin/plugin.json"
        }),
        serde_json::json!({"name":"sample","version":version}).to_string(),
    )
    .unwrap();
    std::fs::create_dir_all(path.join("skills/check")).unwrap();
    std::fs::write(path.join("skills/check/SKILL.md"),"---\nname: check\ndescription: Verify the supplied evidence\n---\nRead facts before drawing conclusions.").unwrap();
}
fn source(root: &Path, kind: Kind) -> PathBuf {
    let source = root.join(if kind == Kind::ClaudeCode {
        "claude"
    } else {
        "codex"
    });
    private(&source);
    let path = source.join("plugins/cache/market/sample/1.0.0");
    package(&path, kind, "1.0.0");
    if kind == Kind::ClaudeCode {
        std::fs::write(source.join("plugins/installed_plugins.json"),serde_json::json!({"version":2,"plugins":{"sample@market":[{"scope":"user","installPath":path,"version":"1.0.0"}]}}).to_string()).unwrap();
        std::fs::write(
            source.join("settings.json"),
            r#"{"enabledPlugins":{"sample@market":true}}"#,
        )
        .unwrap();
    } else {
        std::fs::write(
            source.join("config.toml"),
            "[plugins.\"sample@market\"]\nenabled = true\n",
        )
        .unwrap();
    }
    source
}
#[test]
fn declared_installation_paths_bind_the_granted_native_directories_not_path_spelling() {
    let temp = tempfile::tempdir().unwrap();
    let root = source(temp.path(), Kind::ClaudeCode);
    // On Windows this grant is verbatim while installed_plugins.json keeps the ordinary path.
    let canonical = root.canonicalize().unwrap();
    let token = PluginCancellationToken::default();
    let catalog = discover(&canonical, Kind::ClaudeCode, &token).unwrap();
    assert_eq!(catalog.candidates.len(), 1);
    assert!(catalog.candidates[0].pending.is_empty());

    let outside = temp.path().join("other");
    private(&outside);
    let outside_package = outside.join("plugins/cache/market/sample/1.0.0");
    package(&outside_package, Kind::ClaudeCode, "1.0.0");
    for declared in [
        outside_package,
        root.join("plugins/cache/market/sample/../sample/1.0.0"),
        PathBuf::from("plugins/cache/market/sample/1.0.0"),
    ] {
        std::fs::write(
            root.join("plugins/installed_plugins.json"),
            serde_json::json!({"version":2,"plugins":{"sample@market":[{
                "scope":"user","installPath":declared,"version":"1.0.0"
            }]}})
            .to_string(),
        )
        .unwrap();
        let catalog = discover(&canonical, Kind::ClaudeCode, &token).unwrap();
        assert!(
            catalog.candidates[0]
                .pending
                .contains(&"plugin_install_path_requires_grant".into())
        );
    }
}

#[cfg(unix)]
#[test]
fn a_declared_installation_symlink_never_inherits_the_granted_root() {
    let temp = tempfile::tempdir().unwrap();
    let root = source(temp.path(), Kind::ClaudeCode);
    let expected = root.join("plugins/cache/market/sample/1.0.0");
    let outside = temp.path().join("outside");
    std::fs::rename(&expected, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &expected).unwrap();
    let catalog = discover(&root, Kind::ClaudeCode, &PluginCancellationToken::default()).unwrap();
    assert!(
        catalog.candidates[0]
            .pending
            .contains(&"plugin_install_path_requires_grant".into())
    );
    assert!(outside.join("skills/check/SKILL.md").is_file());
}

#[test]
fn both_sources_migrate_actual_packages_disabled_and_reopen_undo_without_source() {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        private(&profile);
        let source = source(temp.path(), kind);
        let token = PluginCancellationToken::default();
        let catalog = discover(&source, kind, &token).unwrap();
        assert_eq!(catalog.candidates.len(), 1);
        assert_eq!(catalog.candidates[0].source_enabled, Some(true));
        let store = PluginMigrationStore::open(&profile).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let planned = store.plan(&id, &catalog.candidates[0], &token).unwrap();
        assert_eq!(planned.stage, Stage::Ready, "{:?}", planned.pending);
        assert!(!profile.join("plugin_store").exists());
        let imported = store.apply(&id, planned.sequence, &token).unwrap();
        assert_eq!(imported.stage, Stage::Imported);
        let native = PluginStore::open(&profile.join("plugin_store")).unwrap();
        let record = native
            .read(&imported.target_id.as_ref().unwrap().parse().unwrap())
            .unwrap()
            .unwrap();
        assert!(!record.enabled_by_default);
        assert!(
            record
                .root(native.root())
                .join("skills/check/SKILL.md")
                .is_file()
        );
        std::fs::remove_dir_all(source).unwrap();
        drop(store);
        let store = PluginMigrationStore::open_existing(&profile)
            .unwrap()
            .unwrap();
        let read = store.read(&id, &token).unwrap();
        assert_eq!(read.stage, Stage::Imported);
        let undone = store.undo(&id, read.sequence, &token).unwrap();
        assert_eq!(undone.stage, Stage::Undone);
        assert!(undone.imported);
        assert!(native.read(&record.plugin_id).unwrap().is_none());
        assert!(store.apply(&id, undone.sequence, &token).unwrap().stage == Stage::Undone);
    }
}

#[test]
fn portable_plugin_lifecycle_keeps_sources_unchanged_and_reopens_after_explicit_cancel() {
    use sha2::{Digest, Sha256};
    fn fingerprint(root: &Path) -> String {
        fn visit(root: &Path, relative: &Path, hash: &mut Sha256) {
            let mut entries = std::fs::read_dir(root.join(relative))
                .unwrap()
                .map(|entry| entry.unwrap())
                .collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let path = relative.join(entry.file_name());
                assert!(!entry.file_type().unwrap().is_symlink());
                if entry.file_type().unwrap().is_dir() {
                    visit(root, &path, hash);
                } else {
                    hash.update(path.as_os_str().as_encoded_bytes());
                    hash.update(std::fs::read(entry.path()).unwrap());
                }
            }
        }
        let mut hash = Sha256::new();
        visit(root, Path::new(""), &mut hash);
        format!("{:x}", hash.finalize())
    }
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("资料 profile");
        private(&profile);
        let source = source(temp.path(), kind);
        let original = fingerprint(&source);
        let token = PluginCancellationToken::default();
        let catalogue = discover(&source, kind, &token).unwrap();
        assert_eq!(catalogue.candidates.len(), 1);
        let store = PluginMigrationStore::open(&profile).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let prepared = store.prepare(&id, &catalogue.candidates[0]).unwrap();
        assert_eq!(
            prepared.stage,
            Stage::Prepared,
            "{kind:?}: {:?}",
            prepared.pending
        );
        assert!(!store.running(&id).unwrap());
        let cancelled = store.cancel(&id, prepared.sequence).unwrap();
        assert_eq!(cancelled.stage, Stage::Cancelled);
        assert!(cancelled.cancel_requested);
        assert!(store.capture(&id, prepared.sequence, &token).is_err());
        drop(store);
        let store = PluginMigrationStore::open_existing(&profile)
            .unwrap()
            .unwrap();
        let current = store.read(&id, &token).unwrap();
        assert_eq!(current.stage, Stage::Cancelled);
        let resumed = store.resume(&id, current.sequence).unwrap();
        assert!(!resumed.cancel_requested);
        assert!(resumed.cancel_revision > cancelled.cancel_revision);
        let captured = store.capture(&id, resumed.sequence, &token).unwrap();
        assert_eq!(captured.stage, Stage::Ready, "{:?}", captured.pending);
        assert_eq!(fingerprint(&source), original);
        assert!(!profile.join("plugin_store").exists());
        let imported = store.apply(&id, captured.sequence, &token).unwrap();
        assert_eq!(imported.stage, Stage::Imported);
        assert_eq!(fingerprint(&source), original);
        let native = PluginStore::open(&profile.join("plugin_store")).unwrap();
        let target = imported.target_id.as_ref().unwrap().parse().unwrap();
        assert!(!native.read(&target).unwrap().unwrap().enabled_by_default);
        let peer_profile = temp.path().join("peer profile");
        private(&peer_profile);
        assert!(
            PluginMigrationStore::open(&peer_profile)
                .unwrap()
                .read(&id, &token)
                .is_err()
        );
        std::fs::remove_dir_all(&source).unwrap();
        drop(store);
        let store = PluginMigrationStore::open_existing(&profile)
            .unwrap()
            .unwrap();
        let restored = store.read(&id, &token).unwrap();
        assert_eq!(restored.stage, Stage::Imported);
        let undone = store.undo(&id, restored.sequence, &token).unwrap();
        assert_eq!(undone.stage, Stage::Undone);
        assert!(native.read(&target).unwrap().is_none());
    }
}
#[test]
fn discovery_preserves_scopes_and_codex_local_version_precedence() {
    let temp = tempfile::tempdir().unwrap();
    let root = source(temp.path(), Kind::Codex);
    package(
        &root.join("plugins/cache/market/sample/99.0.0"),
        Kind::Codex,
        "99.0.0",
    );
    package(
        &root.join("plugins/cache/market/sample/local"),
        Kind::Codex,
        "2.0.0",
    );
    let token = PluginCancellationToken::default();
    let catalog = discover(&root, Kind::Codex, &token).unwrap();
    assert_eq!(
        catalog.candidates[0].installed_version.as_deref(),
        Some("local")
    );
    let root = source(temp.path(), Kind::ClaudeCode);
    let path = root.join("plugins/cache/market/sample/1.0.0");
    std::fs::write(root.join("plugins/installed_plugins.json"),serde_json::json!({"version":2,"plugins":{"sample@market":[{"scope":"project","projectPath":"/synthetic/project","installPath":path,"version":"1.0.0"},{"scope":"user","installPath":path,"version":"1.0.0"}]}}).to_string()).unwrap();
    let catalog = discover(&root, Kind::ClaudeCode, &token).unwrap();
    assert_eq!(catalog.candidates.len(), 2);
    let profile = temp.path().join("profile");
    private(&profile);
    let store = PluginMigrationStore::open(&profile).unwrap();
    let project = store
        .plan(
            &uuid::Uuid::new_v4().to_string(),
            &catalog.candidates[0],
            &token,
        )
        .unwrap();
    assert_eq!(project.stage, Stage::Pending);
    assert!(
        project
            .pending
            .contains(&"plugin_project_mapping_required".into())
    );
    assert!(!profile.join("plugin_store").exists());
    assert!(catalog.candidates[1].pending.is_empty());
}
#[test]
fn source_changes_stale_sequences_user_policy_and_output_changes_are_protected() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    private(&profile);
    let source = source(temp.path(), Kind::Codex);
    let token = PluginCancellationToken::default();
    let catalog = discover(&source, Kind::Codex, &token).unwrap();
    let store = PluginMigrationStore::open(&profile).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let plan = store.plan(&id, &catalog.candidates[0], &token).unwrap();
    assert!(store.apply(&id, plan.sequence + 1, &token).is_err());
    let payload = source.join("plugins/cache/market/sample/1.0.0/skills/check/SKILL.md");
    let original = std::fs::read(&payload).unwrap();
    std::fs::write(&payload, "changed").unwrap();
    assert!(store.apply(&id, plan.sequence, &token).is_err());
    std::fs::write(&payload, original).unwrap();
    let retry = store.read(&id, &token).unwrap();
    assert_eq!(
        retry.failure_code.as_deref(),
        Some("plugin_migration_source_changed")
    );
    let imported = store.apply(&id, retry.sequence, &token).unwrap();
    let target = imported.target_id.clone().unwrap();
    let settings = kcoder_config::ProfileSettingsFile::new(
        kcoder_config::PrivateDirectory::open_existing(&profile).unwrap(),
    )
    .unwrap();
    settings
        .update(|s| {
            *s = serde_json::json!({"plugins":{"installed":{target.clone():{"enabled":true}}}});
            Ok(())
        })
        .unwrap();
    assert!(store.undo(&id, imported.sequence, &token).is_err());
    let view = store.read(&id, &token).unwrap();
    assert_eq!(view.stage, Stage::Imported);
    let native = PluginStore::open(&profile.join("plugin_store")).unwrap();
    let record = native.read(&target.parse().unwrap()).unwrap().unwrap();
    settings
        .update(|s| {
            *s = serde_json::json!({});
            Ok(())
        })
        .unwrap();
    std::fs::write(
        record.root(native.root()).join("skills/check/SKILL.md"),
        "user edit",
    )
    .unwrap();
    assert!(store.undo(&id, view.sequence, &token).is_err());
    assert!(native.read(&record.plugin_id).unwrap().is_some());
}

#[test]
fn lost_publication_acknowledgement_reconciles_after_source_disappears() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    private(&profile);
    let source = source(temp.path(), Kind::ClaudeCode);
    let token = PluginCancellationToken::default();
    let catalog = discover(&source, Kind::ClaudeCode, &token).unwrap();
    let store = PluginMigrationStore::open(&profile).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let plan = store.plan(&id, &catalog.candidates[0], &token).unwrap();
    let imported = store.apply(&id, plan.sequence, &token).unwrap();
    // Reproduce the durable boundary: Native index/receipt committed, Migration acknowledgement lost.
    let job = profile
        .join("plugin-migrations-v1")
        .join(&id)
        .join("job.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&job).unwrap()).unwrap();
    value["stage"] = serde_json::json!("applying");
    value["imported"] = serde_json::json!(false);
    std::fs::write(job, serde_json::to_vec(&value).unwrap()).unwrap();
    std::fs::remove_dir_all(&source).unwrap();
    let reopened = PluginMigrationStore::open_existing(&profile)
        .unwrap()
        .unwrap();
    let read = reopened.read(&id, &token).unwrap();
    assert_eq!(read.stage, Stage::Imported);
    assert!(read.imported);
    assert_eq!(
        reopened.apply(&id, read.sequence, &token).unwrap().sequence,
        imported.sequence
    );
    let undone = reopened.undo(&id, read.sequence, &token).unwrap();
    assert_eq!(undone.stage, Stage::Undone);
}
#[test]
fn source_version_changes_and_operation_reuse_do_not_retarget_an_existing_plan() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    private(&profile);
    let source = source(temp.path(), Kind::Codex);
    let token = PluginCancellationToken::default();
    let catalog = discover(&source, Kind::Codex, &token).unwrap();
    let store = PluginMigrationStore::open(&profile).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let plan = store.plan(&id, &catalog.candidates[0], &token).unwrap();
    package(
        &source.join("plugins/cache/market/sample/local"),
        Kind::Codex,
        "2.0.0",
    );
    let changed = discover(&source, Kind::Codex, &token).unwrap();
    assert!(store.apply(&id, plan.sequence, &token).is_err());
    // Source selection IDs include fixed configuration; unchanged index does not authorize a new cache choice.
    let existing = store.plan(&id, &changed.candidates[0], &token).unwrap();
    assert_eq!(existing.stage, Stage::OutcomeUnknown);
    assert_eq!(existing.installed_version.as_deref(), Some("1.0.0"));
    assert_eq!(
        existing.failure_code.as_deref(),
        Some("plugin_migration_source_changed")
    );
    assert!(store.apply(&id, plan.sequence, &token).is_err());
    assert!(!profile.join("plugin_store").exists());
    let other = self::source(temp.path(), Kind::ClaudeCode);
    let different = discover(&other, Kind::ClaudeCode, &token).unwrap();
    assert!(store.plan(&id, &different.candidates[0], &token).is_err());
}
#[test]
fn sensitive_index_labels_are_not_reflected_and_cancelled_calls_do_not_install() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    private(&profile);
    let source = source(temp.path(), Kind::Codex);
    let token = PluginCancellationToken::default();
    std::fs::write(
        source.join("config.toml"),
        "api_key = \"sample\"\n[plugins.\"sample@market\"]\nenabled = true\n",
    )
    .unwrap();
    let catalog = discover(&source, Kind::Codex, &token).unwrap();
    assert!(catalog.candidates.is_empty());
    assert_eq!(catalog.issues, vec!["plugin_private_index_fields_pending"]);
    std::fs::write(
        source.join("config.toml"),
        "[plugins.\"sample@market\"]\nenabled = true\n",
    )
    .unwrap();
    let catalog = discover(&source, Kind::Codex, &token).unwrap();
    let store = PluginMigrationStore::open(&profile).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let plan = store.plan(&id, &catalog.candidates[0], &token).unwrap();
    token.cancel();
    assert!(store.apply(&id, plan.sequence, &token).is_err());
    assert!(!profile.join("plugin_store").exists());
    let fresh = PluginCancellationToken::default();
    assert_eq!(store.read(&id, &fresh).unwrap().stage, Stage::Ready);
}

#[test]
fn target_install_limits_and_malformed_policy_are_not_bypassed() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    private(&profile);
    let source = source(temp.path(), Kind::Codex);
    let token = PluginCancellationToken::default();
    let catalog = discover(&source, Kind::Codex, &token).unwrap();
    let store = PluginMigrationStore::open(&profile).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let plan = store.plan(&id, &catalog.candidates[0], &token).unwrap();
    let settings = kcoder_config::ProfileSettingsFile::new(
        kcoder_config::PrivateDirectory::open_existing(&profile).unwrap(),
    )
    .unwrap();
    settings
        .update(|s| {
            *s = serde_json::json!({"plugins":{"installation":{"max_files":1}}});
            Ok(())
        })
        .unwrap();
    assert!(store.apply(&id, plan.sequence, &token).is_err());
    assert_eq!(
        PluginStore::open_for_migration(&profile.join("plugin_store"))
            .unwrap()
            .installed_plugins()
            .unwrap()
            .len(),
        0
    );
    let read = store.read(&id, &token).unwrap();
    // Model a manually corrupted owned settings file; the ordinary writer correctly rejects it.
    kcoder_config::PrivateDirectory::open_existing(&profile)
        .unwrap()
        .atomic_replace(
            std::ffi::OsStr::new("settings.json"),
            br#"{"plugins":{"installed":"invalid"}}"#,
        )
        .unwrap();
    assert!(store.apply(&id, read.sequence, &token).is_err());
    assert_eq!(
        PluginStore::open_for_migration(&profile.join("plugin_store"))
            .unwrap()
            .installed_plugins()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn prepare_cancel_resume_and_missing_writer_are_truthful_and_readonly() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    private(&profile);
    let source = source(temp.path(), Kind::Codex);
    let token = PluginCancellationToken::default();
    let catalog = discover(&source, Kind::Codex, &token).unwrap();
    let store = PluginMigrationStore::open(&profile).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let prepared = store.prepare(&id, &catalog.candidates[0]).unwrap();
    assert_eq!(prepared.stage, Stage::Prepared);
    assert!(
        !profile
            .join("plugin-migrations-v1")
            .join(&id)
            .join("package-1")
            .exists()
    );
    assert!(!store.running(&id).unwrap());
    let cancelled = store.cancel(&id, prepared.sequence).unwrap();
    assert_eq!(cancelled.stage, Stage::Cancelled);
    assert!(cancelled.cancel_requested);
    assert!(store.capture(&id, prepared.sequence, &token).is_err());
    let resumed = store.resume(&id, cancelled.sequence).unwrap();
    assert_eq!(resumed.stage, Stage::Prepared);
    assert!(!resumed.cancel_requested);
    assert!(resumed.cancel_revision > cancelled.cancel_revision);
    assert!(store.capture(&id, prepared.sequence, &token).is_err());
    let ready = store.capture(&id, resumed.sequence, &token).unwrap();
    assert_eq!(ready.stage, Stage::Ready);
    let directory = profile.join("plugin-migrations-v1").join(&id);
    std::fs::rename(
        directory.join("writer.lock"),
        directory.join("writer.original"),
    )
    .unwrap();
    assert!(store.running(&id).is_err());
    assert!(!directory.join("writer.lock").exists());
    assert!(store.apply(&id, ready.sequence, &token).is_err());
    assert!(!profile.join("plugin_store").exists());
    std::fs::write(directory.join("writer.lock"), "").unwrap();
    assert!(store.running(&id).is_err());
}
#[test]
fn project_or_unsupported_plugin_cannot_be_promoted_by_resume() {
    let temp = tempfile::tempdir().unwrap();
    let root = source(temp.path(), Kind::ClaudeCode);
    let path = root.join("plugins/cache/market/sample/1.0.0");
    std::fs::write(root.join("plugins/installed_plugins.json"),serde_json::json!({"version":2,"plugins":{"sample@market":[{"scope":"project","projectPath":"/synthetic/project","installPath":path,"version":"1.0.0"}]}}).to_string()).unwrap();
    let profile = temp.path().join("profile");
    private(&profile);
    let store = PluginMigrationStore::open(&profile).unwrap();
    let token = PluginCancellationToken::default();
    let catalog = discover(&root, Kind::ClaudeCode, &token).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let pending = store.prepare(&id, &catalog.candidates[0]).unwrap();
    assert_eq!(pending.stage, Stage::Pending);
    assert!(store.resume(&id, pending.sequence).is_err());
    assert!(store.capture(&id, pending.sequence, &token).is_err());
    assert!(!profile.join("plugin_store").exists());
}
#[test]
fn plugin_records_page_by_ten_and_are_owned_by_the_selected_profile() {
    let temp = tempfile::tempdir().unwrap();
    let root = source(temp.path(), Kind::Codex);
    let profile = temp.path().join("profile");
    private(&profile);
    let store = PluginMigrationStore::open(&profile).unwrap();
    let token = PluginCancellationToken::default();
    let catalog = discover(&root, Kind::Codex, &token).unwrap();
    for _ in 0..11 {
        store
            .prepare(&uuid::Uuid::new_v4().to_string(), &catalog.candidates[0])
            .unwrap();
    }
    let (first, next) = store.list(None).unwrap();
    assert_eq!(first.len(), 10);
    let next = next.unwrap();
    let (second, last) = store.list(Some(&next)).unwrap();
    assert_eq!(second.len(), 1);
    assert!(last.is_none());
    let other = temp.path().join("other");
    private(&other);
    assert!(
        PluginMigrationStore::open_existing(&other)
            .unwrap()
            .is_none()
    );
    let other = PluginMigrationStore::open(&other).unwrap();
    assert!(other.list(Some(&next)).is_err());
    assert!(other.read(&first[0].operation_id, &token).is_err());
}
#[test]
fn a_lost_capture_receipt_reuses_only_the_same_owned_complete_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let root = source(temp.path(), Kind::Codex);
    let profile = temp.path().join("profile");
    private(&profile);
    let store = PluginMigrationStore::open(&profile).unwrap();
    let token = PluginCancellationToken::default();
    let catalog = discover(&root, Kind::Codex, &token).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let ready = store.plan(&id, &catalog.candidates[0], &token).unwrap();
    let path = profile
        .join("plugin-migrations-v1")
        .join(&id)
        .join("job.json");
    let mut raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    raw["stage"] = serde_json::json!("capturing");
    raw["package"] = serde_json::Value::Null;
    std::fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
    assert_eq!(
        store.read(&id, &token).unwrap().stage,
        Stage::OutcomeUnknown
    );
    std::fs::remove_dir_all(&root).unwrap();
    let captured = store.capture(&id, ready.sequence, &token).unwrap();
    assert_eq!(captured.stage, Stage::Ready);
    assert_eq!(captured.package_files, ready.package_files);
    assert!(
        !profile
            .join("plugin-migrations-v1")
            .join(&id)
            .join("package-2")
            .exists()
    );
}

#[test]
fn a_running_capture_observes_cross_instance_cancel_without_replacing_its_lease() {
    let temp = tempfile::tempdir().unwrap();
    let root = source(temp.path(), Kind::Codex);
    for index in 0..8 {
        std::fs::File::create(root.join(format!("plugins/cache/market/sample/1.0.0/part-{index}")))
            .unwrap()
            .set_len(16 * 1024 * 1024)
            .unwrap();
    }
    let profile = temp.path().join("profile");
    private(&profile);
    let store = PluginMigrationStore::open(&profile).unwrap();
    let token = PluginCancellationToken::default();
    let catalog = discover(&root, Kind::Codex, &token).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let prepared = store.prepare(&id, &catalog.candidates[0]).unwrap();
    let worker_profile = profile.clone();
    let worker_id = id.clone();
    let worker = std::thread::spawn(move || {
        let store = PluginMigrationStore::open_existing(&worker_profile)
            .unwrap()
            .unwrap();
        store
            .capture(
                &worker_id,
                prepared.sequence,
                &PluginCancellationToken::default(),
            )
            .is_err()
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !store.running(&id).unwrap() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    let mut current = store.read(&id, &token).unwrap();
    while current.stage != Stage::Capturing {
        assert!(std::time::Instant::now() < deadline);
        current = store.read(&id, &token).unwrap();
    }
    let requested = store.cancel(&id, current.sequence).unwrap();
    assert!(requested.cancel_requested);
    assert!(worker.join().unwrap());
    let stopped = store.read(&id, &token).unwrap();
    assert_eq!(stopped.stage, Stage::Cancelled);
    assert!(stopped.cancel_requested);
    assert!(!store.running(&id).unwrap());
    assert!(!profile.join("plugin_store").exists());
    // Reopening/read never clears the persisted cancellation watermark.
    let reopened = PluginMigrationStore::open_existing(&profile)
        .unwrap()
        .unwrap();
    assert!(reopened.read(&id, &token).unwrap().cancel_requested);
    assert!(reopened.capture(&id, stopped.sequence, &token).is_err());
}

#[test]
fn a_pinned_child_is_owned_by_one_parent_and_cannot_be_borrowed_for_undo() {
    use kcoder_migration::{
        batch::BatchSource, discovery::ConfigurationBinding, store::MigrationStore,
    };
    let temp = tempfile::tempdir().unwrap();
    let root = source(temp.path(), Kind::Codex);
    let profile = temp.path().join("profile");
    private(&profile);
    let store = PluginMigrationStore::open(&profile).unwrap();
    let token = PluginCancellationToken::default();
    let catalog = discover(&root, Kind::Codex, &token).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let ready = store.plan(&id, &catalog.candidates[0], &token).unwrap();
    let source = store.batch_source(&id, ready.sequence).unwrap();
    assert_eq!(
        source.inventory().unwrap().items[0].preview.category,
        kcoder_types::migration::MigrationCategory::Plugin
    );
    let journal = MigrationStore::open_or_create(&profile).unwrap();
    let parent = journal
        .create_batch_scan(vec![BatchSource::Configuration(
            ConfigurationBinding::capture_selected(&root.join("config.toml"), Kind::Codex).unwrap(),
        )])
        .unwrap();
    let other = journal
        .create_batch_scan(vec![BatchSource::Configuration(
            ConfigurationBinding::capture_selected(&root.join("config.toml"), Kind::Codex).unwrap(),
        )])
        .unwrap();
    let first = store
        .batch_consumer(&parent.job_id, "plugin-action-one")
        .unwrap();
    let second = store
        .batch_consumer(&other.job_id, "plugin-action-two")
        .unwrap();
    let reference = store
        .pin_for_batch(&source, &first, "custom-sample")
        .unwrap();
    assert_eq!(
        reference.target_id().split('@').next(),
        Some("custom-sample")
    );
    assert_eq!(
        reference,
        store
            .pin_for_batch(&source, &first, "custom-sample")
            .unwrap()
    );
    assert!(
        store
            .pin_for_batch(&source, &second, "custom-sample")
            .is_err()
    );
    assert!(store.apply(&id, reference.sequence(), &token).is_err());
    assert!(store.cancel(&id, reference.sequence()).is_err());
    assert!(store.resume(&id, reference.sequence()).is_err());
    let serialized = serde_json::to_vec(&reference).unwrap();
    let reference = serde_json::from_slice(&serialized).unwrap();
    let imported = store.apply_reference(&reference, &token).unwrap();
    assert_eq!(imported.stage, Stage::Imported);
    assert_eq!(
        store.read_reference(&reference).unwrap().batch_job_id,
        Some(parent.job_id.clone())
    );
    assert!(
        store
            .pin_for_batch(&source, &second, "custom-sample")
            .is_err()
    );
    assert!(store.undo(&id, imported.sequence, &token).is_err());
    let other_profile = temp.path().join("other-profile");
    private(&other_profile);
    let unrelated = PluginMigrationStore::open(&other_profile).unwrap();
    assert!(source.validate_profile(&other_profile).is_err());
    assert!(unrelated.read_reference(&reference).is_err());
    assert!(unrelated.undo_reference(&reference, &token).is_err());
    let undone = store.undo_reference(&reference, &token).unwrap();
    assert_eq!(undone.stage, Stage::Undone);
    assert_eq!(
        store.apply_reference(&reference, &token).unwrap().stage,
        Stage::Undone
    );
}

#[test]
fn plugin_catalogue_grants_are_paged_and_do_not_accept_another_target_or_kind_cursor() {
    use kcoder_migration::discovery::{DiscoveryRoots, SourceRegistry};
    let temp = tempfile::tempdir().unwrap();
    let root = source(temp.path(), Kind::ClaudeCode);
    let package = root.join("plugins/cache/market/sample/1.0.0");
    let entries = (0..11)
        .map(|_| serde_json::json!({"scope":"user","installPath":package,"version":"1.0.0"}))
        .collect::<Vec<_>>();
    std::fs::write(
        root.join("plugins/installed_plugins.json"),
        serde_json::json!({"version":2,"plugins":{"sample@market":entries}}).to_string(),
    )
    .unwrap();
    let roots = || DiscoveryRoots {
        home: temp.path().into(),
        claude_config_dir: Some(root.clone()),
        codex_home: None,
        project: None,
    };
    let mut registry = SourceRegistry::new(roots());
    let token = PluginCancellationToken::default();
    let first = registry
        .discover_plugins(&[Kind::ClaudeCode], None, &token)
        .unwrap();
    assert_eq!(first.candidates.len(), 10);
    let id = first.candidates[0].candidate_id.clone();
    assert!(registry.selected_plugin(&id).is_ok());
    let cursor = first.next_cursor.unwrap();
    let second = registry
        .discover_plugins(&[Kind::ClaudeCode], Some(&cursor), &token)
        .unwrap();
    assert_eq!(second.candidates.len(), 1);
    assert!(second.next_cursor.is_none());
    assert!(
        registry
            .discover_plugins(&[Kind::Codex], Some(&cursor), &token)
            .is_err()
    );
    let other = SourceRegistry::new(roots());
    assert!(other.selected_plugin(&id).is_err());
    assert!(registry.selected_plugin("../../private").is_err());
}

#[test]
fn plugin_writer_waits_for_a_short_readonly_probe_without_replaying_capture() {
    let temp = tempfile::tempdir().unwrap();
    let root = source(temp.path(), Kind::Codex);
    let profile = temp.path().join("profile");
    private(&profile);
    let store = PluginMigrationStore::open(&profile).unwrap();
    let token = PluginCancellationToken::default();
    let catalog = discover(&root, Kind::Codex, &token).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let prepared = store.prepare(&id, &catalog.candidates[0]).unwrap();
    let dir = kcoder_config::PrivateDirectory::open_existing(
        &profile.join("plugin-migrations-v1").join(&id),
    )
    .unwrap();
    let expected = dir
        .retention_regular_identity(std::ffi::OsStr::new("writer.lock"))
        .unwrap();
    let probe = dir
        .try_existing_verified_lock(
            std::ffi::OsStr::new("writer.lock"),
            &expected,
            kcoder_config::PrivateLeaseMode::Exclusive,
        )
        .unwrap()
        .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let worker_barrier = barrier.clone();
    let worker = std::thread::spawn(move || {
        worker_barrier.wait();
        store
            .capture(&id, prepared.sequence, &PluginCancellationToken::default())
            .map(|view| (view.stage, view.sequence))
    });
    barrier.wait();
    std::thread::sleep(std::time::Duration::from_millis(10));
    drop(probe);
    let (stage, sequence) = worker.join().unwrap().unwrap();
    assert_eq!(stage, Stage::Ready);
    assert_eq!(sequence, 1);
}

#[test]
fn initial_publication_requires_the_bound_source_and_missing_source_does_not_install_anything() {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let temp = tempfile::tempdir().unwrap();
        let root = source(temp.path(), kind);
        let profile = temp.path().join("profile");
        private(&profile);
        let store = PluginMigrationStore::open(&profile).unwrap();
        let token = PluginCancellationToken::default();
        let candidate = discover(&root, kind, &token).unwrap().candidates.remove(0);
        let id = uuid::Uuid::new_v4().to_string();
        let ready = store.plan(&id, &candidate, &token).unwrap();
        assert_eq!(ready.stage, Stage::Ready);
        let withheld = temp.path().join("source-withheld");
        std::fs::rename(&root, &withheld).unwrap();
        assert_eq!(store.read(&id, &token).unwrap().stage, Stage::Ready);
        let error = store.apply(&id, ready.sequence, &token).err().unwrap();
        assert_eq!(
            kcoder_migration::plugin_migration::error_code(&error),
            "plugin_migration_source_unavailable"
        );
        let failed = store.read(&id, &token).unwrap();
        assert!(!failed.imported);
        assert_eq!(
            failed.failure_code.as_deref(),
            Some("plugin_migration_source_unavailable")
        );
        assert!(!profile.join("plugin_store").exists());
        std::fs::rename(&withheld, &root).unwrap();
        let reopened = PluginMigrationStore::open_existing(&profile)
            .unwrap()
            .unwrap();
        assert_eq!(
            reopened.apply(&id, failed.sequence, &token).unwrap().stage,
            Stage::Imported
        );
    }
}
