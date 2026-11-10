use super::*;
use kcoder_migration::history_search::{
    HistorySearchSource, SEARCH_READ_BYTES, SearchNeedle, SearchPosition,
};

#[test]
fn search_reads_decoded_bodies_beyond_previews_and_preserves_unicode_case() {
    let fixture=fixture_text(MigrationSourceKind::ClaudeCode,
        "{\"type\":\"assistant\",\"uuid\":\"one\",\"sessionId\":\"session\",\"version\":\"2.1.301\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"before \\u4e2d\\u6587 \\ud83d\\ude00 İSTANBUL after\"}]}}\n".into());
    let source = HistorySearchSource::Archive(&fixture.view);
    let page = source
        .page(
            &SearchNeedle::new("中文 😀", true).unwrap(),
            SearchPosition::default(),
            10,
            |_| true,
        )
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].found.matched, "中文 😀");
    let unicode = source
        .page(
            &SearchNeedle::new("i\u{307}stanbul", false).unwrap(),
            SearchPosition::default(),
            10,
            |_| true,
        )
        .unwrap();
    assert_eq!(unicode.items[0].found.matched, "İSTANBUL");
    assert!(
        source
            .page(
                &SearchNeedle::new("istanbul", true).unwrap(),
                SearchPosition::default(),
                10,
                |_| true
            )
            .unwrap()
            .items
            .is_empty()
    );
}

#[test]
fn a_match_crossing_a_body_window_is_found_without_indexing_only_the_preview() {
    let text = "x".repeat(65_532) + "Needle終";
    let fixture = fixture(
        MigrationSourceKind::ClaudeCode,
        vec![claude(json!([{"type":"text","text":text}]))],
    );
    assert!(
        !fixture.view.page(0, |_| true).unwrap().items[0].blocks[0]
            .preview
            .as_ref()
            .unwrap()
            .contains("Needle")
    );
    let page = HistorySearchSource::Archive(&fixture.view)
        .page(
            &SearchNeedle::new("needle終", false).unwrap(),
            SearchPosition::default(),
            10,
            |_| true,
        )
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].found.matched, "Needle終");
    assert_eq!(page.items[0].body_start, 0);
}

#[test]
fn long_unmatched_prefixes_continue_in_bounded_reads_and_do_not_report_a_false_empty_result() {
    let text = "z".repeat(5 * 1024 * 1024) + "THE_LATE_MATCH";
    let fixture = fixture(
        MigrationSourceKind::ClaudeCode,
        vec![claude(json!([{"type":"text","text":text}]))],
    );
    let source = HistorySearchSource::Archive(&fixture.view);
    let needle = SearchNeedle::new("late_match", false).unwrap();
    let first = source
        .page(&needle, SearchPosition::default(), 10, |_| true)
        .unwrap();
    assert!(first.items.is_empty());
    assert!(first.next.is_some());
    assert!(first.processed_bytes <= SEARCH_READ_BYTES);
    assert!(first.processed_bytes > 0);
    let next = source
        .page(&needle, first.next.unwrap(), 10, |_| true)
        .unwrap();
    assert_eq!(next.items.len(), 1);
    assert!(next.next.is_none());
    assert!(next.items[0].body_start > 64 * 1024);
    assert!(next.processed_bytes > first.processed_bytes);
}

#[test]
fn result_pages_search_blocks_after_the_ten_block_preview_and_exclude_signatures_and_opaque_payloads()
 {
    let mut blocks: Vec<Value> = (0..12)
        .map(|i| json!({"type":"text","text":format!("needle {i}")}))
        .collect();
    blocks.push(
        json!({"type":"thinking","thinking":"visible thought","signature":"SIGNATURE_CANARY"}),
    );
    blocks.push(json!({"type":"redacted_thinking","data":"OPAQUE_CANARY"}));
    blocks.push(
        json!({"type":"tool_use","id":"old","name":"Bash","input":{"command":"needle command"}}),
    );
    blocks.push(json!({"type":"tool_result","tool_use_id":"old","content":"needle result"}));
    let fixture = fixture(
        MigrationSourceKind::ClaudeCode,
        vec![claude(Value::Array(blocks))],
    );
    let source = HistorySearchSource::Archive(&fixture.view);
    let needle = SearchNeedle::new("needle", true).unwrap();
    let first = source
        .page(&needle, SearchPosition::default(), 10, |_| true)
        .unwrap();
    assert_eq!(first.items.len(), 10);
    let second = source
        .page(&needle, first.next.unwrap(), 10, |_| true)
        .unwrap();
    assert_eq!(second.items.len(), 4);
    assert_eq!(second.items[0].found.block.index, 10);
    assert!(
        second
            .items
            .iter()
            .any(|hit| hit.found.block.kind == HistoricalDisplayBlockKind::ToolResult)
    );
    for canary in ["SIGNATURE_CANARY", "OPAQUE_CANARY"] {
        assert!(
            source
                .page(
                    &SearchNeedle::new(canary, true).unwrap(),
                    SearchPosition::default(),
                    10,
                    |_| true
                )
                .unwrap()
                .items
                .is_empty()
        );
    }
}

#[test]
fn search_cancels_validates_queries_and_never_modifies_the_archive() {
    let fixture = fixture(
        MigrationSourceKind::ClaudeCode,
        vec![claude(json!([{"type":"text","text":"needle"}]))],
    );
    let before = std::fs::read_dir(&fixture.archive).unwrap().count();
    assert!(
        HistorySearchSource::Archive(&fixture.view)
            .page(
                &SearchNeedle::new("needle", true).unwrap(),
                SearchPosition::default(),
                10,
                |_| false
            )
            .is_err()
    );
    assert!(SearchNeedle::new("   ", false).is_err());
    assert!(SearchNeedle::new(&"中".repeat(257), false).is_err());
    assert_eq!(std::fs::read_dir(&fixture.archive).unwrap().count(), before);
    assert!(
        HistorySearchSource::Archive(&fixture.view)
            .page(
                &SearchNeedle::new("needle", true).unwrap(),
                SearchPosition::default(),
                0,
                |_| true
            )
            .is_err()
    );
}
