use super::*;
use kcoder_types::{
    external_history::{ExternalHistoryOrigin, HistoryImportStage},
    migration::MigrationSourceKind,
};
use std::{fs, time::Duration};

fn owned_job(profile: &Path, source: &Path) -> (String, String) {
    let session = uuid::Uuid::new_v4().to_string();
    fs::write(
        source.join("source.jsonl"),
        serde_json::to_vec(&serde_json::json!({
            "type":"user", "uuid":"owned-root", "parentUuid":null,
            "sessionId":session,"message":{"role":"user","content":"owned read fixture"}
        }))
        .unwrap(),
    )
    .unwrap();
    let binding = crate::history_sources::HistorySourceBinding::capture(
        source,
        Path::new("source.jsonl"),
        ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "owned-view-fixture".into(),
            source_session_id: session,
            source_artifact_id: None,
            source_format: "jsonl/fixture".into(),
            adapter_revision: "fixture/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: None,
            archived: false,
            parent_session_id: None,
        },
        &mut |_, _| true,
    )
    .unwrap();
    let store = HistoryJobStore::open(profile).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut job = store.create(&id, &binding).unwrap();
    for _ in 0..16 {
        if job.stage == HistoryImportStage::Normalized {
            break;
        }
        job = store.step(&id, job.sequence, 10, |_| true).unwrap();
    }
    assert_eq!(job.stage, HistoryImportStage::Normalized);
    (id, job.archive_id.unwrap())
}

#[test]
fn idle_raw_view_holds_the_original_archive_until_its_owner_releases_it() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let (job, archive) = owned_job(profile.path(), source.path());
    let leases = HistoryViewLeases::default();
    let request = uuid::Uuid::new_v4().to_string();
    let opened = leases
        .open(profile.path(), &request, &job, &archive, None)
        .unwrap();
    assert_eq!(opened.binding.managed_archives, 1);
    assert_eq!(opened.binding.legacy_archives, 0);
    fs::remove_file(source.path().join("source.jsonl")).unwrap();
    let jobs = HistoryJobStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let op = uuid::Uuid::new_v4().to_string();
    let prepared = jobs
        .prepare_retirement(&op, &job, jobs.read(&job).unwrap().sequence)
        .unwrap();
    let blocked = jobs
        .run_retirement(&op, prepared.sequence, || true)
        .unwrap();
    assert_eq!(
        blocked.failure_code.as_deref(),
        Some("external_history_retirement_readers_busy")
    );
    let peer = HistoryViewLeases::default();
    assert!(
        peer.release(profile.path(), &request, &opened.lease_id)
            .unwrap()
            .is_none()
    );
    let renewed = leases
        .renew(profile.path(), &request, &opened.lease_id, opened.sequence)
        .unwrap();
    assert!(
        leases
            .renew(profile.path(), &request, &opened.lease_id, opened.sequence)
            .is_err()
    );
    let released = leases
        .release(profile.path(), &request, &opened.lease_id)
        .unwrap()
        .unwrap();
    assert_eq!(released.state, HistoryViewLeaseState::Released);
    assert_eq!(
        leases
            .open(profile.path(), &request, &job, &archive, None)
            .unwrap()
            .state,
        HistoryViewLeaseState::Released
    );
    assert!(
        leases
            .renew(
                profile.path(),
                &request,
                &renewed.lease_id,
                renewed.sequence
            )
            .is_err()
    );
    let result = jobs.run_retirement(&op, blocked.sequence, || true).unwrap();
    assert!(result.logical_retired);
    assert!(matches!(
        result.phase,
        kcoder_state::external_history::lifecycle::ArchiveRetirementPhase::Collected
    ));
    assert!(jobs.read(&job).unwrap().archived);
}

