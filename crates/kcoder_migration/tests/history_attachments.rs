use base64::{Engine, engine::general_purpose::STANDARD};
use kcoder_migration::{
    history_attachments::HistoryAttachmentView, history_jobs::HistoryJobStore,
    history_sources::HistorySourceBinding,
};
use kcoder_types::{external_history::*, historical_attachment::*, migration::MigrationSourceKind};
use serde_json::{Value, json};
use std::{fs, path::Path};

#[path = "history_attachments/jobs.rs"]
mod jobs;
#[path = "history_attachments/tool_results.rs"]
mod tool_results;

struct Fixture {
    profile: tempfile::TempDir,
    job: String,
    source: Vec<u8>,
}
impl Fixture {
    fn new(kind: MigrationSourceKind, records: Vec<Value>, escape_base64: bool) -> Self {
        let mut source = records
            .into_iter()
            .map(|v| v.to_string() + "\n")
            .collect::<String>();
        if escape_base64 {
            source = source
                .replace('+', "\\u002b")
                .replace('/', "\\/")
                .replace('😀', "\\ud83d\\ude00");
        }
        let profile = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("selected.jsonl"), &source).unwrap();
        let binding = HistorySourceBinding::capture(
            root.path(),
            Path::new("selected.jsonl"),
            ExternalHistoryOrigin {
                source: kind,
                source_artifact_id: None,
                source_instance: "fixture".into(),
                source_session_id: "session".into(),
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
        let store = HistoryJobStore::open(profile.path()).unwrap();
        let job = uuid::Uuid::new_v4().to_string();
        let mut state = store.create(&job, &binding).unwrap();
        for _ in 0..100 {
            if state.stage == HistoryImportStage::Normalized {
                break;
            }
            state = store.step(&job, state.sequence, 10, |_| true).unwrap();
        }
        assert_eq!(state.stage, HistoryImportStage::Normalized);
        assert_eq!(
            fs::read(root.path().join("selected.jsonl")).unwrap(),
            source.as_bytes()
        );
        Self {
            profile,
            job,
            source: source.into_bytes(),
        }
    }
    fn view(&self) -> HistoryAttachmentView {
        HistoryAttachmentView::open(
            HistoryJobStore::open(self.profile.path())
                .unwrap()
                .archive_reader(&self.job)
                .unwrap(),
        )
        .unwrap()
    }
    fn original(&self) -> Vec<u8> {
        let reader = HistoryJobStore::open(self.profile.path())
            .unwrap()
            .archive_reader(&self.job)
            .unwrap();
        let mut result = Vec::new();
        for record in reader.records(0, 10).unwrap().records {
            let mut input = reader.open_record(record.ordinal).unwrap();
            std::io::Read::read_to_end(&mut input, &mut result).unwrap();
        }
        result
    }
}
fn claude(blocks: Value) -> Value {
    json!({"type":"user","uuid":"entry","sessionId":"session","version":"2.1.301","message":{"role":"user","content":blocks}})
}
fn codex(blocks: Value) -> Value {
    json!({"type":"response_item","payload":{"type":"message","role":"user","content":blocks}})
}
fn body(
    view: &HistoryAttachmentView,
    record: u64,
    block: u32,
    replacement: Option<u32>,
    bytes: u64,
) -> Vec<u8> {
    let mut out = Vec::new();
    while (out.len() as u64) < bytes {
        let chunk = view
            .read_chunk(
                record,
                block,
                replacement,
                out.len() as u64,
                131_071,
                |stage, _| {
                    assert_eq!(
                        stage,
                        HistoricalAttachmentStage::Extracting,
                        "blob reads must not rescan the archived base64 string"
                    );
                    true
                },
            )
            .unwrap();
        assert!(!chunk.is_empty());
        assert!(chunk.len() <= 131_071);
        out.extend(chunk);
    }
    out
}

#[test]
fn claude_binary_is_streamed_through_json_escapes_reopens_and_preserves_the_archive() {
    let bytes: Vec<u8> = (0..900_001).map(|v| (v % 253) as u8).collect();
    let f = Fixture::new(
        MigrationSourceKind::ClaudeCode,
        vec![claude(json!([
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":STANDARD.encode(&bytes)}}
        ]))],
        true,
    );
    let view = f.view();
    let info = view.inspect(0, 0, None, |_, _| true).unwrap();
    assert_eq!(info.kind, HistoricalAttachmentKind::EmbeddedBase64);
    assert!(info.receipt.is_none());
    let mut inspected = 0;
    let mut extracted = 0;
    let info = view
        .extract(0, 0, None, HISTORICAL_ATTACHMENT_MAX_BYTES, |stage, at| {
            let progress = if stage == HistoricalAttachmentStage::Inspecting {
                &mut inspected
            } else {
                &mut extracted
            };
            assert!(
                at >= *progress,
                "progress must not run backwards within a stage"
            );
            *progress = at;
            true
        })
        .unwrap();
    assert_eq!(info.receipt.unwrap().bytes, bytes.len() as u64);
    assert_eq!(body(&view, 0, 0, None, bytes.len() as u64), bytes);
    drop(view);
    let view = f.view();
    assert!(
        view.inspect(0, 0, None, |_, _| true)
            .unwrap()
            .receipt
            .is_some()
    );
    assert_eq!(body(&view, 0, 0, None, bytes.len() as u64), bytes);
    assert_eq!(f.original(), f.source);
}

#[test]
fn codex_data_url_and_compacted_replacements_keep_distinct_payloads() {
    let f = Fixture::new(
        MigrationSourceKind::Codex,
        vec![
            codex(json!([{"type":"input_image","image_url":"data:image/png;base64,AAECA/8="}])),
            json!({"type":"compacted","payload":{"message":"summary","replacement_history":[
            {"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/jpeg;base64,AQID"}]},
            {"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/jpeg;base64,BAUG"}]}
        ],"replacement_history_metadata":[{},{}]}}),
        ],
        true,
    );
    let view = f.view();
    view.extract(0, 0, None, 20, |_, _| true).unwrap();
    assert_eq!(body(&view, 0, 0, None, 5), [0, 1, 2, 3, 255]);
    let a = view
        .extract(1, 0, Some(0), 20, |_, _| true)
        .unwrap()
        .receipt
        .unwrap();
    let b = view
        .extract(1, 0, Some(1), 20, |_, _| true)
        .unwrap()
        .receipt
        .unwrap();
    assert_ne!(a.attachment_id, b.attachment_id);
    assert_eq!(body(&view, 1, 0, Some(0), 3), [1, 2, 3]);
    assert_eq!(body(&view, 1, 0, Some(1), 3), [4, 5, 6]);
    assert!(view.extract(1, 0, None, 20, |_, _| true).is_err());
}

