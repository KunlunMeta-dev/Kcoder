//! Actual target-owned history holds and explicit archive retirement over stdio.
use super::*;

fn lifecycle(server: &mut TestAppServer, group: &str, action: &str, params: Value) -> Value {
    rpc(
        server,
        580,
        &format!("migration/history/{group}/{action}"),
        params,
    )
}
fn archived(fixture: &Fixture) -> (TestAppServer, String, Value) {
    let mut server = fixture.start();
    let page = rpc(
        &mut server,
        581,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let id = uuid::Uuid::new_v4().to_string();
    create(&mut server, &page, &page["items"][0], &id);
    rpc(
        &mut server,
        582,
        "migration/history/run",
        json!({"jobId":id,"expectedSequence":0}),
    );
    let done = wait(&mut server, &id, |value| {
        value["job"]["stage"] == "normalized" && value["workerRunning"] == false
    });
    (server, id, done)
}
fn settled(server: &mut TestAppServer, operation: &str, job: &str) -> Value {
    settled_after(server, operation, job, None)
}
fn settled_after(
    server: &mut TestAppServer,
    operation: &str,
    job: &str,
    previous: Option<u64>,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let value = lifecycle(
            server,
            "retirement",
            "read",
            json!({"operationId":operation,"jobId":job}),
        );
        if value["workerState"] == "stopped"
            && value["workerScheduled"] == false
            && previous.is_none_or(|sequence| {
                value["retirement"]["sequence"]
                    .as_u64()
                    .is_some_and(|current| current > sequence)
            })
        {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "retirement did not settle: {value}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn control(value: &Value) -> Value {
    json!({"operationId":value["retirement"]["operationId"],"jobId":value["retirement"]["jobId"],"expectedSequence":value["retirement"]["sequence"]})
}

#[test]
fn history_lifecycle_reads_create_no_storage_and_owned_view_blocks_retirement_until_exact_release()
{
    let fixture = Fixture::new();
    let mut empty = fixture.start();
    assert_eq!(
        lifecycle(&mut empty, "retirement", "list", json!({}))["items"],
        json!([])
    );
    assert!(
        lifecycle(
            &mut empty,
            "view",
            "read",
            json!({"requestId":uuid::Uuid::new_v4().to_string()})
        )["lease"]
            .is_null()
    );
    assert!(!fixture.profile.join("external-history").exists());
    empty.shutdown();
    let source = fixture.source(3);
    let original = fs::read(&source).unwrap();
    let (mut server, job, facts) = archived(&fixture);
    let raw = fixture
        .profile
        .join("external-history")
        .join(facts["job"]["archiveId"].as_str().unwrap())
        .join("source.bin");
    let request = uuid::Uuid::new_v4().to_string();
    let opened = lifecycle(
        &mut server,
        "view",
        "open",
        json!({"requestId":request,"jobId":job,"expectedArchiveId":facts["job"]["archiveId"],"viewId":null}),
    );
    assert_eq!(opened["lease"]["state"], "active");
    let renewed = lifecycle(
        &mut server,
        "view",
        "renew",
        json!({"requestId":request,"leaseId":opened["lease"]["leaseId"],"expectedSequence":opened["lease"]["sequence"]}),
    );
    assert_eq!(renewed["lease"]["sequence"], 2);
    let preview = lifecycle(&mut server, "retirement", "preview", json!({"jobId":job}));
    assert_eq!(preview["readersIdle"], false);
    assert_eq!(preview["retainedReferences"], 0);
    let op = uuid::Uuid::new_v4().to_string();
    let prepared = lifecycle(
        &mut server,
        "retirement",
        "prepare",
        json!({"operationId":op,"jobId":job,"expectedJobSequence":facts["job"]["sequence"]}),
    );
    assert!(raw.exists());
    lifecycle(&mut server, "retirement", "run", control(&prepared));
    let blocked = settled(&mut server, &op, &job);
    assert_eq!(
        blocked["retirement"]["failureCode"], "external_history_retirement_readers_busy",
        "{blocked}"
    );
    assert_eq!(blocked["retirement"]["logicalRetired"], false);
    let mut peer = fixture.start();
    assert!(
        lifecycle(
            &mut peer,
            "view",
            "release",
            json!({"requestId":request,"leaseId":opened["lease"]["leaseId"]})
        )["lease"]
            .is_null()
    );
    assert_eq!(
        lifecycle(&mut peer, "retirement", "preview", json!({"jobId":job}))["readersIdle"],
        false
    );
    let released = lifecycle(
        &mut server,
        "view",
        "release",
        json!({"requestId":request,"leaseId":opened["lease"]["leaseId"]}),
    );
    assert_eq!(released["lease"]["state"], "released");
    assert_eq!(
        lifecycle(
            &mut server,
            "view",
            "open",
            json!({"requestId":request,"jobId":job,"expectedArchiveId":facts["job"]["archiveId"]})
        )["lease"]["state"],
        "released"
    );
    let resumed = lifecycle(&mut peer, "retirement", "resume", control(&blocked));
    assert!(raw.exists(), "resume implicitly collected content");
    peer.send(json!({"jsonrpc":"2.0","method":"migration/history/retirement/run","params":control(&resumed)}));
    assert_eq!(
        lifecycle(
            &mut peer,
            "retirement",
            "read",
            json!({"operationId":op,"jobId":job})
        )["retirement"]["phase"],
        "prepared"
    );
    // Deliberately never consume this run's response. Read the authoritative operation instead.
    peer.send(json!({"jsonrpc":"2.0","id":589,"method":"migration/history/retirement/run","params":control(&resumed)}));
    // The independent read lane may overtake an unanswered control request. A
    // quiet pre-run snapshot cannot prove that this queued request has settled.
    let done = settled_after(
        &mut peer,
        &op,
        &job,
        resumed["retirement"]["sequence"].as_u64(),
    );
    assert_eq!(done["retirement"]["phase"], "collected");
    assert_eq!(done["retirement"]["logicalRetired"], true);
    assert!(done["retirement"]["collectedBytes"].as_u64().unwrap() > 0);
    assert!(!raw.exists());
    assert_eq!(fs::read(source).unwrap(), original);
    assert_eq!(read(&mut server, &job)["job"], facts["job"]);
    peer.shutdown();
    server.shutdown();
    let mut reopened = fixture.start();
    let recovered = lifecycle(
        &mut reopened,
        "retirement",
        "read",
        json!({"operationId":op,"jobId":job}),
    );
    assert_eq!(recovered["retirement"], done["retirement"]);
    assert_eq!(recovered["workerState"], "stopped");
    assert_eq!(read(&mut reopened, &job)["job"], facts["job"]);
    reopened.shutdown();
}

#[test]
fn history_lifecycle_cancel_and_reopen_keep_raw_content_and_disconnect_releases_only_own_hold() {
    let fixture = Fixture::new();
    fixture.source(2);
    let (mut server, job, facts) = archived(&fixture);
    let op = uuid::Uuid::new_v4().to_string();
    let prepared = lifecycle(
        &mut server,
        "retirement",
        "prepare",
        json!({"operationId":op,"jobId":job,"expectedJobSequence":facts["job"]["sequence"]}),
    );
    let cancelled = lifecycle(
        &mut server,
        "retirement",
        "cancel",
        json!({"operationId":op,"jobId":job}),
    );
    assert_eq!(cancelled["retirement"]["phase"], "cancelled");
    let request = uuid::Uuid::new_v4().to_string();
    lifecycle(
        &mut server,
        "view",
        "open",
        json!({"requestId":request,"jobId":job,"expectedArchiveId":facts["job"]["archiveId"]}),
    );
    let mut peer = fixture.start();
    assert_eq!(
        lifecycle(
            &mut peer,
            "retirement",
            "read",
            json!({"operationId":op,"jobId":job})
        )["retirement"],
        cancelled["retirement"]
    );
    peer.send(json!({"jsonrpc":"2.0","id":590,"method":"migration/history/retirement/resume","params":control(&cancelled)}));
    assert_eq!(
        peer.response(590)["error"]["message"],
        "external_history_lifecycle_busy"
    );
    server.shutdown();
    let resumed = lifecycle(&mut peer, "retirement", "resume", control(&cancelled));
    assert_eq!(resumed["retirement"]["logicalRetired"], false);
    assert!(
        fixture
            .profile
            .join("external-history")
            .join(facts["job"]["archiveId"].as_str().unwrap())
            .join("source.bin")
            .exists()
    );
    peer.send(json!({"jsonrpc":"2.0","id":591,"method":"migration/history/retirement/run","params":control(&prepared)}));
    assert_eq!(
        peer.response(591)["error"]["message"],
        "external_history_retirement_stale_sequence"
    );
    lifecycle(&mut peer, "retirement", "run", control(&resumed));
    assert_eq!(
        settled(&mut peer, &op, &job)["retirement"]["phase"],
        "collected"
    );
    peer.shutdown();
}

#[test]
fn history_lifecycle_audit_pages_are_ten_scoped_records_and_durable_refs_block_collection() {
    use kcoder_migration::{history_jobs::HistoryJobStore, history_sources::HistorySourceBinding};
    use kcoder_state::external_history::{
        ExternalHistoryStore,
        lifecycle::{ArchiveReferenceKind, ArchiveReferenceOwner},
    };
    use kcoder_types::{external_history::ExternalHistoryOrigin, migration::MigrationSourceKind};
    let fixture = Fixture::new();
    let jobs = HistoryJobStore::open(&fixture.profile).unwrap();
    let mut imported = Vec::new();
    for _ in 0..12 {
        let source = fixture.source(1);
        let origin = ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "owned-audit-page".into(),
            source_session_id: source.file_stem().unwrap().to_str().unwrap().into(),
            source_artifact_id: None,
            source_format: "jsonl/fixture".into(),
            adapter_revision: "fixture/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: None,
            archived: false,
            parent_session_id: None,
        };
        let binding = HistorySourceBinding::capture(
            source.parent().unwrap(),
            std::path::Path::new(source.file_name().unwrap()),
            origin,
            &mut |_, _| true,
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut job = jobs.create(&id, &binding).unwrap();
        for _ in 0..16 {
            if job.stage == kcoder_types::external_history::HistoryImportStage::Normalized {
                break;
            }
            job = jobs.step(&id, job.sequence, 10, |_| true).unwrap();
        }
        assert_eq!(
            job.stage,
            kcoder_types::external_history::HistoryImportStage::Normalized
        );
        imported.push(job);
    }
    let mut server = fixture.start();
    let mut prepared = Vec::new();
    for job in &imported {
        prepared.push(lifecycle(&mut server,"retirement","prepare",json!({"operationId":uuid::Uuid::new_v4().to_string(),"jobId":job.job_id,"expectedJobSequence":job.sequence})));
    }
    let first = lifecycle(&mut server, "retirement", "list", json!({}));
    assert_eq!(first["items"].as_array().unwrap().len(), 10);
    let second = lifecycle(
        &mut server,
        "retirement",
        "list",
        json!({"cursor":first["nextCursor"]}),
    );
    assert_eq!(second["items"].as_array().unwrap().len(), 2);
    assert!(second["nextCursor"].is_null());
    let mut peer = fixture.start();
    peer.send(json!({"jsonrpc":"2.0","id":595,"method":"migration/history/retirement/list","params":{"cursor":first["nextCursor"]}}));
    assert_eq!(
        peer.response(595)["error"]["message"],
        "history_retirement_invalid_cursor"
    );
    let archives = ExternalHistoryStore::open_existing(&fixture.profile)
        .unwrap()
        .unwrap();
    let reader = jobs.archive_reader(&imported[0].job_id).unwrap();
    let receipt = archives
        .retain_archive_reference(
            ArchiveReferenceOwner::new(
                ArchiveReferenceKind::Preparation,
                &uuid::Uuid::new_v4().to_string(),
                &"d".repeat(64),
            )
            .unwrap(),
            &[reader.lifecycle_guard()],
        )
        .unwrap();
    drop(reader);
    lifecycle(&mut server, "retirement", "run", control(&prepared[0]));
    let operation = prepared[0]["retirement"]["operationId"].as_str().unwrap();
    let blocked = settled(&mut server, operation, &imported[0].job_id);
    assert_eq!(
        blocked["retirement"]["failureCode"], "external_history_retirement_referenced",
        "{blocked}"
    );
    assert_eq!(blocked["retirement"]["logicalRetired"], false);
    assert_eq!(blocked["retirement"]["retainedReferences"], 1);
    archives.release_archive_reference(&receipt).unwrap();
    let resumed = lifecycle(&mut server, "retirement", "resume", control(&blocked));
    lifecycle(&mut server, "retirement", "run", control(&resumed));
    assert_eq!(
        settled(&mut server, operation, &imported[0].job_id)["retirement"]["phase"],
        "collected"
    );
    assert!(
        jobs.archive_reader(&imported[1].job_id).is_ok(),
        "collection affected an unselected archive"
    );
    peer.shutdown();
    server.shutdown();
}