#[test]
fn expired_nonce_never_reopens_and_disconnect_closes_pending_and_future_acquisition() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let (job, archive) = owned_job(profile.path(), source.path());
    let leases = HistoryViewLeases::with_ttl(Duration::from_millis(20));
    let request = uuid::Uuid::new_v4().to_string();
    let opened = leases
        .open(profile.path(), &request, &job, &archive, None)
        .unwrap();
    std::thread::sleep(Duration::from_millis(30));
    leases.expire().unwrap();
    assert_eq!(
        leases
            .read(profile.path(), &request, Some(&opened.lease_id))
            .unwrap()
            .unwrap()
            .state,
        HistoryViewLeaseState::Expired
    );
    assert_eq!(
        leases
            .open(profile.path(), &request, &job, &archive, None)
            .unwrap()
            .state,
        HistoryViewLeaseState::Expired
    );
    assert!(
        leases
            .renew(profile.path(), &request, &opened.lease_id, opened.sequence)
            .is_err()
    );
    let other = tempfile::tempdir().unwrap();
    assert!(
        leases
            .read(other.path(), &request, Some(&opened.lease_id))
            .is_err()
    );
    leases.clear();
    assert!(
        leases
            .open(
                profile.path(),
                &uuid::Uuid::new_v4().to_string(),
                &job,
                &archive,
                None
            )
            .is_err()
    );
}

#[test]
fn branch_view_keeps_its_own_derived_lease_and_all_source_generations() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let (job, _) = owned_job(profile.path(), source.path());
    let branches = HistoryBranchStore::open(profile.path()).unwrap();
    let planned = branches.prepare(&job, &[]).unwrap();
    let ready = branches.build(&job, &planned.view_id, || true).unwrap();
    let hold = HistoryViewHold::open(profile.path(), &job, Some(&ready.view_id)).unwrap();
    assert_eq!(hold.binding().managed_archives, 1);
    hold.validate(profile.path()).unwrap();
    let retire = branches
        .retire_view(
            &job,
            &ready.view_id,
            &uuid::Uuid::new_v4().to_string(),
            ready.sequence,
        )
        .err()
        .unwrap();
    assert_eq!(retire.to_string(), "history_branch_busy");
}

#[test]
fn view_open_and_missing_read_create_no_new_store_or_rebind_request_identity() {
    let profile = tempfile::tempdir().unwrap();
    let leases = HistoryViewLeases::default();
    let request = uuid::Uuid::new_v4().to_string();
    assert!(
        leases
            .read(profile.path(), &request, None)
            .unwrap()
            .is_none()
    );
    assert!(
        leases
            .open(profile.path(), &request, "missing", "missing", None)
            .is_err()
    );
    assert_eq!(fs::read_dir(profile.path()).unwrap().count(), 0);
    let source = tempfile::tempdir().unwrap();
    let (job, archive) = owned_job(profile.path(), source.path());
    let opened = leases
        .open(profile.path(), &request, &job, &archive, None)
        .unwrap();
    assert!(
        leases
            .open(profile.path(), &request, &job, "different", None)
            .is_err()
    );
    assert!(
        leases
            .release(profile.path(), &request, &uuid::Uuid::new_v4().to_string())
            .is_err()
    );
    assert_eq!(
        leases
            .read(profile.path(), &request, None)
            .unwrap()
            .unwrap()
            .lease_id,
        opened.lease_id
    );
}

#[test]
fn an_unconfirmed_renewal_keeps_its_original_read_fence_until_explicit_release() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let (job, archive) = owned_job(profile.path(), source.path());
    let leases = HistoryViewLeases::default();
    let request = uuid::Uuid::new_v4().to_string();
    let opened = leases
        .open(profile.path(), &request, &job, &archive, None)
        .unwrap();
    let path = profile
        .path()
        .join("migrations/history")
        .join(format!("{job}.json"));
    let original = fs::read(&path).unwrap();
    let mut changed: serde_json::Value = serde_json::from_slice(&original).unwrap();
    changed["normalizationRevision"] = serde_json::json!("unsupported-owned-fixture");
    fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(
        leases
            .renew(profile.path(), &request, &opened.lease_id, opened.sequence)
            .is_err()
    );
    fs::write(path, original).unwrap();
    let archives =
        kcoder_state::external_history::ExternalHistoryStore::open_existing(profile.path())
            .unwrap()
            .unwrap();
    assert!(
        !archives
            .archive_lifecycle_observation(&archive)
            .unwrap()
            .read_leases_idle,
        "an unconfirmed renewal prematurely released its last promised read fence"
    );
    leases
        .release(profile.path(), &request, &opened.lease_id)
        .unwrap();
    assert!(
        archives
            .archive_lifecycle_observation(&archive)
            .unwrap()
            .read_leases_idle
    );
}
