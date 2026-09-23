use kcoder_state::{AppState, CompactionTranscriptEvent, CompactionTrigger};
use kcoder_tools::{BashTool, Tool, ToolContext, default_registry, write::MAX_WRITE_CONTENT_BYTES};
use serde_json::json;
use std::io::Write;
use tempfile::TempDir;

#[tokio::test]
async fn file_read_tool_reads_existing_file() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("hello.txt");
    let mut file = std::fs::File::create(&file_path).unwrap();
    writeln!(file, "line one").unwrap();
    writeln!(file, "line two").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("read").unwrap();

    let input = json!({ "file_path": "hello.txt" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("line one"));
    assert!(text.contains("line two"));
}

#[tokio::test]
async fn file_read_tool_returns_image_blocks_for_common_images() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(
        tmp.path().join("screen.png"),
        [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'],
    )
    .unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("read").unwrap();

    let output = tool
        .call(json!({ "file_path": "screen.png" }), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    assert!(content_to_string(&output).contains("Read image"));
    assert!(output.content.iter().any(|block| matches!(
        block,
        kcoder_types::ContentBlock::Image { source }
            if source.media_type == "image/png" && source.data == "iVBORw0KGgo="
    )));
}

#[tokio::test]
async fn file_read_tool_renders_notebook_cells() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(
        tmp.path().join("analysis.ipynb"),
        r##"{
          "cells": [
            {"cell_type": "markdown", "source": ["# Title\n"]},
            {"cell_type": "code", "source": ["print('hi')\n"], "outputs": [{"text": ["hi\n"]}]}
          ]
        }"##,
    )
    .unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("read").unwrap();

    let output = tool
        .call(json!({ "file_path": "analysis.ipynb" }), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("Notebook:"));
    assert!(text.contains("Cell 1 [markdown]"));
    assert!(text.contains("# Title"));
    assert!(text.contains("Cell 2 [code]"));
    assert!(text.contains("print('hi')"));
    assert!(text.contains("Outputs:"));
}

#[tokio::test]
async fn file_read_tool_rejects_binary_extensions() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("archive.zip"), [1, 2, 3, 4]).unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("read").unwrap();

    let output = tool
        .call(json!({ "file_path": "archive.zip" }), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    assert!(content_to_string(&output).contains("cannot read binary files"));
}

#[tokio::test]
async fn file_read_tool_suppresses_duplicate_unchanged_reads() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("hello.txt"), "line one\nline two\n").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("read").unwrap();

    let first = tool
        .call(json!({ "file_path": "hello.txt" }), &ctx)
        .await
        .unwrap();
    let second = tool
        .call(json!({ "file_path": "hello.txt" }), &ctx)
        .await
        .unwrap();

    assert!(!first.is_error);
    assert!(content_to_string(&first).contains("line one"));
    assert!(!second.is_error);
    assert!(content_to_string(&second).contains("File unchanged since last read"));
}

#[tokio::test]
async fn file_read_tool_returns_bounded_anchor_after_compaction() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("hello.txt"), "line one\nline two\n").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state.clone());
    let registry = default_registry();
    let tool = registry.get("read").unwrap();
    let input = json!({ "file_path": "hello.txt" });

    let first = tool.call(input.clone(), &ctx).await.unwrap();
    let duplicate_before_compaction = tool.call(input.clone(), &ctx).await.unwrap();
    assert!(content_to_string(&first).contains("line one"));
    assert!(
        content_to_string(&duplicate_before_compaction).contains("File unchanged since last read")
    );

    state.record_read_tool_call_key("read-1", tmp.path().join("hello.txt"), None, None);
    state.set_messages(vec![
        kcoder_types::Message::Assistant {
            content: vec![kcoder_types::ContentBlock::ToolUse {
                id: "read-1".to_string(),
                name: "read".to_string(),
                input: input.clone(),
            }],
            usage: None,
        },
        kcoder_types::Message::user_content(vec![kcoder_types::ContentBlock::ToolResult {
            tool_use_id: "read-1".to_string(),
            content: first.content.clone(),
            is_error: Some(false),
        }]),
    ]);
    state
        .set_messages_after_compaction(
            vec![kcoder_types::Message::user_text(
                "Earlier conversation summary without the original read result",
            )],
            CompactionTranscriptEvent {
                trigger: CompactionTrigger::Auto,
                pre_tokens: 100,
                post_tokens: 20,
                summary: "compacted state".to_string(),
            },
        )
        .await
        .unwrap();

    let first_after_compaction = tool.call(input.clone(), &ctx).await.unwrap();
    let duplicate_after_compaction = tool.call(input, &ctx).await.unwrap();
    let anchor = content_to_string(&first_after_compaction);
    assert!(anchor.contains("Compaction read anchor"));
    assert!(anchor.contains("head L1: line one"));
    assert!(anchor.len() < 1_000);
    assert!(
        content_to_string(&duplicate_after_compaction).contains("File unchanged since last read")
    );
}

#[tokio::test]
async fn repeated_compactions_do_not_reinject_the_same_large_file() {
    let tmp = TempDir::new().unwrap();
    let large = (1..=600)
        .map(|line| format!("line {line:04}: {}", "payload ".repeat(8)))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(tmp.path().join("large.txt"), large).unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state.clone());
    let tool = default_registry().get("read").unwrap();
    let input = json!({ "file_path": "large.txt" });
    let original = tool.call(input.clone(), &ctx).await.unwrap();
    assert!(content_to_string(&original).len() > 1_000);

    let mut previous_output = original.content;
    for round in 1..=2 {
        let id = format!("large-read-{round}");
        state.record_read_tool_call_key(id.clone(), tmp.path().join("large.txt"), None, None);
        state.set_messages(vec![
            kcoder_types::Message::Assistant {
                content: vec![kcoder_types::ContentBlock::ToolUse {
                    id: id.clone(),
                    name: "read".to_string(),
                    input: input.clone(),
                }],
                usage: None,
            },
            kcoder_types::Message::user_content(vec![kcoder_types::ContentBlock::ToolResult {
                tool_use_id: id,
                content: previous_output,
                is_error: Some(false),
            }]),
        ]);
        state
            .set_messages_after_compaction(
                vec![kcoder_types::Message::user_text(format!(
                    "summary round {round}"
                ))],
                CompactionTranscriptEvent {
                    trigger: CompactionTrigger::Auto,
                    pre_tokens: 10_000,
                    post_tokens: 100,
                    summary: format!("round {round}"),
                },
            )
            .await
            .unwrap();

        let anchor = tool.call(input.clone(), &ctx).await.unwrap();
        let text = content_to_string(&anchor);
        assert!(text.contains("Compaction read anchor"));
        assert!(
            text.len() < 1_000,
            "round {round} returned {} bytes",
            text.len()
        );
        previous_output = anchor.content;
    }
}