#[test]
fn text_documents_decode_utf8_and_surrogates_as_bytes_without_rendering_html() {
    let text = "中文 😀 <script>window.NEVER_RUN=1</script>\n".repeat(20_000);
    let f = Fixture::new(
        MigrationSourceKind::ClaudeCode,
        vec![claude(json!([
            {"type":"document","title":"../../报告.txt","source":{"type":"text","media_type":"text/plain","data":text}}
        ]))],
        true,
    );
    let view = f.view();
    let info = view
        .extract(0, 0, None, HISTORICAL_ATTACHMENT_MAX_BYTES, |_, _| true)
        .unwrap();
    assert_eq!(info.kind, HistoricalAttachmentKind::EmbeddedText);
    assert_eq!(info.display_name.as_deref(), Some("报告.txt"));
    assert_eq!(body(&view, 0, 0, None, text.len() as u64), text.as_bytes());
    assert_eq!(f.original(), f.source);
}

#[test]
fn remote_ids_urls_and_local_paths_are_explained_without_reading_or_fetching_them() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = format!(
        "http://{}/secret-canary.png",
        listener.local_addr().unwrap()
    );
    let f = Fixture::new(
        MigrationSourceKind::Codex,
        vec![codex(json!([
            {"type":"input_image","image_url":address},
            {"type":"input_image","file_id":"PRIVATE_REMOTE_FILE_CANARY"},
            {"type":"input_file","path":"/must/not/read/private-canary.pdf"},
            {"type":"input_image","image_url":"file:///must/not/read/private-canary.png"},
            {"type":"input_image","image_url":"javascript:NEVER_RUN"}
        ]))],
        false,
    );
    let view = f.view();
    for (index, kind) in [
        HistoricalAttachmentKind::RemoteReference,
        HistoricalAttachmentKind::RemoteReference,
        HistoricalAttachmentKind::LocalReference,
        HistoricalAttachmentKind::LocalReference,
        HistoricalAttachmentKind::Unsupported,
    ]
    .into_iter()
    .enumerate()
    {
        let info = view.inspect(0, index as u32, None, |_, _| true).unwrap();
        assert_eq!(info.kind, kind);
        assert!(info.issue.is_some());
        let wire = serde_json::to_string(&info).unwrap();
        assert!(!wire.contains("CANARY"));
        assert!(!wire.contains("private-canary"));
        assert!(!wire.contains(&address));
        assert!(
            view.extract(0, index as u32, None, 100, |_, _| true)
                .is_err()
        );
    }
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn malformed_base64_cancellation_and_decoded_limits_never_publish_a_receipt() {
    let bytes = vec![42u8; 400_000];
    let f = Fixture::new(
        MigrationSourceKind::ClaudeCode,
        vec![claude(json!([
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"SGVsbG8=tail"}},
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":STANDARD.encode(&bytes)}}
        ]))],
        false,
    );
    let view = f.view();
    assert!(view.extract(0, 0, None, 100, |_, _| true).is_err());
    assert!(
        view.inspect(0, 0, None, |_, _| true)
            .unwrap()
            .receipt
            .is_none()
    );
    assert!(view.extract(0, 1, None, 10, |_, _| true).is_err());
    assert!(
        view.extract(
            0,
            1,
            None,
            HISTORICAL_ATTACHMENT_MAX_BYTES,
            |stage, at| stage == HistoricalAttachmentStage::Inspecting || at < 50_000
        )
        .is_err()
    );
    assert!(
        view.inspect(0, 1, None, |_, _| true)
            .unwrap()
            .receipt
            .is_none()
    );
    let info = f
        .view()
        .extract(0, 1, None, HISTORICAL_ATTACHMENT_MAX_BYTES, |_, _| true)
        .unwrap();
    assert_eq!(
        body(&f.view(), 0, 1, None, info.receipt.unwrap().bytes),
        bytes
    );
    assert_eq!(f.original(), f.source);
}
