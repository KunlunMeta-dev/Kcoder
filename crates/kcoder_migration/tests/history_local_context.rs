//! Synthetic references plus explicitly selected actual bytes exercise native compilation/preparation.
use kcoder_config::PrivateDirectory;
use kcoder_migration::{
    history_branches::HistoryBranchStore,
    history_context::{HistoryContextCompiler, HistoryContextPhase},
    history_context_preparations::{
        HistoryPreparationOutcome, HistoryPreparationProgress, prepare_with_local_attachments,
    },
    history_jobs::HistoryJobStore,
    history_sources::HistorySourceBinding,
    local_attachment::HistoryLocalAttachments,
};
use kcoder_state::{
    external_history::local_attachment::SelectedLocalFile,
    historical_contexts::HistoricalContextStore,
};
use kcoder_types::{
    external_history::*, historical_attachment::*, historical_context::*, local_attachment::*,
    migration::MigrationSourceKind,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

struct Fixture {
    profile: tempfile::TempDir,
    chosen: PathBuf,
    job: String,
    view: String,
    selection: HistoricalAttachmentSelection,
}
impl Fixture {
    fn new(kind: MigrationSourceKind, tool: bool, image: bool) -> Self {
        Self::with_parts(kind, tool, image, 1)
    }
    fn with_parts(kind: MigrationSourceKind, tool: bool, image: bool, text_parts: usize) -> Self {
        let profile = tempfile::tempdir().unwrap();
        let input = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let attachment = match (kind, image) {
            (MigrationSourceKind::ClaudeCode, true) => {
                json!({"type":"image","path":"/NEVER_READ/original.png","filename":"UNTRUSTED.exe","media_type":"text/plain"})
            }
            (MigrationSourceKind::ClaudeCode, false) => {
                json!({"type":"document","path":"/NEVER_READ/original.pdf","title":"UNTRUSTED.pdf","media_type":"application/pdf"})
            }
            (MigrationSourceKind::Codex, true) => {
                json!({"type":"input_image","image_url":"file:///NEVER_READ/original.png","media_type":"text/plain"})
            }
            (MigrationSourceKind::Codex, false) => {
                json!({"type":"input_file","file_path":"C:\\NEVER_READ\\original.pdf","filename":"UNTRUSTED.pdf","media_type":"application/pdf"})
            }
        };
        let mut parts = (0..text_parts)
            .map(|_| json!({"type":"text","text":"before"}))
            .collect::<Vec<_>>();
        parts.push(attachment.clone());
        parts.push(json!({"type":"text","text":"after"}));
        let records = match kind {
            MigrationSourceKind::ClaudeCode if tool => vec![
                json!({"type":"assistant","uuid":"call","sessionId":session,"version":"2.1.301","message":{"role":"assistant","content":[{"type":"tool_use","id":"old","name":"Bash","input":{"command":"touch NEVER_REPLAY_LOCAL"}}]}}),
                json!({"type":"user","uuid":"result","parentUuid":"call","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"old","content":parts}]}}),
            ],
            MigrationSourceKind::ClaudeCode => vec![
                json!({"type":"user","uuid":"entry","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[attachment]}}),
            ],
            MigrationSourceKind::Codex => {
                let mut records = vec![
                    json!({"type":"session_meta","payload":{"id":session,"cli_version":"0.163.0"}}),
                ];
                if tool {
                    records.extend([
                    json!({"type":"response_item","payload":{"type":"function_call","call_id":"old","name":"Bash","arguments":"{\"command\":\"touch NEVER_REPLAY_LOCAL\"}"}}),
                    json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"old","output":parts}})
                ]);
                } else {
                    records.push(json!({"type":"response_item","payload":{"type":"message","role":"user","content":[attachment]}}));
                }
                records
            }
        };
        fs::write(
            input.path().join("selected.jsonl"),
            records
                .iter()
                .map(|record| format!("{record}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let binding = HistorySourceBinding::capture(
            input.path(),
            Path::new("selected.jsonl"),
            ExternalHistoryOrigin {
                source: kind,
                source_instance: "owned-local-context-fixture".into(),
                source_session_id: session,
                source_artifact_id: None,
                source_format: "synthetic-jsonl".into(),
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
        let mut progress = jobs.create(&job, &binding).unwrap();
        while progress.stage != HistoryImportStage::Normalized {
            progress = jobs.step(&job, progress.sequence, 10, |_| true).unwrap();
            assert!(!matches!(
                progress.stage,
                HistoryImportStage::Failed | HistoryImportStage::Cancelled
            ));
        }
        let branches = HistoryBranchStore::open(profile.path()).unwrap();
        let view = branches.prepare(&job, &[]).unwrap().view_id;
        let branch = branches.build(&job, &view, || true).unwrap();
        assert_eq!(branch.structural_complete, Some(true));
        branches.correlate(&job, &view, None, || true).unwrap();
        let position = branches
            .page(&job, &view, 0, |_| true)
            .unwrap()
            .items
            .last()
            .unwrap()
            .position;
        if tool {
            branches
                .tool_attachments(&job, &view, position, 0)
                .unwrap()
                .build(|_, _| true)
                .unwrap();
        }
        let selection = HistoricalAttachmentSelection {
            job_id: job.clone(),
            view_id: Some(view.clone()),
            position,
            block_index: 0,
            tool_item_index: tool.then_some(0),
        };
        let chosen = profile.path().join("explicit-choice");
        PrivateDirectory::open_or_create(&chosen).unwrap();
        Self {
            profile,
            chosen,
            job,
            view,
            selection,
        }
    }
    fn supply(&self, bytes: &[u8]) -> HistoricalLocalAttachmentBinding {
        fs::write(self.chosen.join("selected.bin"), bytes).unwrap();
        let selected =
            SelectedLocalFile::select(&self.chosen, Path::new("selected.bin"), true, |_| true)
                .unwrap();
        let request = HistoryLocalAttachments::prepare_selection(
            self.profile.path(),
            &self.selection,
            |_| true,
        )
        .unwrap();
        let store = HistoryLocalAttachments::open(self.profile.path()).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let authorized = store.authorize(&id, &request, &selected).unwrap();
        let ready = store.run(&id, authorized.state.sequence, |_| true).unwrap();
        assert!(ready.state.stage == HistoricalLocalAttachmentStage::Ready);
        assert!(!ready.historical_content_verified);
        HistoricalLocalAttachmentBinding {
            operation_id: id,
            selection: self.selection.clone(),
            receipt: ready.state.receipt.unwrap(),
        }
    }
    fn compile(&self, values: &[HistoricalLocalAttachmentBinding]) -> HistoricalContextCompilation {
        HistoryContextCompiler::open(self.profile.path())
            .unwrap()
            .compile_with_local_attachments(
                &self.job,
                &self.view,
                Default::default(),
                values,
                |_| true,
            )
            .unwrap()
    }
}
fn encoded_image(format: image::ImageFormat) -> Vec<u8> {
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(32, 24)
        .write_to(&mut output, format)
        .unwrap();
    output.into_inner()
}
fn blocked(value: &HistoricalContextCompilation, code: &str) {
    assert!(!value.report.context_compiled);
    assert!(value.document.is_none() && value.binding.is_none());
    assert!(
        value.report.issues.iter().any(|issue| issue.code == code),
        "{:?}",
        value.report
    );
}

#[test]
fn both_vendors_and_typed_tool_results_prepare_actual_image_and_text_with_explicit_provenance() {
    for vendor in [MigrationSourceKind::ClaudeCode, MigrationSourceKind::Codex] {
        for tool in [false, true] {
            for (bytes, expected) in [
                (encoded_image(image::ImageFormat::Png), "image/png"),
                (encoded_image(image::ImageFormat::Jpeg), "image/jpeg"),
                ("用户补充文档😀\n".as_bytes().to_vec(), "text/plain"),
            ] {
                let fixture = Fixture::new(vendor, tool, expected.starts_with("image/"));
                let binding = fixture.supply(&bytes);
                fs::remove_file(fixture.chosen.join("selected.bin")).unwrap();
                blocked(
                    &fixture.compile(&[]),
                    if tool {
                        "history_context_attachment_collection_required"
                    } else {
                        "history_context_attachment_required"
                    },
                );
                let compiled = fixture.compile(std::slice::from_ref(&binding));
                assert!(compiled.report.context_compiled, "{:?}", compiled.report);
                let document = compiled.document.unwrap();
                let actual = &document.attachments[0];
                assert_eq!(actual.media_type.as_deref(), Some(expected));
                assert_eq!(actual.receipt, binding.receipt);
                assert!(
                    matches!(&actual.provenance,Some(HistoricalContextAttachmentProvenance::UserSuppliedLocal{operation_id}) if *operation_id==binding.operation_id)
                );
                assert!(
                    !serde_json::to_string(&document)
                        .unwrap()
                        .contains("UNTRUSTED")
                );
                let entry = document
                    .entries
                    .iter()
                    .find(|entry| entry.kind == HistoricalContextFactKind::AttachmentReference)
                    .unwrap();
                let supplied: Value = serde_json::from_str(&entry.text).unwrap();
                assert_eq!(supplied["historicalContentVerified"], false);
                assert_eq!(entry.source_array_index, tool.then_some(1));
                let id = uuid::Uuid::new_v4().to_string();
                let prepared = prepare_with_local_attachments(
                    fixture.profile.path(),
                    &id,
                    &fixture.job,
                    &fixture.view,
                    Default::default(),
                    std::slice::from_ref(&binding),
                    |_| true,
                )
                .unwrap();
                let HistoryPreparationOutcome::Prepared { receipt, .. } = prepared else {
                    panic!("valid supplied bytes must prepare")
                };
                let store = HistoricalContextStore::open_existing(fixture.profile.path())
                    .unwrap()
                    .unwrap();
                let reader = store.reader(&id, |_| true).unwrap();
                assert_eq!(
                    reader.context().document.attachments[0].receipt,
                    binding.receipt
                );
                assert_eq!(
                    reader
                        .attachment_chunk(0, 0, HISTORICAL_ATTACHMENT_CHUNK_BYTES)
                        .unwrap(),
                    bytes
                );
                assert_eq!(reader.context().receipt, receipt);
                assert!(!fixture.profile.path().join("NEVER_REPLAY_LOCAL").exists());
            }
        }
    }
}

#[test]
fn unsupported_or_invalid_bytes_never_make_a_compiled_or_prepared_context() {
    let fixture = Fixture::new(MigrationSourceKind::ClaudeCode, false, false);
    for (bytes, code) in [
        (
            b"%PDF-1.7\nnot a validated PDF".to_vec(),
            "history_context_local_media_unsupported",
        ),
        (
            b"<svg xmlns='x'>active content</svg>".to_vec(),
            "history_context_local_media_unsupported",
        ),
        (vec![0xff, 0xfe, 0x01], "history_context_local_text_invalid"),
        (
            b"binary\0payload".to_vec(),
            "history_context_local_text_invalid",
        ),
        (
            b"\x89PNG\r\n\x1a\nbroken".to_vec(),
            "history_context_local_image_invalid",
        ),
        (
            encoded_image(image::ImageFormat::Gif),
            "history_context_local_media_unsupported",
        ),
    ] {
        let binding = fixture.supply(&bytes);
        blocked(&fixture.compile(std::slice::from_ref(&binding)), code);
        let id = uuid::Uuid::new_v4().to_string();
        assert!(matches!(
            prepare_with_local_attachments(
                fixture.profile.path(),
                &id,
                &fixture.job,
                &fixture.view,
                Default::default(),
                &[binding],
                |_| true
            )
            .unwrap(),
            HistoryPreparationOutcome::Blocked(_)
        ));
        assert!(
            !fixture
                .profile
                .path()
                .join("historical-contexts")
                .join(id)
                .exists()
        );
    }
}

#[test]
fn explicit_receipt_selection_and_operation_cannot_be_replaced_by_a_newer_supply() {
    let fixture = Fixture::new(MigrationSourceKind::ClaudeCode, false, false);
    let old = fixture.supply(b"first explicit document");
    let newer = fixture.supply(b"second explicit document");
    assert_eq!(
        fixture
            .compile(std::slice::from_ref(&old))
            .document
            .unwrap()
            .attachments[0]
            .receipt,
        old.receipt
    );
    let mut wrong = old.clone();
    wrong.receipt = newer.receipt.clone();
    assert!(
        HistoryContextCompiler::open(fixture.profile.path())
            .unwrap()
            .compile_with_local_attachments(
                &fixture.job,
                &fixture.view,
                Default::default(),
                &[wrong],
                |_| true
            )
            .is_err()
    );
    let mut wrong = old.clone();
    wrong.selection.view_id = None;
    assert!(
        HistoryContextCompiler::open(fixture.profile.path())
            .unwrap()
            .compile_with_local_attachments(
                &fixture.job,
                &fixture.view,
                Default::default(),
                &[wrong],
                |_| true
            )
            .is_err()
    );
    let duplicate = [old.clone(), old.clone()];
    assert!(
        HistoryContextCompiler::open(fixture.profile.path())
            .unwrap()
            .compile_with_local_attachments(
                &fixture.job,
                &fixture.view,
                Default::default(),
                &duplicate,
                |_| true
            )
            .is_err()
    );
    let id = uuid::Uuid::new_v4().to_string();
    prepare_with_local_attachments(
        fixture.profile.path(),
        &id,
        &fixture.job,
        &fixture.view,
        Default::default(),
        std::slice::from_ref(&old),
        |_| true,
    )
    .unwrap();
    assert!(
        prepare_with_local_attachments(
            fixture.profile.path(),
            &id,
            &fixture.job,
            &fixture.view,
            Default::default(),
            &[newer],
            |_| true
        )
        .is_err()
    );
}

#[test]
fn original_budgets_and_cancellation_preserve_no_partial_success() {
    let fixture = Fixture::new(MigrationSourceKind::ClaudeCode, false, false);
    let text = ("x".repeat(HISTORICAL_ATTACHMENT_CHUNK_BYTES - 1) + "😀END").into_bytes();
    let binding = fixture.supply(&text);
    assert!(
        fixture
            .compile(std::slice::from_ref(&binding))
            .report
            .context_compiled
    );
    for policy in [
        HistoricalContextPolicy {
            max_attachments: 0,
            ..Default::default()
        },
        HistoricalContextPolicy {
            max_attachment_bytes: 4,
            ..Default::default()
        },
    ] {
        let value = HistoryContextCompiler::open(fixture.profile.path())
            .unwrap()
            .compile_with_local_attachments(
                &fixture.job,
                &fixture.view,
                policy,
                std::slice::from_ref(&binding),
                |_| true,
            )
            .unwrap();
        blocked(&value, "history_context_attachment_budget_exceeded");
    }
    assert!(
        HistoryContextCompiler::open(fixture.profile.path())
            .unwrap()
            .compile_with_local_attachments(
                &fixture.job,
                &fixture.view,
                Default::default(),
                std::slice::from_ref(&binding),
                |value| !matches!(value.phase, HistoryContextPhase::VerifyingAttachment)
            )
            .is_err()
    );
    let id = uuid::Uuid::new_v4().to_string();
    assert!(
        prepare_with_local_attachments(
            fixture.profile.path(),
            &id,
            &fixture.job,
            &fixture.view,
            Default::default(),
            std::slice::from_ref(&binding),
            |value| !matches!(value, HistoryPreparationProgress::Copying(_))
        )
        .is_err()
    );
    let store = HistoricalContextStore::open_existing(fixture.profile.path())
        .unwrap()
        .unwrap();
    assert!(store.reader(&id, |_| true).is_err());
}

#[test]
fn legacy_attachment_bytes_round_trip_without_a_new_field_or_hash_change() {
    let old = r#"{"selection":{"jobId":"job","viewId":"view","position":0,"blockIndex":0},"sourceArrayIndex":null,"receipt":{"attachmentId":"a","bytes":0,"sha256":"0","chunkBytes":262144},"mediaType":"text/plain","displayName":"old.txt"}"#;
    let parsed: HistoricalContextAttachment = serde_json::from_str(old).unwrap();
    assert!(parsed.provenance.is_none());
    assert_eq!(serde_json::to_string(&parsed).unwrap(), old);
}

#[test]
fn dense_typed_result_keeps_the_existing_part_gate_even_with_an_authorized_local_file() {
    let fixture = Fixture::with_parts(MigrationSourceKind::ClaudeCode, true, false, 2049);
    let binding = fixture.supply(b"explicit supplied text");
    blocked(
        &fixture.compile(&[binding]),
        "history_context_part_budget_exceeded",
    );
}

#[test]
fn image_dimensions_and_unused_bindings_are_explicit_blockers() {
    let fixture = Fixture::new(MigrationSourceKind::ClaudeCode, false, true);
    let mut image = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(8193, 1)
        .write_to(&mut image, image::ImageFormat::Png)
        .unwrap();
    let binding = fixture.supply(image.get_ref());
    blocked(
        &fixture.compile(std::slice::from_ref(&binding)),
        "history_context_local_image_budget_exceeded",
    );
    let mut unused = binding;
    unused.selection.position += 100;
    blocked(
        &fixture.compile(&[unused]),
        "history_context_local_binding_unused",
    );
}

#[test]
fn continuation_canonical_options_persist_exact_bindings_without_upgrading_legacy_jobs() {
    use kcoder_migration::history_continuation_jobs::ContinuationJobs;
    use kcoder_types::{StudioWorkMode, historical_continuation::HistoricalContinuationOptions};
    let fixture = Fixture::new(MigrationSourceKind::ClaudeCode, false, false);
    let workspace = tempfile::tempdir().unwrap();
    let original = fixture.supply(b"first explicit supplement");
    let options = |values| HistoricalContinuationOptions {
        model: None,
        settings_template: None,
        studio_work_mode: StudioWorkMode::Kcoder,
        local_attachments: values,
    };
    let store = ContinuationJobs::open(fixture.profile.path(), workspace.path()).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    let accepted = store
        .create(
            &key,
            &fixture.job,
            &fixture.view,
            Default::default(),
            options(vec![original.clone()]),
        )
        .unwrap();
    assert_eq!(accepted.options.local_attachments, vec![original.clone()]);
    drop(store);
    let store = ContinuationJobs::open_existing(fixture.profile.path(), workspace.path())
        .unwrap()
        .unwrap();
    assert_eq!(store.read(&key).unwrap(), accepted);
    let newer = fixture.supply(b"a different explicitly supplied document");
    assert!(
        store
            .create(
                &key,
                &fixture.job,
                &fixture.view,
                Default::default(),
                options(vec![newer])
            )
            .is_err()
    );
    let legacy_id = uuid::Uuid::new_v4().to_string();
    store
        .create(
            &legacy_id,
            &fixture.job,
            &fixture.view,
            Default::default(),
            options(vec![]),
        )
        .unwrap();
    let journal = fixture
        .profile
        .path()
        .join("migrations/history-continuations")
        .join(format!("{legacy_id}.json"));
    let before = fs::read(&journal).unwrap();
    assert!(!String::from_utf8_lossy(&before).contains("localAttachments"));
    assert!(
        store
            .create(
                &legacy_id,
                &fixture.job,
                &fixture.view,
                Default::default(),
                options(vec![original.clone()])
            )
            .is_err()
    );
    assert_eq!(fs::read(journal).unwrap(), before);
    for values in [vec![original.clone(), original.clone()], {
        let mut wrong = original;
        wrong.selection.view_id = None;
        vec![wrong]
    }] {
        let rejected = uuid::Uuid::new_v4().to_string();
        assert!(
            store
                .create(
                    &rejected,
                    &fixture.job,
                    &fixture.view,
                    Default::default(),
                    options(values)
                )
                .is_err()
        );
        assert!(
            !fixture
                .profile
                .path()
                .join("migrations/history-continuations")
                .join(format!("{rejected}.json"))
                .exists()
        );
    }
}