#[tokio::test]
async fn range_read_does_not_replace_full_compaction_anchor() {
    let tmp = TempDir::new().unwrap();
    let large = (1..=300)
        .map(|line| format!("line {line:04}: {}", "payload ".repeat(5)))
        .collect::<Vec<_>>()
        .join("\n");
    let path = tmp.path().join("large.txt");
    std::fs::write(&path, large).unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state.clone());
    let tool = default_registry().get("read").unwrap();
    let full = json!({ "file_path": "./large.txt" });
    let original = tool.call(full.clone(), &ctx).await.unwrap();
    state.record_read_tool_call_key("full-1", &path, None, None);
    state.set_messages(vec![
        kcoder_types::Message::Assistant {
            content: vec![kcoder_types::ContentBlock::ToolUse {
                id: "full-1".to_string(),
                name: "read".to_string(),
                input: full.clone(),
            }],
            usage: None,
        },
        kcoder_types::Message::user_content(vec![kcoder_types::ContentBlock::ToolResult {
            tool_use_id: "full-1".to_string(),
            content: original.content,
            is_error: Some(false),
        }]),
    ]);
    state
        .set_messages_after_compaction(
            vec![kcoder_types::Message::user_text("summary")],
            CompactionTranscriptEvent {
                trigger: CompactionTrigger::Auto,
                pre_tokens: 10_000,
                post_tokens: 100,
                summary: "summary".to_string(),
            },
        )
        .await
        .unwrap();
    let anchor = tool.call(full.clone(), &ctx).await.unwrap();
    assert!(content_to_string(&anchor).contains("Compaction read anchor"));

    let range = tool
        .call(
            json!({ "file_path": "large.txt", "offset": 100, "limit": 5 }),
            &ctx,
        )
        .await
        .unwrap();
    assert!(content_to_string(&range).contains("line 0100"));

    let again = tool.call(full, &ctx).await.unwrap();
    let again = content_to_string(&again);
    assert!(again.contains("File unchanged since last read"));
    assert!(!again.contains("line 0100:"));
}

#[tokio::test]
async fn explicit_full_coverage_range_cannot_bypass_a_visible_compaction_anchor() {
    let tmp = TempDir::new().unwrap();
    let original = (1..=89)
        .map(|line| format!("original line {line:02}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let path = tmp.path().join("anchored.txt");
    std::fs::write(&path, &original).unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state.clone());
    let tool = default_registry().get("read").unwrap();
    let full = json!({ "file_path": "anchored.txt" });
    let first = tool.call(full.clone(), &ctx).await.unwrap();
    state.record_read_tool_call_key("full-before-compact", &path, None, None);
    state.set_messages(vec![
        kcoder_types::Message::Assistant {
            content: vec![kcoder_types::ContentBlock::ToolUse {
                id: "full-before-compact".to_string(),
                name: "read".to_string(),
                input: full.clone(),
            }],
            usage: None,
        },
        kcoder_types::Message::user_content(vec![kcoder_types::ContentBlock::ToolResult {
            tool_use_id: "full-before-compact".to_string(),
            content: first.content,
            is_error: Some(false),
        }]),
    ]);
    state
        .set_messages_after_compaction(
            vec![kcoder_types::Message::user_text("summary")],
            CompactionTranscriptEvent {
                trigger: CompactionTrigger::Auto,
                pre_tokens: 10_000,
                post_tokens: 100,
                summary: "summary".to_string(),
            },
        )
        .await
        .unwrap();

    let visible_anchor = content_to_string(&tool.call(full, &ctx).await.unwrap());
    assert!(visible_anchor.contains("Compaction read anchor"));

    // A trailing newline still leaves only 89 visible lines. An explicit range that
    // covers the complete body cannot bypass the visible anchor and reinsert all 89 lines.
    for (offset, limit) in [(1, 89), (1, 90), (0, 89)] {
        let covering = tool
            .call(
                json!({ "file_path": "anchored.txt", "offset": offset, "limit": limit }),
                &ctx,
            )
            .await
            .unwrap();
        let covering = content_to_string(&covering);
        assert!(covering.contains("Compaction read anchor"));
        assert!(covering.len() < 960);
        assert!(!covering.contains("original line 50"));
    }

    let narrow = tool
        .call(
            json!({ "file_path": "anchored.txt", "offset": 40, "limit": 2 }),
            &ctx,
        )
        .await
        .unwrap();
    let narrow = content_to_string(&narrow);
    assert!(narrow.contains("original line 40"));
    assert!(narrow.contains("original line 41"));
    assert!(!narrow.contains("Compaction read anchor"));

    // Even when filesystem timestamp resolution is insufficient, a body change must
    // leave anchor-only state and return current content rather than an old anchor or unchanged stub.
    let changed = original.replace("original line 50", "changed! line 50");
    std::fs::write(&path, changed).unwrap();
    let fresh = tool
        .call(
            json!({ "file_path": "anchored.txt", "offset": 1, "limit": 90 }),
            &ctx,
        )
        .await
        .unwrap();
    let fresh = content_to_string(&fresh);
    assert!(fresh.contains("changed! line 50"));
    assert!(!fresh.contains("Compaction read anchor"));
    assert!(!fresh.contains("File unchanged since last read"));
}

#[tokio::test]
async fn empty_file_zero_limit_keeps_compaction_anchor_only_state() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("empty.txt");
    std::fs::write(&path, "").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state.clone());
    let tool = default_registry().get("read").unwrap();
    let full = json!({ "file_path": "empty.txt" });
    let first = tool.call(full.clone(), &ctx).await.unwrap();
    let messages = vec![
        kcoder_types::Message::Assistant {
            content: vec![kcoder_types::ContentBlock::ToolUse {
                id: "empty-full".to_string(),
                name: "read".to_string(),
                input: full.clone(),
            }],
            usage: None,
        },
        kcoder_types::Message::user_content(vec![kcoder_types::ContentBlock::ToolResult {
            tool_use_id: "empty-full".to_string(),
            content: first.content,
            is_error: Some(false),
        }]),
    ];
    state.record_read_tool_call_key("empty-full", &path, None, None);
    state.mark_read_tool_results_compacted(&messages, &["empty-full".to_string()]);

    let visible_anchor = content_to_string(&tool.call(full, &ctx).await.unwrap());
    assert!(visible_anchor.contains("Compaction read anchor"));
    assert!(visible_anchor.contains("Lines: 0"));

    let covering = tool
        .call(
            json!({ "file_path": "empty.txt", "offset": 1, "limit": 0 }),
            &ctx,
        )
        .await
        .unwrap();
    let covering = content_to_string(&covering);
    assert!(covering.contains("Compaction read anchor"));
    assert!(covering.len() < 960);
}

