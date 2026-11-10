use kcoder_config::PrivateDirectory;
use kcoder_migration::{
    history_attachments::HistoryAttachmentView,
    history_branches::HistoryBranchStore,
    history_jobs::HistoryJobStore,
    history_sources::HistorySourceBinding,
    history_tool_attachments::HistoryToolAttachments,
    local_attachment::{HistoryLocalAttachments, LocalAttachmentRequest},
};
use kcoder_state::external_history::local_attachment::SelectedLocalFile;
use kcoder_types::{
    external_history::*, historical_attachment::*, local_attachment::*,
    migration::MigrationSourceKind,
};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};
struct Fixture {
    profile: tempfile::TempDir,
    chosen: PathBuf,
    job: String,
    source: Vec<u8>,
    position: u64,
    tool: bool,
}
impl Fixture {
    fn new(kind: MigrationSourceKind, tool: bool) -> Self {
        let profile = tempfile::tempdir().unwrap();
        let input = tempfile::tempdir().unwrap();
        let chosen = profile.path().join("explicit-choice");
        PrivateDirectory::open_or_create(&chosen).unwrap();
        fs::write(
            chosen.join("replacement.bin"),
            b"user explicitly selected these bytes",
        )
        .unwrap();
        let attachment = if kind == MigrationSourceKind::ClaudeCode {
            json!({"type":"file","filename":"historical.bin","path":"/NOT_AUTHORIZED/historical.bin","media_type":"application/octet-stream"})
        } else {
            json!({"type":"input_file","filename":"historical.bin","file_path":"C:\\NOT_AUTHORIZED\\historical.bin","media_type":"application/octet-stream"})
        };
        let blocks = if tool {
            json!([{"type":"tool_result","tool_use_id":"old","content":[{"type":"text","text":"not an attachment"},attachment]}])
        } else {
            json!([attachment])
        };
        let records = if kind == MigrationSourceKind::ClaudeCode {
            vec![
                json!({"type":"user","uuid":"entry","parentUuid":null,"sessionId":"session","version":"2.1.301","message":{"role":"user","content":blocks}}),
            ]
        } else {
            vec![
                json!({"type":"session_meta","payload":{"id":"session","cli_version":"0.163.0"}}),
                if tool {
                    json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"old","output":[{"type":"input_text","text":"not an attachment"},attachment]}})
                } else {
                    json!({"type":"response_item","payload":{"type":"message","role":"user","content":blocks}})
                },
            ]
        };
        let source = records
            .into_iter()
            .map(|value| value.to_string() + "\n")
            .collect::<String>()
            .into_bytes();
        fs::write(input.path().join("selected.jsonl"), &source).unwrap();
        let binding = HistorySourceBinding::capture(
            input.path(),
            Path::new("selected.jsonl"),
            ExternalHistoryOrigin {
                source: kind,
                source_instance: "fixture".into(),
                source_session_id: "session".into(),
                source_artifact_id: None,
                source_format: "jsonl".into(),
                adapter_revision: "raw/1".into(),
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
        let jobs = HistoryJobStore::open(profile.path()).unwrap();
        let job = uuid::Uuid::new_v4().to_string();
        let mut result = jobs.create(&job, &binding).unwrap();
        while result.stage != HistoryImportStage::Normalized {
            result = jobs.step(&job, result.sequence, 10, |_| true).unwrap();
            assert!(!matches!(
                result.stage,
                HistoryImportStage::Failed | HistoryImportStage::Cancelled
            ));
        }
        let position = if kind == MigrationSourceKind::Codex {
            1
        } else {
            0
        };
        if tool {
            HistoryToolAttachments::open_with_revision(
                jobs.archive_reader(&job).unwrap(),
                position,
                0,
                None,
                &jobs.normalization_revision(&job).unwrap(),
            )
            .unwrap()
            .build(|_, _| true)
            .unwrap();
        }
        Self {
            profile,
            chosen,
            job,
            source,
            position,
            tool,
        }
    }
    fn selection(&self) -> HistoricalAttachmentSelection {
        HistoricalAttachmentSelection {
            job_id: self.job.clone(),
            view_id: None,
            position: self.position,
            block_index: 0,
            tool_item_index: self.tool.then_some(0),
        }
    }
    fn request(&self, selection: &HistoricalAttachmentSelection) -> LocalAttachmentRequest {
        HistoryLocalAttachments::prepare_selection(self.profile.path(), selection, |_| true)
            .unwrap()
    }
    fn selected(&self) -> SelectedLocalFile {
        SelectedLocalFile::select(&self.chosen, Path::new("replacement.bin"), true, |_| true)
            .unwrap()
    }
    fn archive_bytes(&self) -> Vec<u8> {
        let jobs = HistoryJobStore::open(self.profile.path()).unwrap();
        let reader = jobs.archive_reader(&self.job).unwrap();
        let mut out = Vec::new();
        for record in reader.records(0, 10).unwrap().records {
            std::io::Read::read_to_end(&mut reader.open_record(record.ordinal).unwrap(), &mut out)
                .unwrap();
        }
        out
    }
}
#[test]
fn both_sources_messages_and_typed_tool_items_require_explicit_selection_and_keep_old_derivations()
{
    for source in [MigrationSourceKind::ClaudeCode, MigrationSourceKind::Codex] {
        for tool in [false, true] {
            let fixture = Fixture::new(source, tool);
            let selection = fixture.selection();
            let unfilled = HistoryLocalAttachments::inspect_reference(
                fixture.profile.path(),
                &selection,
                |_| true,
            )
            .unwrap();
            assert_eq!(unfilled.kind, HistoricalAttachmentKind::LocalReference);
            assert!(unfilled.receipt.is_none());
            assert!(
                !fixture
                    .profile
                    .path()
                    .join("migrations/history-local-attachments")
                    .exists()
            );
            let local = HistoryLocalAttachments::open(fixture.profile.path()).unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let request = fixture.request(&selection);
            let selected = fixture.selected();
            let approved = local.authorize(&id, &request, &selected).unwrap();
            assert!(approved.state.stage == HistoricalLocalAttachmentStage::Authorized);
            assert!(!approved.historical_content_verified);
            let copied = local.run(&id, approved.state.sequence, |_| true).unwrap();
            assert!(copied.state.stage == HistoricalLocalAttachmentStage::Ready);
            assert_eq!(copied.info.kind, HistoricalAttachmentKind::LocalReference);
            assert!(copied.info.issue.is_none());
            assert!(!copied.historical_content_verified);
            let receipt = copied.state.receipt.clone().unwrap();
            assert_eq!(
                local.chunk(&id, &selection, &receipt, 0, 256).unwrap(),
                b"user explicitly selected these bytes"
            );
            fs::remove_dir_all(&fixture.chosen).unwrap();
            drop(local);
            let reopened = HistoryLocalAttachments::open_existing(fixture.profile.path())
                .unwrap()
                .unwrap();
            assert!(
                reopened.read(&id).unwrap().state.stage == HistoricalLocalAttachmentStage::Ready
            );
            assert_eq!(
                reopened.chunk(&id, &selection, &receipt, 0, 256).unwrap(),
                b"user explicitly selected these bytes"
            );
            assert!(
                reopened
                    .chunk(
                        &id,
                        &HistoricalAttachmentSelection {
                            block_index: 1,
                            ..selection.clone()
                        },
                        &receipt,
                        0,
                        256
                    )
                    .is_err()
            );
            let old = HistoryLocalAttachments::inspect_reference(
                fixture.profile.path(),
                &selection,
                |_| true,
            )
            .unwrap();
            assert!(old.receipt.is_none());
            assert_eq!(
                old.issue.as_deref(),
                Some("history_attachment_local_grant_required")
            );
            assert_eq!(fixture.archive_bytes(), fixture.source);
            let public = serde_json::to_string(&copied).unwrap();
            assert!(!public.contains(fixture.chosen.to_str().unwrap()));
            assert!(!public.contains("NOT_AUTHORIZED"));
        }
    }
}
#[test]
fn request_identity_cannot_switch_reference_and_owner_directory_replacement_is_rejected() {
    let fixture = Fixture::new(MigrationSourceKind::ClaudeCode, false);
    let store = HistoryLocalAttachments::open(fixture.profile.path()).unwrap();
    let selection = fixture.selection();
    let id = uuid::Uuid::new_v4().to_string();
    let request = fixture.request(&selection);
    let selected = fixture.selected();
    store.authorize(&id, &request, &selected).unwrap();
    let branches = HistoryBranchStore::open(fixture.profile.path()).unwrap();
    let branch = branches.prepare(&fixture.job, &[]).unwrap().view_id;
    branches.build(&fixture.job, &branch, || true).unwrap();
    let other = fixture.request(&HistoricalAttachmentSelection {
        view_id: Some(branch),
        ..selection.clone()
    });
    assert!(store.authorize(&id, &other, &selected).is_err());
    let peer = Fixture::new(MigrationSourceKind::Codex, false);
    let peer_request = peer.request(&peer.selection());
    let peer_store = HistoryLocalAttachments::open(peer.profile.path()).unwrap();
    assert!(
        peer_store
            .authorize(&uuid::Uuid::new_v4().to_string(), &request, &selected)
            .is_err()
    );
    assert!(
        store
            .authorize(&uuid::Uuid::new_v4().to_string(), &peer_request, &selected)
            .is_err()
    );
    let journal = fixture
        .profile
        .path()
        .join("migrations/history-local-attachments");
    fs::rename(&journal, fixture.profile.path().join("saved-owned-jobs")).unwrap();
    PrivateDirectory::open_or_create(&journal).unwrap();
    assert!(store.read(&id).is_err());
}
#[test]
fn selected_branch_coordinates_are_bound_without_promoting_raw_or_unselected_content() {
    let fixture = Fixture::new(MigrationSourceKind::ClaudeCode, false);
    let branches = HistoryBranchStore::open(fixture.profile.path()).unwrap();
    let view = branches.prepare(&fixture.job, &[]).unwrap().view_id;
    branches.build(&fixture.job, &view, || true).unwrap();
    let selection = HistoricalAttachmentSelection {
        view_id: Some(view),
        ..fixture.selection()
    };
    let store = HistoryLocalAttachments::open(fixture.profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let request = fixture.request(&selection);
    let approved = store.authorize(&id, &request, &fixture.selected()).unwrap();
    let ready = store.run(&id, approved.state.sequence, |_| true).unwrap();
    let receipt = ready.state.receipt.unwrap();
    assert_eq!(
        store.chunk(&id, &selection, &receipt, 0, 256).unwrap(),
        b"user explicitly selected these bytes"
    );
    assert!(
        store
            .chunk(&id, &fixture.selection(), &receipt, 0, 256)
            .is_err()
    );
    let jobs = HistoryJobStore::open(fixture.profile.path()).unwrap();
    let old = HistoryAttachmentView::open_with_revision(
        jobs.archive_reader(&fixture.job).unwrap(),
        &jobs.normalization_revision(&fixture.job).unwrap(),
    )
    .unwrap()
    .inspect(0, 0, None, |_, _| true)
    .unwrap();
    assert!(old.receipt.is_none());
}

#[test]
fn an_independent_observer_cancels_the_owned_copy_and_stale_resume_cannot_clear_new_cancellation() {
    let fixture = Fixture::new(MigrationSourceKind::ClaudeCode, false);
    fs::write(fixture.chosen.join("replacement.bin"), vec![4u8; 700000]).unwrap();
    let selection = fixture.selection();
    let store = HistoryLocalAttachments::open(fixture.profile.path()).unwrap();
    let peer = HistoryLocalAttachments::open(fixture.profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let request = fixture.request(&selection);
    let approved = store.authorize(&id, &request, &fixture.selected()).unwrap();
    let mut sent = false;
    let stopped = store
        .run(&id, approved.state.sequence, |bytes| {
            if bytes >= 65536 && !sent {
                let cancellation = peer.cancel(&id).unwrap();
                assert!(cancellation.state.cancel_requested);
                sent = true;
            }
            true
        })
        .unwrap();
    assert!(stopped.state.stage == HistoricalLocalAttachmentStage::Cancelled);
    assert!(stopped.state.cancel_requested);
    assert_eq!(stopped.state.cancel_revision, 1);
    let newer = peer.cancel(&id).unwrap();
    assert_eq!(newer.state.cancel_revision, 2);
    assert!(store.run(&id, stopped.state.sequence, |_| true).is_err());
    let ready = store.run(&id, newer.state.sequence, |_| true).unwrap();
    assert!(ready.state.stage == HistoricalLocalAttachmentStage::Ready);
    assert!(!ready.state.cancel_requested);
}
