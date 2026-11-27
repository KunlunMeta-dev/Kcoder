//! Independent search review fixtures; source tools and model requests never run.
use kcoder_migration::{
    history_display::HistoryArchiveView,
    history_jobs::HistoryJobStore,
    history_search::{HistorySearchSource, SEARCH_READ_BYTES, SearchNeedle, SearchPosition},
    history_sources::HistorySourceBinding,
};
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use std::{fs, path::Path};

struct Fixture {
    _profile: tempfile::TempDir,
    view: HistoryArchiveView,
}

fn fixture(content: &str) -> Fixture {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let raw = format!(
        r#"{{"type":"assistant","uuid":"message","sessionId":"session","version":"2.1.301","message":{{"role":"assistant","content":{content}}}}}
"#
    );
    fs::write(source.path().join("selected.jsonl"), raw).unwrap();
    let binding = HistorySourceBinding::capture(
        source.path(),
        Path::new("selected.jsonl"),
        ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "review-fixture".into(),
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
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut job = store.create(&id, &binding).unwrap();
    for _ in 0..100 {
        if job.stage == HistoryImportStage::Normalized {
            break;
        }
        job = store.step(&id, job.sequence, 10, |_| true).unwrap();
    }
    assert_eq!(job.stage, HistoryImportStage::Normalized);
    let view = HistoryArchiveView::open(store.archive_reader(&id).unwrap()).unwrap();
    Fixture {
        _profile: profile,
        view,
    }
}

#[test]
fn case_insensitive_greek_final_sigma_matches_uppercase() {
    let fixture = fixture(r#"[{"type":"text","text":"ΟΣ"}]"#);
    let page = HistorySearchSource::Archive(&fixture.view)
        .page(
            &SearchNeedle::new("ος", false).unwrap(),
            SearchPosition::default(),
            10,
            |_| true,
        )
        .unwrap();
    assert_eq!(
        page.items.len(),
        1,
        "Greek final sigma must match ordinary uppercase sigma"
    );
    assert_eq!(page.items[0].found.matched, "ΟΣ");
}

#[test]
fn case_insensitive_search_keeps_user_metacharacters_literal() {
    let fixture = fixture(r#"[{"type":"text","text":"q123"},{"type":"text","text":"q.*"}]"#);
    let page = HistorySearchSource::Archive(&fixture.view)
        .page(
            &SearchNeedle::new("q.*", false).unwrap(),
            SearchPosition::default(),
            10,
            |_| true,
        )
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].found.block.index, 1);
    assert_eq!(page.items[0].found.matched, "q.*");
}

#[test]
fn structured_tool_text_searches_decoded_json_strings() {
    let fixture = fixture(
        r#"[{"type":"tool_result","tool_use_id":"old","content":[{"type":"text","text":"before \u4e2d\u6587 \ud83d\ude00 after"}]}]"#,
    );
    let page = HistorySearchSource::Archive(&fixture.view)
        .page(
            &SearchNeedle::new("中文 😀", true).unwrap(),
            SearchPosition::default(),
            10,
            |_| true,
        )
        .unwrap();
    assert_eq!(
        page.items.len(),
        1,
        "structured tool-result text is readable decoded content"
    );
    assert_eq!(page.items[0].found.matched, "中文 😀");
}

#[test]
fn structured_tool_attachments_and_opaque_children_do_not_become_text_search_hits() {
    let fixture = fixture(
        r#"[{"type":"tool_result","tool_use_id":"old","content":[{"type":"text","text":"Visible tool result"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"BINARY_SEARCH_CANARY"}},{"type":"redacted_thinking","data":"OPAQUE_SEARCH_CANARY"}]}]"#,
    );
    let source = HistorySearchSource::Archive(&fixture.view);
    for query in ["BINARY_SEARCH_CANARY", "OPAQUE_SEARCH_CANARY"] {
        let page = source
            .page(
                &SearchNeedle::new(query, true).unwrap(),
                SearchPosition::default(),
                10,
                |_| true,
            )
            .unwrap();
        assert!(
            page.items.is_empty(),
            "non-text tool content must not surface: {query}"
        );
    }
}

#[test]
fn a_match_crossing_the_current_budget_pause_is_retained_on_resume() {
    let text = "x".repeat((SEARCH_READ_BYTES - 64 * 1024 - 3) as usize) + "Cross頁";
    let content = serde_json::to_string(&serde_json::json!([{"type":"text","text":text}])).unwrap();
    let fixture = fixture(&content);
    let source = HistorySearchSource::Archive(&fixture.view);
    let needle = SearchNeedle::new("Cross頁", true).unwrap();
    let first = source
        .page(&needle, SearchPosition::default(), 10, |_| true)
        .unwrap();
    assert!(first.items.is_empty());
    let next = source
        .page(
            &needle,
            first.next.expect("bounded scan should pause"),
            10,
            |_| true,
        )
        .unwrap();
    assert_eq!(next.items.len(), 1);
    assert_eq!(next.items[0].found.matched, "Cross頁");
}