#[tokio::test]
async fn full_read_offsets_and_lexical_paths_share_one_identity() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("same.txt"), "same body\n").unwrap();
    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let tool = default_registry().get("read").unwrap();

    let first = tool
        .call(json!({ "file_path": "same.txt" }), &ctx)
        .await
        .unwrap();
    assert!(content_to_string(&first).contains("same body"));
    for input in [
        json!({ "file_path": "./same.txt", "offset": 0 }),
        json!({ "file_path": "folder/../same.txt", "offset": 1 }),
    ] {
        let output = tool.call(input, &ctx).await.unwrap();
        assert!(content_to_string(&output).contains("File unchanged since last read"));
    }
}

#[tokio::test]
async fn file_read_tool_returns_fresh_content_when_file_changes_after_compaction() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("hello.txt");
    std::fs::write(&path, "old line\n").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state.clone());
    let tool = default_registry().get("read").unwrap();
    let input = json!({ "file_path": "hello.txt" });
    let first = tool.call(input.clone(), &ctx).await.unwrap();
    state.record_read_tool_call_key("read-changed", tmp.path().join("hello.txt"), None, None);
    state.set_messages(vec![
        kcoder_types::Message::Assistant {
            content: vec![kcoder_types::ContentBlock::ToolUse {
                id: "read-changed".to_string(),
                name: "read".to_string(),
                input: input.clone(),
            }],
            usage: None,
        },
        kcoder_types::Message::user_content(vec![kcoder_types::ContentBlock::ToolResult {
            tool_use_id: "read-changed".to_string(),
            content: first.content,
            is_error: Some(false),
        }]),
    ]);
    state
        .set_messages_after_compaction(
            vec![kcoder_types::Message::user_text("summary")],
            CompactionTranscriptEvent {
                trigger: CompactionTrigger::Auto,
                pre_tokens: 100,
                post_tokens: 20,
                summary: "summary".to_string(),
            },
        )
        .await
        .unwrap();

    // Body comparison must detect change even when a very fast overwrite exceeds filesystem mtime resolution.
    std::fs::write(&path, "new line with different content\n").unwrap();
    let changed = tool.call(input, &ctx).await.unwrap();
    let changed = content_to_string(&changed);
    assert!(changed.contains("new line with different content"));
    assert!(!changed.contains("Compaction read anchor"));
}

#[tokio::test]
async fn file_read_tool_rereads_compacted_ranges_and_allows_different_ranges() {
    let tmp = TempDir::new().unwrap();
    let content = (1..=30)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(tmp.path().join("ranges.txt"), content).unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state.clone());
    let tool = default_registry().get("read").unwrap();
    let first_input = json!({ "file_path": "ranges.txt", "offset": 5, "limit": 3 });
    let first = tool.call(first_input.clone(), &ctx).await.unwrap();
    assert!(content_to_string(&first).contains("line 5"));
    let duplicate = tool.call(first_input.clone(), &ctx).await.unwrap();
    assert!(content_to_string(&duplicate).contains("File unchanged since last read"));

    let messages = vec![
        kcoder_types::Message::Assistant {
            content: vec![kcoder_types::ContentBlock::ToolUse {
                id: "range-read".to_string(),
                name: "read".to_string(),
                input: first_input.clone(),
            }],
            usage: None,
        },
        kcoder_types::Message::user_content(vec![kcoder_types::ContentBlock::ToolResult {
            tool_use_id: "range-read".to_string(),
            content: first.content,
            is_error: Some(false),
        }]),
    ];
    state.record_read_tool_call_key(
        "range-read",
        tmp.path().join("ranges.txt"),
        Some(5),
        Some(3),
    );
    state.mark_read_tool_results_compacted(&messages, &["range-read".to_string()]);

    let reread = tool.call(first_input, &ctx).await.unwrap();
    let reread = content_to_string(&reread);
    assert!(reread.contains("line 5"));
    assert!(!reread.contains("Compaction read anchor"));

    let other_range = tool
        .call(
            json!({ "file_path": "ranges.txt", "offset": 20, "limit": 2 }),
            &ctx,
        )
        .await
        .unwrap();
    assert!(content_to_string(&other_range).contains("line 20"));
}

