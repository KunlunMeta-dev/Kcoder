use kcoder_config::PrivateDirectory;
use kcoder_migration::{
    assets::AssetTarget,
    contention::{LeaseKind, MigrationContention},
    mcp::McpTarget,
    providers::ProviderTarget,
    store::{BatchTargets, MigrationStore},
};
use std::ffi::OsStr;

#[test]
fn short_status_reader_does_not_turn_a_journal_mutation_into_an_unknown_outcome() {
    let profile = tempfile::tempdir().unwrap();
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let job = store
        .create_scan(
            "owned",
            kcoder_migration::parse_codex_config("model='fixture'").unwrap(),
        )
        .unwrap();
    let directory = PrivateDirectory::open_existing(&profile.path().join("migrations")).unwrap();
    let reader = directory
        .try_shared_lock(OsStr::new(".lock"))
        .unwrap()
        .unwrap();
    std::thread::scope(|scope| {
        scope.spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            drop(reader);
        });
        let cancelled = store.cancel(&job.job_id, job.sequence).unwrap();
        assert_eq!(cancelled.sequence, job.sequence + 1);
        assert_eq!(store.read(&job.job_id).unwrap(), cancelled);
    });
}

#[test]
fn journal_contention_retains_the_legacy_error_and_reports_only_its_safe_lease_category() {
    let profile = tempfile::tempdir().unwrap();
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let job = store
        .create_scan(
            "owned",
            kcoder_migration::parse_codex_config("model='fixture'").unwrap(),
        )
        .unwrap();
    let directory = PrivateDirectory::open_existing(&profile.path().join("migrations")).unwrap();
    let shared = directory
        .try_shared_lock(OsStr::new(".lock"))
        .unwrap()
        .unwrap();
    assert_eq!(store.read(&job.job_id).unwrap(), job);
    let busy = store.cancel(&job.job_id, job.sequence).unwrap_err();
    assert_eq!(busy.to_string(), "migration_busy");
    assert_eq!(
        busy.downcast_ref::<MigrationContention>().unwrap().lease,
        LeaseKind::JournalWrite
    );
    drop(shared);
    let exclusive = directory
        .try_exclusive_lock(OsStr::new(".lock"))
        .unwrap()
        .unwrap();
    let busy = store.read(&job.job_id).unwrap_err();
    assert_eq!(busy.to_string(), "migration_busy");
    assert_eq!(
        busy.downcast_ref::<MigrationContention>().unwrap().lease,
        LeaseKind::JournalRead
    );
    drop(exclusive);
    assert_eq!(store.read(&job.job_id).unwrap(), job);
}

#[test]
fn duplicate_batch_runners_are_distinct_from_short_journal_lease_competition() {
    let profile = tempfile::tempdir().unwrap();
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let source = tempfile::tempdir().unwrap();
    std::fs::create_dir(source.path().join("owned-skill")).unwrap();
    std::fs::write(source.path().join("owned-skill/SKILL.md"), "---\nname: owned-skill\ndescription: Static lease fixture\n---\nNever execute source content.").unwrap();
    let job = store
        .create_batch_scan(vec![kcoder_migration::batch::BatchSource::Assets(
            kcoder_migration::asset_sources::AssetBundleBinding::capture(
                source.path(),
                kcoder_types::migration::MigrationSourceKind::ClaudeCode,
                kcoder_types::migration::MigrationCategory::Skill,
                kcoder_config::imported_context::ImportedContextScope::Global,
                true,
            )
            .unwrap(),
        )])
        .unwrap();
    let directory = PrivateDirectory::open_existing(&profile.path().join("migrations")).unwrap();
    let runner = directory
        .try_exclusive_lock(OsStr::new(&format!(".{}.runner.lock", job.job_id)))
        .unwrap()
        .unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let busy = store
        .run_batch(
            &job.job_id,
            "plan",
            "apply",
            job.sequence,
            false,
            &BatchTargets {
                history: None,
                provider: &provider,
                mcp: &mcp,
                assets: &assets,
                credentials: None,
            },
        )
        .unwrap_err();
    assert_eq!(busy.to_string(), "migration_busy");
    assert_eq!(
        busy.downcast_ref::<MigrationContention>().unwrap().lease,
        LeaseKind::BatchRunner
    );
    assert_eq!(store.read(&job.job_id).unwrap(), job);
    drop(runner);
}
