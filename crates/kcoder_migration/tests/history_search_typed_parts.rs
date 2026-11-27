use kcoder_migration::{
    history_jobs::HistoryJobStore,
    history_normalization::HISTORY_NORMALIZATION_REVISION,
    history_search::typed_parts::{self, TypedPartsCursor, TypedTextPart},
    history_sources::HistorySourceBinding,
};
use kcoder_state::external_history::ExternalHistoryReader;
use kcoder_types::{external_history::*, imported_transcript::*, migration::MigrationSourceKind};
use std::{fs, io::Read, path::Path};

struct Fixture {
    _profile: tempfile::TempDir,
    archive: ExternalHistoryReader,
    parent: HistoricalValueRef,
}
fn fixture(output: &str) -> Fixture {
    fixture_impl(output, false)
}
fn fixture_impl(output: &str, direct_range: bool) -> Fixture {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let raw = format!(
        r#"{{"type":"assistant","uuid":"m","sessionId":"s","version":"2.1.301","message":{{"role":"assistant","content":[{{"type":"tool_result","tool_use_id":"old","content":{output}}}]}}}}
"#
    );
    serde_json::from_str::<serde_json::Value>(&raw).unwrap();
    let original_offset = raw.find(output).unwrap() as u64;
    fs::write(source.path().join("selected.jsonl"), &raw).unwrap();
    let binding = HistorySourceBinding::capture(
        source.path(),
        Path::new("selected.jsonl"),
        ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "typed-parts-fixture".into(),
            source_session_id: "s".into(),
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
    let id = uuid::Uuid::new_v4().to_string();
    let mut job = jobs.create(&id, &binding).unwrap();
    for _ in 0..100 {
        if job.stage == HistoryImportStage::Normalized {
            break;
        }
        job = jobs.step(&id, job.sequence, 10, |_| true).unwrap();
    }
    assert_eq!(job.stage, HistoryImportStage::Normalized);
    let archive = jobs.archive_reader(&id).unwrap();
    // The dense native scanner test is independent of the projection metadata
    // budget. Its exact range is constructed and JSON-validated by this fixture.
    let parent = if direct_range {
        HistoricalValueRef {
            record: 0,
            offset: original_offset,
            bytes: output.len() as u64,
            encoding: HistoricalValueEncoding::Json,
            decoded_bytes: None,
            decoded_sha256: None,
            preview: None,
        }
    } else {
        let record = archive
            .projection(HISTORY_NORMALIZATION_REVISION, false)
            .unwrap()
            .unwrap()
            .record(0)
            .unwrap();
        let HistoricalRecordData::Message { blocks, .. } = record.data else {
            panic!("fixture must be a message")
        };
        let HistoricalBlock::ToolResult { output: parent, .. } = &blocks[0] else {
            panic!("fixture must be a tool result")
        };
        parent.clone()
    };
    Fixture {
        _profile: profile,
        archive,
        parent,
    }
}
fn text(fixture: &Fixture, part: &TypedTextPart) -> String {
    assert!(part.value.encoding == HistoricalValueEncoding::JsonString);
    assert!(part.value.offset >= fixture.parent.offset);
    assert!(part.value.offset + part.value.bytes <= fixture.parent.offset + fixture.parent.bytes);
    let mut raw = Vec::new();
    fixture
        .archive
        .open_record_range(part.value.record, part.value.offset, part.value.bytes)
        .unwrap()
        .read_to_end(&mut raw)
        .unwrap();
    serde_json::from_slice(&raw).unwrap()
}
fn collect(fixture: &Fixture, budget: usize) -> (Vec<TypedTextPart>, u64, u64, usize) {
    let (mut cursor, mut parts, mut unsupported, mut excluded, mut calls) =
        (None, Vec::new(), 0, 0, 0);
    let mut previous = None;
    let mut read_total = 0;
    loop {
        calls += 1;
        assert!(calls < 100_000, "cursor must progress");
        let page =
            typed_parts::next_text(&fixture.archive, &fixture.parent, cursor, budget, |_| true)
                .unwrap();
        assert!(page.read_bytes <= budget as u64);
        read_total += page.read_bytes;
        unsupported += page.unsupported_count;
        excluded += page.excluded_count;
        if let Some(part) = page.part {
            parts.push(part);
        }
        let Some(next) = page.next else {
            if fixture.parent.bytes > typed_parts::MAX_SCAN_BYTES as u64 {
                assert!(
                    read_total < fixture.parent.bytes * 2,
                    "resumption must not rescan prior large payloads"
                );
            }
            break;
        };
        let encoded = serde_json::to_string(&next).unwrap();
        assert!(encoded.len() <= typed_parts::MAX_CURSOR_BYTES);
        assert!(!encoded.contains("PRIVATE_BODY_CANARY"));
        assert!(
            previous.as_ref() != Some(&encoded),
            "no unchanged continuation state"
        );
        previous = Some(encoded.clone());
        cursor = Some(serde_json::from_str::<TypedPartsCursor>(&encoded).unwrap());
    }
    (parts, unsupported, excluded, calls)
}

#[test]
fn typed_text_fields_can_be_reordered_escaped_and_resumed_without_source_strings() {
    let fixture = fixture(
        r#"[{"text":"PRIVATE_BODY_CANARY \u4e2d\u6587 \ud83d\ude00","t\u0079pe":"\u0074ext"},{"type":"image","source":{"data":"EXCLUDED_IMAGE"}},{"type":"redacted_thinking","text":"EXCLUDED_OPAQUE"},{"type":"unknown","text":"UNKNOWN_CONTENT"},"{\"type\":\"text\",\"text\":\"DO_NOT_REPARSE\"}",{"type":"text","text":{"nested":"NO_NESTED_TEXT"}}]"#,
    );
    let (parts, unsupported, excluded, calls) = collect(&fixture, typed_parts::MIN_SCAN_BYTES);
    assert!(calls > 1);
    assert_eq!((parts.len(), unsupported, excluded), (1, 3, 2));
    assert_eq!(parts[0].source_index, 0);
    assert_eq!(text(&fixture, &parts[0]), "PRIVATE_BODY_CANARY 中文 😀");
}

#[test]
fn a_large_attachment_is_skipped_incrementally_and_text_after_it_remains_available() {
    let attachment = "A".repeat(5 * 1024 * 1024 + 17);
    let raw = format!(
        r#"[{{"source":{{"type":"base64","data":"{attachment}"}},"type":"image"}},{{"text":"PRIVATE_BODY_CANARY after image","type":"output_text"}}]"#
    );
    let fixture = fixture(&raw);
    let (parts, unsupported, excluded, calls) = collect(&fixture, 64 * 1024);
    assert!(calls > 80);
    assert_eq!((parts.len(), unsupported, excluded), (1, 0, 1));
    assert_eq!(parts[0].source_index, 1);
    assert_eq!(text(&fixture, &parts[0]), "PRIVATE_BODY_CANARY after image");
}

#[test]
fn large_text_before_its_type_has_a_verified_original_range_after_resuming() {
    let body = "Unicode 中文 😀 and escaped quote \" ".repeat(12_000);
    let raw =
        serde_json::to_string(&serde_json::json!([{"text":body,"type":"input_text"}])).unwrap();
    let fixture = fixture(&raw);
    let (parts, unsupported, excluded, calls) = collect(&fixture, 4096);
    assert!(calls > 10);
    assert_eq!((parts.len(), unsupported, excluded), (1, 0, 0));
    assert_eq!(text(&fixture, &parts[0]), body);
}

#[test]
fn only_a_known_top_level_content_array_is_unwrapped() {
    let known = fixture(
        r#"{"metadata":{"text":"not text"},"content":[{"text":"known wrapper","type":"text"}],"trailer":42}"#,
    );
    let (parts, unsupported, excluded, _) = collect(&known, 256);
    assert_eq!((parts.len(), unsupported, excluded), (1, 0, 0));
    assert_eq!(text(&known, &parts[0]), "known wrapper");
    let unknown =
        fixture(r#"{"other":{"content":[{"type":"text","text":"not a known wrapper"}]}}"#);
    let (parts, unsupported, excluded, _) = collect(&unknown, 256);
    assert_eq!((parts.len(), unsupported, excluded), (0, 1, 0));
}

#[test]
fn cursors_are_parent_bound_bounded_and_cancellable() {
    let fixture = fixture(&format!(
        r#"[{{"type":"image","source":{{"data":"{}"}}}}]"#,
        "A".repeat(4096)
    ));
    let first =
        typed_parts::next_text(&fixture.archive, &fixture.parent, None, 256, |_| true).unwrap();
    let cursor = first.next.unwrap();
    let mut other = fixture.parent.clone();
    other.offset += 1;
    other.bytes -= 1;
    assert!(
        typed_parts::next_text(&fixture.archive, &other, Some(cursor.clone()), 256, |_| {
            true
        })
        .is_err()
    );
    assert!(
        typed_parts::next_text(&fixture.archive, &fixture.parent, Some(cursor), 256, |_| {
            false
        })
        .is_err()
    );
    for budget in [0, 255, typed_parts::MAX_SCAN_BYTES + 1] {
        assert!(
            typed_parts::next_text(&fixture.archive, &fixture.parent, None, budget, |_| true)
                .is_err()
        );
    }
}

#[test]
fn ten_thousand_short_parts_reuse_a_request_owned_window_with_linear_source_reads() {
    let body = "x".repeat(64);
    let raw = serde_json::to_string(
        &(0..10_000)
            .map(|_| serde_json::json!({"type":"text","text":body}))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let fixture = fixture_impl(&raw, true);
    let (mut cursor, mut count, mut read_bytes) = (None, 0, 0);
    let mut cache = typed_parts::TypedPartsCache::default();
    loop {
        let page = typed_parts::next_text_cached(
            &fixture.archive,
            &fixture.parent,
            cursor,
            typed_parts::MAX_SCAN_BYTES,
            &mut cache,
            |_| true,
        )
        .unwrap();
        read_bytes += page.read_bytes;
        if let Some(part) = page.part {
            assert_eq!(part.source_index, count);
            count += 1;
        }
        let Some(next) = page.next else {
            break;
        };
        cursor = Some(next);
    }
    assert_eq!(count, 10_000);
    assert!(
        read_bytes <= fixture.parent.bytes * 2,
        "source-byte amplification: {read_bytes} for {}",
        fixture.parent.bytes
    );
}

#[test]
fn uncached_short_parts_are_adaptive_and_cached_bytes_never_cross_sources() {
    let raw = serde_json::to_string(
        &(0..400)
            .map(|_| serde_json::json!({"type":"text","text":"short"}))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let many = fixture(&raw);
    let (mut cursor, mut count, mut bytes) = (None, 0, 0);
    loop {
        let page = typed_parts::next_text(
            &many.archive,
            &many.parent,
            cursor,
            typed_parts::MAX_SCAN_BYTES,
            |_| true,
        )
        .unwrap();
        bytes += page.read_bytes;
        count += u64::from(page.part.is_some());
        let Some(next) = page.next else {
            break;
        };
        cursor = Some(next);
    }
    assert_eq!(count, 400);
    assert!(bytes <= many.parent.bytes * 4);
    let first = fixture(r#"[{"type":"text","text":"AAA"}]"#);
    let second = fixture(r#"[{"type":"file","text":"BBB"}]"#);
    assert_eq!(first.parent.bytes, second.parent.bytes);
    let mut cache = typed_parts::TypedPartsCache::default();
    assert!(
        typed_parts::next_text_cached(&first.archive, &first.parent, None, 256, &mut cache, |_| {
            true
        })
        .unwrap()
        .part
        .is_some()
    );
    let page = typed_parts::next_text_cached(
        &second.archive,
        &second.parent,
        None,
        256,
        &mut cache,
        |_| true,
    )
    .unwrap();
    assert!(page.part.is_none());
    assert_eq!(page.excluded_count, 1);
}