#[tokio::test]
async fn file_read_tool_reads_utf16le_text() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(
        tmp.path().join("utf16.txt"),
        utf16le_bytes("line one\r\nline two\r\n", true),
    )
    .unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("read").unwrap();

    let output = tool
        .call(json!({ "file_path": "utf16.txt" }), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("line one"));
    assert!(text.contains("line two"));
}

#[tokio::test]
async fn file_read_tool_defaults_to_2000_lines() {
    let tmp = TempDir::new().unwrap();
    let content = (1..=2005)
        .map(|line| format!("line {line:04}"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(tmp.path().join("large.txt"), content).unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("read").unwrap();

    let output = tool
        .call(json!({ "file_path": "large.txt" }), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("Showing lines 1-2000 of 2005"));
    assert!(text.contains("line 2000"));
    assert!(!text.contains("line 2001"));
}

#[tokio::test]
async fn file_read_tool_suggests_similar_missing_file() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("config.toml"), "ok\n").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("read").unwrap();

    let output = tool
        .call(json!({ "file_path": "config.tml" }), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("File does not exist"));
    assert!(text.contains("Current working directory"));
    assert!(text.contains("Did you mean"));
    assert!(text.contains("config.toml"));
}

#[tokio::test]
async fn file_read_tool_tries_alternate_screenshot_space() {
    let tmp = TempDir::new().unwrap();
    let actual_name = format!("Screenshot 2026-06-18 at 10.00.00{}AM.png", '\u{202f}');
    std::fs::write(
        tmp.path().join(actual_name),
        [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'],
    )
    .unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("read").unwrap();

    let output = tool
        .call(
            json!({ "file_path": "Screenshot 2026-06-18 at 10.00.00 AM.png" }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(!output.is_error);
    assert!(content_to_string(&output).contains("Read image"));
}

#[tokio::test]
async fn file_write_tool_creates_file() {
    let tmp = TempDir::new().unwrap();
    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("write").unwrap();

    let input = json!({ "file_path": "new.txt", "content": "hello world" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    let written = std::fs::read_to_string(tmp.path().join("new.txt")).unwrap();
    assert_eq!(written, "hello world");
}

#[tokio::test]
async fn file_write_tool_reports_diff_when_overwriting_file() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("existing.txt"), "old\nsame\n").unwrap();
    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("write").unwrap();
    read_file(&ctx, "existing.txt").await;

    let input = json!({ "file_path": "existing.txt", "content": "new\nsame\n" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("```diff"));
    assert!(text.contains("-old"));
    assert!(text.contains("+new"));
}

#[tokio::test]
async fn file_write_tool_requires_read_before_overwriting_file() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("existing.txt"), "old\n").unwrap();
    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("write").unwrap();

    let input = json!({ "file_path": "existing.txt", "content": "new\n" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("Read it before attempting to write"));
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("existing.txt")).unwrap(),
        "old\n"
    );
}

#[tokio::test]
async fn file_write_tool_rejects_stale_read_before_overwriting_file() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("existing.txt"), "old\n").unwrap();
    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("write").unwrap();
    read_file(&ctx, "existing.txt").await;
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(tmp.path().join("existing.txt"), "user change\n").unwrap();

    let input = json!({ "file_path": "existing.txt", "content": "new\n" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("unexpectedly modified"));
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("existing.txt")).unwrap(),
        "user change\n"
    );
}

#[tokio::test]
async fn file_write_tool_rejects_content_over_one_call_limit() {
    let tmp = TempDir::new().unwrap();
    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("write").unwrap();

    let input = json!({
        "file_path": "too-large.txt",
        "content": "x".repeat(MAX_WRITE_CONTENT_BYTES + 1)
    });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("content exceeds write tool limit"));
    assert!(text.contains("256 KiB"));
    assert!(!tmp.path().join("too-large.txt").exists());
}

#[tokio::test]
async fn file_write_tool_rejects_directory_target() {
    let tmp = TempDir::new().unwrap();
    std::fs::create_dir(tmp.path().join("dir.txt")).unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("write").unwrap();

    let output = tool
        .call(json!({ "file_path": "dir.txt", "content": "new\n" }), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    assert!(content_to_string(&output).contains("directory, not a file"));
}

#[tokio::test]
async fn file_write_tool_rejects_existing_non_utf8_file() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("binary.txt");
    std::fs::write(&file_path, [0xff, 0xfe, 0xfd]).unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("write").unwrap();

    let error = tool
        .call(
            json!({ "file_path": "binary.txt", "content": "new\n" }),
            &ctx,
        )
        .await
        .unwrap_err();

    assert!(error.to_string().contains("non-UTF-8"));
    assert_eq!(std::fs::read(&file_path).unwrap(), vec![0xff, 0xfe, 0xfd]);
}

#[tokio::test]
async fn file_write_tool_preserves_utf16le_encoding_when_overwriting() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("utf16.txt");
    std::fs::write(&file_path, utf16le_bytes("old\n", true)).unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("write").unwrap();
    read_file(&ctx, "utf16.txt").await;

    let output = tool
        .call(
            json!({ "file_path": "utf16.txt", "content": "new\n" }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(!output.is_error);
    let bytes = std::fs::read(&file_path).unwrap();
    assert!(bytes.starts_with(&[0xff, 0xfe]));
    assert_eq!(decode_utf16le_bytes(&bytes), "new\n");
}

#[tokio::test]
async fn file_edit_tool_replaces_string() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("test.txt");
    std::fs::write(&file_path, "foo bar baz").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();
    read_file(&ctx, "test.txt").await;

    let input = json!({ "file_path": "test.txt", "old_string": "bar", "new_string": "qux" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    let written = std::fs::read_to_string(&file_path).unwrap();
    assert_eq!(written, "foo qux baz");
}

#[tokio::test]
async fn file_edit_tool_matches_normalized_crlf_and_preserves_crlf() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("test.txt");
    std::fs::write(&file_path, "alpha\r\nbeta\r\ngamma\r\n").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();
    read_file(&ctx, "test.txt").await;

    let output = tool
        .call(
            json!({
                "file_path": "test.txt",
                "old_string": "alpha\nbeta",
                "new_string": "alpha\ndelta"
            }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(!output.is_error);
    assert_eq!(
        std::fs::read_to_string(&file_path).unwrap(),
        "alpha\r\ndelta\r\ngamma\r\n"
    );
}

#[tokio::test]
async fn file_edit_tool_preserves_utf16le_encoding() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("utf16.txt");
    std::fs::write(&file_path, utf16le_bytes("alpha\r\nbeta\r\n", true)).unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();
    read_file(&ctx, "utf16.txt").await;

    let output = tool
        .call(
            json!({
                "file_path": "utf16.txt",
                "old_string": "alpha\nbeta",
                "new_string": "alpha\ngamma"
            }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(!output.is_error);
    let bytes = std::fs::read(&file_path).unwrap();
    assert!(bytes.starts_with(&[0xff, 0xfe]));
    assert_eq!(decode_utf16le_bytes(&bytes), "alpha\r\ngamma\r\n");
}

#[tokio::test]
async fn file_edit_tool_requires_read_before_modifying_existing_file() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("test.txt");
    std::fs::write(&file_path, "foo bar baz").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();

    let input = json!({ "file_path": "test.txt", "old_string": "bar", "new_string": "qux" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("Read it before attempting to edit"));
    assert_eq!(std::fs::read_to_string(&file_path).unwrap(), "foo bar baz");
}

#[tokio::test]
async fn file_edit_tool_reports_missing_old_string() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("test.txt");
    std::fs::write(&file_path, "foo bar baz").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();
    read_file(&ctx, "test.txt").await;

    let input = json!({ "file_path": "test.txt", "old_string": "missing", "new_string": "qux" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("old_string not found in file"));
    assert!(text.contains("test.txt"));
    let written = std::fs::read_to_string(&file_path).unwrap();
    assert_eq!(written, "foo bar baz");
}

#[tokio::test]
async fn file_edit_tool_rejects_same_old_and_new_string() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("test.txt"), "foo bar baz").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();
    read_file(&ctx, "test.txt").await;

    let input = json!({ "file_path": "test.txt", "old_string": "bar", "new_string": "bar" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    assert!(content_to_string(&output).contains("old_string and new_string"));
}

#[tokio::test]
async fn file_edit_tool_rejects_non_unique_old_string_without_replace_all() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("test.txt");
    std::fs::write(&file_path, "foo\nbar\nbar\n").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();
    read_file(&ctx, "test.txt").await;

    let input = json!({ "file_path": "test.txt", "old_string": "bar", "new_string": "qux" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("Found 2 matches"));
    assert_eq!(
        std::fs::read_to_string(&file_path).unwrap(),
        "foo\nbar\nbar\n"
    );
}

#[tokio::test]
async fn file_edit_tool_replace_all_updates_every_match() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("test.txt");
    std::fs::write(&file_path, "foo\nbar\nbar\n").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();
    read_file(&ctx, "test.txt").await;

    let input = json!({
        "file_path": "test.txt",
        "old_string": "bar",
        "new_string": "qux",
        "replace_all": true
    });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    assert_eq!(
        std::fs::read_to_string(&file_path).unwrap(),
        "foo\nqux\nqux\n"
    );
}

#[tokio::test]
async fn file_edit_tool_accepts_string_replace_all() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("test.txt");
    std::fs::write(&file_path, "foo\nbar\nbar\n").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();
    read_file(&ctx, "test.txt").await;

    let input = json!({
        "file_path": "test.txt",
        "old_string": "bar",
        "new_string": "qux",
        "replace_all": "true"
    });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    assert_eq!(
        std::fs::read_to_string(&file_path).unwrap(),
        "foo\nqux\nqux\n"
    );
}

#[tokio::test]
async fn file_edit_tool_desanitizes_hidden_tokens_before_matching() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("test.txt");
    std::fs::write(
        &file_path,
        "<function_results><name>old</name></function_results>\n",
    )
    .unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();
    read_file(&ctx, "test.txt").await;

    let input = json!({
        "file_path": "test.txt",
        "old_string": "<fnr><n>old</n></function_results>",
        "new_string": "<fnr><n>new</n></function_results>"
    });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    assert_eq!(
        std::fs::read_to_string(&file_path).unwrap(),
        "<function_results><name>new</name></function_results>\n"
    );
}

#[tokio::test]
async fn file_edit_tool_empty_old_string_creates_missing_file() {
    let tmp = TempDir::new().unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();

    let input = json!({ "file_path": "created.txt", "old_string": "", "new_string": "hello\n" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("created.txt")).unwrap(),
        "hello\n"
    );
}

#[tokio::test]
async fn file_edit_tool_empty_old_string_rejects_non_empty_existing_file() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("test.txt");
    std::fs::write(&file_path, "already here").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();

    let input = json!({ "file_path": "test.txt", "old_string": "", "new_string": "hello\n" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    assert!(content_to_string(&output).contains("file already exists"));
    assert_eq!(std::fs::read_to_string(&file_path).unwrap(), "already here");
}

#[tokio::test]
async fn file_edit_tool_rejects_notebook_files() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("notebook.ipynb"), "{}").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();

    let input = json!({ "file_path": "notebook.ipynb", "old_string": "{}", "new_string": "{\"cells\":[]}" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    assert!(content_to_string(&output).contains("Jupyter Notebook"));
}

#[tokio::test]
async fn file_edit_tool_rejects_directory_target() {
    let tmp = TempDir::new().unwrap();
    std::fs::create_dir(tmp.path().join("test.txt")).unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();

    let input = json!({ "file_path": "test.txt", "old_string": "old", "new_string": "new" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    assert!(content_to_string(&output).contains("directory, not a file"));
}

#[tokio::test]
async fn file_edit_tool_rejects_non_utf8_file() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("binary.txt"), [0xff, 0xfe, 0xfd]).unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();

    let error = tool
        .call(
            json!({ "file_path": "binary.txt", "old_string": "old", "new_string": "new" }),
            &ctx,
        )
        .await
        .unwrap_err();

    assert!(error.to_string().contains("non-UTF-8"));
}

#[tokio::test]
async fn file_edit_tool_rejects_stale_read_before_modifying_existing_file() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("test.txt");
    std::fs::write(&file_path, "foo bar baz").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();
    read_file(&ctx, "test.txt").await;
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(&file_path, "foo user baz").unwrap();

    let input = json!({ "file_path": "test.txt", "old_string": "bar", "new_string": "qux" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    assert!(content_to_string(&output).contains("unexpectedly modified"));
    assert_eq!(std::fs::read_to_string(&file_path).unwrap(), "foo user baz");
}

#[tokio::test]
async fn file_edit_tool_reports_missing_file() {
    let tmp = TempDir::new().unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();

    let input = json!({ "file_path": "missing.txt", "old_string": "old", "new_string": "new" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("File not found"));
    assert!(text.contains("missing.txt"));
    assert!(text.contains("Current working directory"));
}

#[tokio::test]
async fn file_edit_tool_suggests_similar_missing_file() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("missing.rs"), "old").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();

    let input = json!({ "file_path": "missing.ts", "old_string": "old", "new_string": "new" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("Did you mean"));
    assert!(text.contains("missing.rs"));
}

#[tokio::test]
async fn file_edit_tool_suggests_matching_path_under_cwd() {
    let tmp = TempDir::new().unwrap();
    let project = tmp.path().join("project");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(project.join("src").join("lib.rs"), "old").unwrap();

    let state = AppState::new(&project);
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("edit").unwrap();

    let wrong_absolute = tmp.path().join("src").join("lib.rs");
    let output = tool
        .call(
            json!({
                "file_path": wrong_absolute,
                "old_string": "old",
                "new_string": "new"
            }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("Did you mean"));
    assert!(text.replace('\\', "/").contains("project/src/lib.rs"));
}

async fn read_file(ctx: &ToolContext, file_path: &str) {
    let registry = default_registry();
    let tool = registry.get("read").unwrap();
    let output = tool
        .call(json!({ "file_path": file_path }), ctx)
        .await
        .unwrap();
    assert!(
        !output.is_error,
        "read setup failed: {}",
        content_to_string(&output)
    );
}

fn utf16le_bytes(content: &str, bom: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    if bom {
        bytes.extend_from_slice(&[0xff, 0xfe]);
    }
    for unit in content.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

fn decode_utf16le_bytes(bytes: &[u8]) -> String {
    let bytes = if bytes.starts_with(&[0xff, 0xfe]) {
        &bytes[2..]
    } else {
        bytes
    };
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&units).unwrap()
}

#[tokio::test]
async fn glob_tool_finds_files() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("a.rs"), "").unwrap();
    std::fs::write(tmp.path().join("b.rs"), "").unwrap();
    std::fs::write(tmp.path().join("c.txt"), "").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("glob").unwrap();

    let input = json!({ "pattern": "*.rs" });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("a.rs"));
    assert!(text.contains("b.rs"));
    assert!(!text.contains("c.txt"));
}

#[tokio::test]
async fn glob_tool_rejects_non_directory_path() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("file.txt"), "").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("glob").unwrap();

    let output = tool
        .call(json!({ "pattern": "*.txt", "path": "file.txt" }), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    assert!(content_to_string(&output).contains("not a directory"));
}

#[tokio::test]
async fn glob_tool_truncates_large_results_by_default() {
    let tmp = TempDir::new().unwrap();
    for i in 0..105 {
        std::fs::write(tmp.path().join(format!("file-{i:03}.rs")), "").unwrap();
    }

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("glob").unwrap();

    let output = tool.call(json!({ "pattern": "*.rs" }), &ctx).await.unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("Results are truncated"));
    assert!(text.contains("showing first 100 results"));
}

#[tokio::test]
async fn glob_tool_count_mode_returns_only_a_complete_aggregate() {
    let tmp = TempDir::new().unwrap();
    for name in ["a.rs", "b.rs", "c.rs"] {
        std::fs::write(tmp.path().join(name), "").unwrap();
    }
    std::fs::write(tmp.path().join("notes.txt"), "").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("glob").unwrap();

    let output = tool
        .call(
            json!({ "pattern": "*.rs", "output_mode": "count", "limit": 1 }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("matched_files: 3"), "{text}");
    assert!(text.contains("complete: true"), "{text}");
    assert!(!text.contains("a.rs"), "{text}");
}

#[tokio::test]
async fn grep_tool_finds_matches() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("src.rs"), "fn main() {}\nfn helper() {}\n").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("grep").unwrap();

    let input = json!({
        "pattern": "fn ",
        "path": tmp.path().to_str().unwrap(),
        "output_mode": "content"
    });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("fn main"));
    assert!(text.contains("fn helper"));
}

#[tokio::test]
async fn grep_tool_defaults_to_files_with_matches() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("src.rs"), "fn main() {}\n").unwrap();
    std::fs::write(tmp.path().join("notes.txt"), "nothing\n").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("grep").unwrap();

    let output = tool
        .call(
            json!({ "pattern": "fn ", "path": tmp.path().to_str().unwrap() }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("Found 1 files"));
    assert!(text.contains("src.rs"));
    assert!(!text.contains("fn main"));
}

#[tokio::test]
async fn grep_tool_count_mode_summarizes_matches() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("src.rs"), "fn main() {}\nfn helper() {}\n").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("grep").unwrap();

    let output = tool
        .call(
            json!({
                "pattern": "fn ",
                "path": tmp.path().to_str().unwrap(),
                "output_mode": "count"
            }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("src.rs:2"));
    assert!(text.contains("Found 2 total occurrences across 1 file"));
}

#[tokio::test]
async fn grep_count_mode_keeps_exact_aggregate_when_rows_are_paginated() {
    let tmp = TempDir::new().unwrap();
    for index in 0..3 {
        std::fs::write(tmp.path().join(format!("file-{index}.rs")), "TODO\nTODO\n").unwrap();
    }

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("grep").unwrap();

    let output = tool
        .call(
            json!({
                "pattern": "TODO",
                "path": tmp.path().to_str().unwrap(),
                "output_mode": "count",
                "head_limit": 1
            }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(
        text.contains("Found 6 total occurrences across 3 files"),
        "{text}"
    );
    assert!(
        text.contains("Showing results with pagination = limit: 1"),
        "{text}"
    );
}

#[tokio::test]
async fn grep_tool_content_mode_supports_case_and_context() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("log.txt"), "before\nError: failed\nafter\n").unwrap();

    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let registry = default_registry();
    let tool = registry.get("grep").unwrap();

    let output = tool
        .call(
            json!({
                "pattern": "error",
                "path": tmp.path().to_str().unwrap(),
                "output_mode": "content",
                "-i": true,
                "-C": 1
            }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(text.contains("before"));
    assert!(text.contains("Error: failed"));
    assert!(text.contains("after"));
}

#[tokio::test]
async fn bash_tool_runs_in_cwd() {
    let tmp = TempDir::new().unwrap();
    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let tool = BashTool;

    let input = json!({ "command": "pwd; printf ok > cwd-marker.txt", "timeout": 5000 });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    assert!(tmp.path().join("cwd-marker.txt").is_file());
}

#[tokio::test]
async fn bash_tool_accepts_explicit_timeout_without_global_cap() {
    let tmp = TempDir::new().unwrap();
    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let tool = BashTool;

    let input = json!({ "command": "echo ok", "timeout": 600_001 });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    assert!(content_to_string(&output).contains("ok"));
}

#[tokio::test]
async fn bash_tool_reports_status_and_workdir_for_silent_success_commands() {
    let tmp = TempDir::new().unwrap();
    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let tool = BashTool;

    let input = json!({ "command": "touch created.txt", "timeout": 5000 });
    let output = tool.call(input, &ctx).await.unwrap();

    assert!(!output.is_error);
    let content = content_to_string(&output);
    assert!(content.contains("exit_code: 0"), "{content}");
    assert!(
        content.contains(&format!("workdir: {}", tmp.path().display())),
        "{content}"
    );
    assert!(
        content.contains("workdir_scope: invocation_only"),
        "{content}"
    );
    assert!(content.contains("(no output)"), "{content}");
    assert!(tmp.path().join("created.txt").exists());
}

#[tokio::test]
async fn bash_tool_does_not_inherit_parent_env() {
    let tmp = TempDir::new().unwrap();
    let state = AppState::new(tmp.path());
    let ctx = ToolContext::new(state);
    let tool = BashTool;

    unsafe {
        std::env::set_var("KCODER_TEST_SECRET", "leak");
    }
    let input = json!({ "command": "printenv KCODER_TEST_SECRET || true", "timeout": 5000 });
    let output = tool.call(input, &ctx).await.unwrap();
    unsafe {
        std::env::remove_var("KCODER_TEST_SECRET");
    }

    assert!(!output.is_error);
    let text = content_to_string(&output);
    assert!(!text.contains("leak"));
}

fn content_to_string(output: &kcoder_tools::ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|b| match b {
            kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect::<String>()
}

use kcoder_tools::apply_patch::ApplyPatchTool;

fn apply_patch_tool() -> ApplyPatchTool {
    ApplyPatchTool
}

#[tokio::test]
async fn apply_patch_tool_adds_updates_and_deletes_in_one_call() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("keep.txt"), "first\nsecond\n").unwrap();
    std::fs::write(tmp.path().join("gone.txt"), "bye\n").unwrap();
    let ctx = ToolContext::new(AppState::new(tmp.path()));

    let patch = concat!(
        "*** Begin Patch\n",
        "*** Update File: keep.txt\n",
        "@@\n",
        " first\n",
        "-second\n",
        "+SECOND\n",
        "*** Add File: fresh/new.txt\n",
        "+hello\n",
        "*** Delete File: gone.txt\n",
        "*** End Patch\n",
    );
    let output = apply_patch_tool()
        .call(json!({ "patch": patch }), &ctx)
        .await
        .unwrap();
    assert!(!output.is_error, "output: {}", content_to_string(&output));
    let text = content_to_string(&output);
    assert!(text.contains("Applied patch"), "text: {text}");
    for name in ["keep.txt", "fresh/new.txt", "gone.txt"] {
        assert!(text.contains(name), "summary must list {name}: {text}");
    }
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("keep.txt")).unwrap(),
        "first\nSECOND\n"
    );
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("fresh/new.txt")).unwrap(),
        "hello\n"
    );
    assert!(!tmp.path().join("gone.txt").exists());
    // Artifact metadata for written files (verifier contract, same as edit).
    assert!(output
        .execution_metadata
        .iter()
        .any(|metadata| matches!(metadata, kcoder_tools::ToolExecutionMetadata::Artifact { path, sha256 } if path.ends_with("keep.txt") && !sha256.is_empty())));
}

#[tokio::test]
async fn apply_patch_tool_moves_file() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("a.rs"), "fn a() {}\n").unwrap();
    let ctx = ToolContext::new(AppState::new(tmp.path()));
    let patch = concat!(
        "*** Begin Patch\n",
        "*** Update File: a.rs\n",
        "*** Move to: b.rs\n",
        "@@\n",
        "-fn a() {}\n",
        "+fn b() {}\n",
        "*** End Patch\n",
    );
    let output = apply_patch_tool()
        .call(json!({ "patch": patch }), &ctx)
        .await
        .unwrap();
    assert!(!output.is_error, "output: {}", content_to_string(&output));
    assert!(!tmp.path().join("a.rs").exists());
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("b.rs")).unwrap(),
        "fn b() {}\n"
    );
}

#[tokio::test]
async fn apply_patch_tool_writes_nothing_when_any_hunk_fails_verification() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("ok.txt"), "alpha\n").unwrap();
    std::fs::write(tmp.path().join("bad.txt"), "beta\n").unwrap();
    let ctx = ToolContext::new(AppState::new(tmp.path()));
    let patch = concat!(
        "*** Begin Patch\n",
        "*** Update File: ok.txt\n",
        "@@\n",
        "-alpha\n",
        "+ALPHA\n",
        "*** Update File: bad.txt\n",
        "@@\n",
        "-this-line-does-not-exist\n",
        "+whatever\n",
        "*** End Patch\n",
    );
    let output = apply_patch_tool()
        .call(json!({ "patch": patch }), &ctx)
        .await
        .unwrap();
    assert!(output.is_error);
    let text = content_to_string(&output);
    assert!(
        text.contains("apply_patch verification failed"),
        "text: {text}"
    );
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("ok.txt")).unwrap(),
        "alpha\n"
    );
}

#[tokio::test]
async fn apply_patch_tool_preserves_crlf_and_utf16le_encodings() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("crlf.txt"), b"one\r\ntwo\r\n").unwrap();
    let units: Vec<u8> = "hi\n"
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    std::fs::write(tmp.path().join("u16.txt"), &units).unwrap();
    let ctx = ToolContext::new(AppState::new(tmp.path()));
    let patch = concat!(
        "*** Begin Patch\n",
        "*** Update File: crlf.txt\n",
        "@@\n",
        "-two\n",
        "+TWO\n",
        "*** Update File: u16.txt\n",
        "@@\n",
        "-hi\n",
        "+ho\n",
        "*** End Patch\n",
    );
    let output = apply_patch_tool()
        .call(json!({ "patch": patch }), &ctx)
        .await
        .unwrap();
    assert!(!output.is_error, "output: {}", content_to_string(&output));
    assert_eq!(
        std::fs::read(tmp.path().join("crlf.txt")).unwrap(),
        b"one\r\nTWO\r\n"
    );
    let restored = String::from_utf16(
        &std::fs::read(tmp.path().join("u16.txt"))
            .unwrap()
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect::<Vec<u16>>(),
    )
    .unwrap();
    assert_eq!(restored, "ho\n");
}

#[tokio::test]
async fn apply_patch_tool_rejects_malformed_patch_and_duplicate_targets() {
    let tmp = TempDir::new().unwrap();
    let ctx = ToolContext::new(AppState::new(tmp.path()));
    let bad = apply_patch_tool()
        .call(json!({ "patch": "nope" }), &ctx)
        .await
        .unwrap();
    assert!(bad.is_error);
    assert!(content_to_string(&bad).contains("verification failed"));

    let dup = concat!(
        "*** Begin Patch\n",
        "*** Add File: x.txt\n",
        "+a\n",
        "*** Delete File: x.txt\n",
        "*** End Patch\n",
    );
    let output = apply_patch_tool()
        .call(json!({ "patch": dup }), &ctx)
        .await
        .unwrap();
    assert!(output.is_error, "output: {}", content_to_string(&output));
    assert!(content_to_string(&output).contains("multiple operations target"));
}

#[tokio::test]
async fn apply_patch_tool_records_read_snapshots_for_touched_paths() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("watched.txt"), "one\n").unwrap();
    let ctx = ToolContext::new(AppState::new(tmp.path()));
    let patch = "*** Begin Patch\n*** Update File: watched.txt\n@@\n-one\n+two\n*** End Patch\n";
    let output = apply_patch_tool()
        .call(json!({ "patch": patch }), &ctx)
        .await
        .unwrap();
    assert!(!output.is_error, "output: {}", content_to_string(&output));
    let snapshot = ctx
        .state
        .file_read_snapshot(&tmp.path().join("watched.txt"))
        .expect(
            "apply_patch must record a read snapshot so edit/write staleness guards stay honest",
        );
    assert_eq!(snapshot.content.as_deref(), Some("two\n"));
}

#[tokio::test]
async fn apply_patch_tool_deletes_binary_files() {
    // 修订 D5：Delete 不解码内容——无效 UTF-8 的文件必须可删除
    //（0x80 是孤立的 UTF-8 续字节，三种解码路径全部失败）。
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("blob.bin"), [0x80u8, 0x81, 0x82]).unwrap();
    let ctx = ToolContext::new(AppState::new(tmp.path()));
    let patch = "*** Begin Patch\n*** Delete File: blob.bin\n*** End Patch\n";
    let output = apply_patch_tool()
        .call(json!({ "patch": patch }), &ctx)
        .await
        .unwrap();
    assert!(!output.is_error, "output: {}", content_to_string(&output));
    assert!(!tmp.path().join("blob.bin").exists());
}

#[tokio::test]
async fn apply_patch_tool_add_overwrites_an_existing_file() {
    // 修订 M5：codex 对等——Add File 覆盖已存在文件（codex 捕获
    // overwritten_content 供 delta）。钉住该行为，避免被后人当 bug「修复」。
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("x.txt"), "old content\n").unwrap();
    let ctx = ToolContext::new(AppState::new(tmp.path()));
    let patch = "*** Begin Patch\n*** Add File: x.txt\n+new\n*** End Patch\n";
    let output = apply_patch_tool()
        .call(json!({ "patch": patch }), &ctx)
        .await
        .unwrap();
    assert!(!output.is_error, "output: {}", content_to_string(&output));
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("x.txt")).unwrap(),
        "new\n"
    );
}
