use super::*;

fn make_msg(role: MessageRole, text: &str) -> DisplayMessage {
    DisplayMessage {
        role,
        text: text.to_string(),
    }
}

fn render_texts(items: Vec<TranscriptRenderItem<'_>>) -> Vec<String> {
    items
        .into_iter()
        .map(|item| match item {
            TranscriptRenderItem::Message { message, .. } => message.text.clone(),
            TranscriptRenderItem::ToolPair { message, .. } => message.text,
            TranscriptRenderItem::ToolSummary { message, .. } => message.text,
        })
        .collect()
}

#[test]
fn summary_tracks_only_running_tools_actually_included_in_the_group() {
    let messages = vec![
        make_msg(MessageRole::System, "[Tool use: bash] echo done"),
        make_msg(MessageRole::System, "✓ Tool succeeded: bash - done"),
        make_msg(MessageRole::System, "⟳ Running tool: bash - sleep 12"),
    ];
    let items = collapse_tool_runs(&messages, 10, true);
    assert!(matches!(
        items.as_slice(),
        [TranscriptRenderItem::ToolSummary {
            absolute_idx: 10,
            last_running_idx: Some(12),
            ..
        }]
    ));

    // An excluded write card in the same run must not make the earlier
    // completed summary look active.
    let messages = vec![
        make_msg(MessageRole::System, "[Tool use: bash] echo done"),
        make_msg(MessageRole::System, "✓ Tool succeeded: bash - done"),
        make_msg(MessageRole::System, "⟳ Running tool: write - file.txt"),
    ];
    let items = collapse_tool_runs(&messages, 10, true);
    assert!(items.iter().any(|item| matches!(
        item,
        TranscriptRenderItem::ToolSummary {
            absolute_idx: 10,
            last_running_idx: None,
            ..
        }
    )));
}

#[test]
fn running_summary_member_is_tracked_for_mixed_tool_families() {
    let names = [
        "bash",
        "PowerShell",
        "Sleep",
        "read",
        "grep",
        "glob",
        "WebSearch",
        "WebFetch",
        "TaskOutput",
        "mcp__example__lookup",
    ];
    for completed in names {
        for running in names {
            let messages = vec![
                make_msg(
                    MessageRole::System,
                    &format!("[Tool use: {completed}] first"),
                ),
                make_msg(
                    MessageRole::System,
                    &format!("✓ Tool succeeded: {completed} - done"),
                ),
                make_msg(
                    MessageRole::System,
                    &format!("⟳ Running tool: {running} - waiting"),
                ),
            ];
            let items = collapse_tool_runs(&messages, 10, true);
            assert!(
                items.iter().any(|item| matches!(
                    item,
                    TranscriptRenderItem::ToolSummary {
                        absolute_idx: 10,
                        last_running_idx: Some(12),
                        ..
                    }
                )),
                "completed={completed}, running={running}"
            );
        }
    }
}

#[test]
fn excluded_running_tool_does_not_hide_later_summarized_running_tool() {
    let messages = vec![
        make_msg(MessageRole::System, "[Tool use: bash] first"),
        make_msg(MessageRole::System, "✓ Tool succeeded: bash - done"),
        make_msg(MessageRole::System, "⟳ Running tool: write - draft.txt"),
        make_msg(MessageRole::System, "⟳ Running tool: Sleep - waiting"),
    ];
    let items = collapse_tool_runs(&messages, 4, true);
    assert!(items.iter().any(|item| matches!(
        item,
        TranscriptRenderItem::ToolSummary {
            absolute_idx: 4,
            last_running_idx: Some(7),
            ..
        }
    )));
    assert!(items.iter().any(|item| matches!(
        item,
        TranscriptRenderItem::Message {
            absolute_idx: 6,
            ..
        }
    )));
}

#[test]
fn running_summary_survives_other_tool_completion_and_visible_failure() {
    let messages = vec![
        make_msg(MessageRole::System, "[Tool use: bash] first"),
        make_msg(MessageRole::System, "✗ Tool failed: bash - failed"),
        make_msg(MessageRole::System, "⟳ Running tool: grep - search"),
        make_msg(MessageRole::System, "⟳ Running tool: Sleep - waiting"),
    ];
    let items = collapse_tool_runs(&messages, 0, true);
    assert!(
        items
            .iter()
            .any(|item| matches!(item, TranscriptRenderItem::ToolPair { .. }))
    );
    assert!(items.iter().any(|item| matches!(
        item,
        TranscriptRenderItem::ToolSummary {
            last_running_idx: Some(3),
            ..
        }
    )));

    let mut one_remaining = messages;
    one_remaining[3].text = "✓ Tool succeeded: Sleep - done".into();
    let items = collapse_tool_runs(&one_remaining, 0, true);
    assert!(items.iter().any(|item| matches!(
        item,
        TranscriptRenderItem::ToolSummary {
            last_running_idx: Some(2),
            ..
        }
    )));
}

#[test]
fn user_messages_keep_historical_and_current_tool_summaries_separate() {
    let messages = vec![
        make_msg(MessageRole::System, "⟳ Running tool: bash - old history"),
        make_msg(MessageRole::User, "start a different task"),
        make_msg(MessageRole::System, "⟳ Running tool: Sleep - current"),
    ];
    let items = collapse_tool_runs(&messages, 5, true);
    let indices = items
        .iter()
        .filter_map(|item| match item {
            TranscriptRenderItem::ToolSummary {
                last_running_idx, ..
            } => *last_running_idx,
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(indices, vec![5, 7]);
}

#[test]
fn consecutive_tool_messages_collapse_to_invocation_counts() {
    let msgs = vec![
        make_msg(MessageRole::System, "[Tool use: read] {\"file\":\"a.rs\"}"),
        make_msg(MessageRole::System, "✓ Tool succeeded: read - ok"),
        make_msg(MessageRole::System, "[Tool use: grep] TODO"),
        make_msg(MessageRole::System, "✓ Tool succeeded: grep - found 2"),
        make_msg(MessageRole::System, "[Tool use: bash] cargo test"),
        make_msg(MessageRole::System, "✓ Tool succeeded: bash - ok"),
    ];

    assert_eq!(
        render_texts(collapse_tool_runs(&msgs, 0, true)),
        vec![
            "[Tool summary] read x1 · grep x1 · bash x1\n\
                 [Tool latest] latest: grep done - found 2\n\
                 [Tool latest] latest: bash done - cargo test"
        ]
    );
}

#[test]
fn single_tool_invocation_and_completion_merge_into_one_card() {
    let msgs = vec![
        make_msg(MessageRole::System, "[Tool use: bash] cargo test"),
        make_msg(
            MessageRole::System,
            "✓ Tool succeeded: bash - exit_code: 0 stdout: ok",
        ),
    ];

    assert_eq!(
        render_texts(collapse_tool_runs(&msgs, 0, true)),
        vec![
            "[Tool summary] bash x1\n\
                 [Tool latest] latest: bash done - cargo test"
        ]
    );
}

#[test]
fn failed_tool_invocation_and_completion_merge_but_stay_visible() {
    let msgs = vec![
        make_msg(MessageRole::System, "[Tool use: bash] cargo test"),
        make_msg(
            MessageRole::System,
            "✗ Tool failed: bash - exit_code: 1 stderr: failed",
        ),
    ];

    assert_eq!(
        render_texts(collapse_tool_runs(&msgs, 0, true)),
        vec!["✗ Tool failed: bash - cargo test\nexit_code: 1 stderr: failed"]
    );
}

#[test]
fn write_tool_status_and_diff_stay_out_of_collapsed_tool_runs() {
    let msgs = vec![
        make_msg(MessageRole::System, "[Tool use: write] {\"file\":\"a.rs\"}"),
        make_msg(MessageRole::System, "✓ Tool succeeded: write - Wrote a.rs"),
        make_msg(
            MessageRole::System,
            "[Tool diff: write]\nWrote a.rs\n@@ -1 +1 @@\n-old\n+new",
        ),
    ];

    assert_eq!(
        render_texts(collapse_tool_runs(&msgs, 0, true)),
        vec![
            "[Tool use: write] {\"file\":\"a.rs\"}",
            "✓ Tool succeeded: write - Wrote a.rs",
            "[Tool diff: write]\nWrote a.rs\n@@ -1 +1 @@\n-old\n+new",
        ]
    );
}

#[test]
fn write_stays_visible_while_surrounding_tools_still_collapse() {
    let msgs = vec![
        make_msg(MessageRole::System, "[Tool use: read] a.rs"),
        make_msg(MessageRole::System, "✓ Tool succeeded: read - ok"),
        make_msg(MessageRole::System, "[Tool use: write] story.txt"),
        make_msg(
            MessageRole::System,
            "✓ Tool succeeded: write - wrote story.txt",
        ),
        make_msg(MessageRole::System, "[Tool use: grep] sentinel"),
        make_msg(MessageRole::System, "✓ Tool succeeded: grep - found 1"),
        make_msg(MessageRole::System, "[Tool use: bash] cargo test"),
        make_msg(MessageRole::System, "✓ Tool succeeded: bash - ok"),
    ];

    let rendered = render_texts(collapse_tool_runs(&msgs, 0, true));

    assert_eq!(
        rendered
            .iter()
            .filter(|message| message.starts_with("[Tool summary]"))
            .count(),
        1
    );
    assert!(
        rendered
            .iter()
            .any(|message| { message.starts_with("[Tool summary] read x1 · grep x1 · bash x1") })
    );
    assert!(
        rendered
            .iter()
            .any(|message| message == "[Tool use: write] story.txt")
    );
    assert!(
        rendered
            .iter()
            .any(|message| message == "✓ Tool succeeded: write - wrote story.txt")
    );
}

#[test]
fn patch_tool_status_preview_omits_separate_diff_block() {
    let (_, status, diff) = format_completed_tool_display(
        "edit",
        "{\"file_path\":\"src/lib.rs\"}",
        "Edited src/lib.rs\n```diff\n@@ -1 +1 @@\n-old\n+new\n```",
        false,
    );

    assert_eq!(status, "✓ Tool succeeded: edit - Edited src/lib.rs");
    assert!(!status.contains("```diff"));
    assert!(!status.contains("-old"));
    assert!(!status.contains("+new"));
    let diff = diff.expect("diff should be displayed separately");
    assert!(diff.starts_with("[Tool diff: edit]"));
    assert!(diff.contains("-old"));
    assert!(diff.contains("+new"));
}

#[test]
fn diff_lang_from_summary_uses_arrow_destination_path() {
    assert_eq!(
        diff_lang_from_summary("• Edited old_name.txt → src/lib.rs (+1 -1)"),
        Some("rs".to_string())
    );
}

#[test]
fn diff_lang_from_summary_accepts_deleted_paths() {
    assert_eq!(
        diff_lang_from_summary("• Deleted src/old_module.rs (+0 -3)"),
        Some("rs".to_string())
    );
}

#[test]
fn consecutive_tools_collapse_regardless_of_tool_name() {
    let msgs = vec![
        make_msg(
            MessageRole::System,
            "[Tool use: TodoWrite] {\"todos\":[...]}",
        ),
        make_msg(
            MessageRole::System,
            "✓ Tool succeeded: TodoWrite\nCurrent todo count: 2\n- [pending] Inspect renderer",
        ),
        make_msg(MessageRole::System, "[Tool use: read] {\"file\":\"a.rs\"}"),
        make_msg(MessageRole::System, "✓ Tool succeeded: read - ok"),
        make_msg(MessageRole::System, "[Tool use: grep] TODO"),
        make_msg(MessageRole::System, "✓ Tool succeeded: grep - found 2"),
        make_msg(
            MessageRole::System,
            "[Tool use: update_goal] {\"status\":\"complete\"}",
        ),
        make_msg(
            MessageRole::System,
            "✓ Tool succeeded: update_goal - Goal marked complete",
        ),
    ];

    assert_eq!(
        render_texts(collapse_tool_runs(&msgs, 0, true)),
        vec![
            "[Tool summary] TodoWrite x1 · read x1 · grep x1 · update_goal x1\n\
                 [Tool latest] latest: grep done - found 2\n\
                 [Tool latest] latest: update_goal done - Goal marked complete"
        ]
    );
}

#[test]
fn edit_tool_messages_stay_out_of_tool_summary() {
    let msgs = vec![
        make_msg(MessageRole::System, "[Tool use: read] {\"file\":\"a.rs\"}"),
        make_msg(MessageRole::System, "✓ Tool succeeded: read - ok"),
        make_msg(MessageRole::System, "[Tool use: grep] TODO"),
        make_msg(MessageRole::System, "✓ Tool succeeded: grep - found 2"),
        make_msg(MessageRole::System, "[Tool use: bash] cargo test"),
        make_msg(MessageRole::System, "✓ Tool succeeded: bash - ok"),
        make_msg(
            MessageRole::System,
            "[Tool use: edit] {\"file_path\":\"src/lib.rs\"}",
        ),
        make_msg(
            MessageRole::System,
            "✓ Tool succeeded: edit - Edited src/lib.rs",
        ),
        make_msg(
            MessageRole::System,
            "[Tool diff: edit]\nEdited src/lib.rs\n@@ -1 +1 @@\n-old\n+new",
        ),
    ];

    assert_eq!(
        render_texts(collapse_tool_runs(&msgs, 0, true)),
        vec![
            "[Tool summary] read x1 · grep x1 · bash x1\n\
                 [Tool latest] latest: grep done - found 2\n\
                 [Tool latest] latest: bash done - cargo test",
            "[Tool use: edit] {\"file_path\":\"src/lib.rs\"}",
            "✓ Tool succeeded: edit - Edited src/lib.rs",
            "[Tool diff: edit]\nEdited src/lib.rs\n@@ -1 +1 @@\n-old\n+new",
        ]
    );
}

#[test]
fn edit_does_not_split_surrounding_tool_summary() {
    let msgs = vec![
        make_msg(MessageRole::System, "[Tool use: read] {\"file\":\"a.rs\"}"),
        make_msg(MessageRole::System, "✓ Tool succeeded: read - ok"),
        make_msg(
            MessageRole::System,
            "[Tool use: edit] {\"file_path\":\"src/lib.rs\"}",
        ),
        make_msg(
            MessageRole::System,
            "✓ Tool succeeded: edit - Edited src/lib.rs",
        ),
        make_msg(
            MessageRole::System,
            "[Tool diff: edit]\nEdited src/lib.rs\n@@ -1 +1 @@\n-old\n+new",
        ),
        make_msg(MessageRole::System, "[Tool use: grep] TODO"),
        make_msg(MessageRole::System, "✓ Tool succeeded: grep - found 2"),
    ];

    assert_eq!(
        render_texts(collapse_tool_runs(&msgs, 0, true)),
        vec![
            "[Tool summary] read x1 · grep x1\n\
                 [Tool latest] latest: read done - ok\n\
                 [Tool latest] latest: grep done - found 2",
            "[Tool use: edit] {\"file_path\":\"src/lib.rs\"}",
            "✓ Tool succeeded: edit - Edited src/lib.rs",
            "[Tool diff: edit]\nEdited src/lib.rs\n@@ -1 +1 @@\n-old\n+new",
        ]
    );
}

#[test]
fn interaction_tool_passes_through_without_splitting_summary() {
    let msgs = vec![
        make_msg(MessageRole::System, "[Tool use: read] {\"file\":\"a.rs\"}"),
        make_msg(MessageRole::System, "✓ Tool succeeded: read - ok"),
        make_msg(
            MessageRole::System,
            "[Tool use: AskUserQuestion] {\"question\":\"Continue?\"}",
        ),
        make_msg(
            MessageRole::System,
            "✓ Tool succeeded: AskUserQuestion - answered yes",
        ),
        make_msg(MessageRole::System, "[Tool use: grep] TODO"),
        make_msg(MessageRole::System, "✓ Tool succeeded: grep - found 2"),
    ];

    assert_eq!(
        render_texts(collapse_tool_runs(&msgs, 0, true)),
        vec![
            "[Tool summary] read x1 · grep x1\n\
                 [Tool latest] latest: read done - ok\n\
                 [Tool latest] latest: grep done - found 2",
            "[Tool use: AskUserQuestion] {\"question\":\"Continue?\"}",
            "✓ Tool succeeded: AskUserQuestion - answered yes",
        ]
    );
}

#[test]
fn successful_bash_with_failure_like_output_collapses_inside_tool_run() {
    let msgs = vec![
        make_msg(MessageRole::System, "[Tool use: read] {\"file\":\"a.rs\"}"),
        make_msg(MessageRole::System, "✓ Tool succeeded: read - ok"),
        make_msg(MessageRole::System, "[Tool use: bash] cargo test"),
        make_msg(
            MessageRole::System,
            "✓ Tool succeeded: bash - FAILED tests: AssertionError",
        ),
    ];

    assert_eq!(
        render_texts(collapse_tool_runs(&msgs, 0, true)),
        vec![
            "[Tool summary] read x1\n[Tool latest] latest: read done - ok",
            "✓ Tool succeeded: bash - cargo test\nFAILED tests: AssertionError",
        ]
    );
}

#[test]
fn expanded_tool_transcript_preserves_original_tool_order() {
    let msgs = vec![
        make_msg(MessageRole::System, "[Tool use: read] {\"file\":\"a.rs\"}"),
        make_msg(MessageRole::System, "✓ Tool succeeded: read - ok"),
        make_msg(MessageRole::System, "[Tool use: bash] cargo test"),
        make_msg(MessageRole::System, "✓ Tool succeeded: bash - ok"),
    ];

    assert_eq!(
        render_texts(collapse_tool_runs(&msgs, 0, false)),
        vec![
            "[Tool use: read] {\"file\":\"a.rs\"}",
            "✓ Tool succeeded: read - ok",
            "[Tool use: bash] cargo test",
            "✓ Tool succeeded: bash - ok",
        ]
    );
}

#[test]
fn recent_turn_low_signal_tool_tail_still_collapses() {
    let msgs = vec![
        make_msg(MessageRole::System, "[Tool use: read] {\"file\":\"a.rs\"}"),
        make_msg(MessageRole::System, "✓ Tool succeeded: read - ok"),
        make_msg(MessageRole::User, "next request"),
        make_msg(MessageRole::System, "[Tool use: bash] cargo test"),
        make_msg(MessageRole::System, "✓ Tool succeeded: bash - ok"),
        make_msg(MessageRole::System, "[Tool use: grep] TODO"),
        make_msg(MessageRole::System, "✓ Tool succeeded: grep - found 1"),
    ];

    assert_eq!(
        render_texts(collapse_tool_runs_with_recent_expanded(
            &msgs,
            0,
            true,
            TOOL_SUMMARY_MIN_RUN_LEN,
            Some(3)
        )),
        vec![
            "[Tool summary] read x1\n[Tool latest] latest: read done - ok",
            "next request",
            "[Tool summary] bash x1 · grep x1\n\
                 [Tool latest] latest: bash done - cargo test\n\
                 [Tool latest] latest: grep done - found 1",
        ]
    );
}

#[test]
fn assistant_text_breaks_tool_summary_runs() {
    let msgs = vec![
        make_msg(MessageRole::System, "[Tool use: read] {\"file\":\"a.rs\"}"),
        make_msg(MessageRole::System, "✓ Tool succeeded: read - ok"),
        make_msg(MessageRole::Assistant, "I found it."),
        make_msg(MessageRole::System, "[Tool use: bash] cargo test"),
        make_msg(MessageRole::System, "✓ Tool succeeded: bash - ok"),
    ];

    assert_eq!(
        render_texts(collapse_tool_runs(&msgs, 0, true)),
        vec![
            "[Tool summary] read x1\n[Tool latest] latest: read done - ok",
            "I found it.",
            "[Tool summary] bash x1\n[Tool latest] latest: bash done - cargo test",
        ]
    );
}

#[test]
fn history_restore_preserves_full_text_and_tool_blocks() {
    let long_text = format!("{}TAIL", "x".repeat(10_500));
    let messages = vec![
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::Text {
                text: long_text.clone(),
            }],
        },
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "tool-1".to_string(),
                name: "edit".to_string(),
                input: serde_json::json!({"file_path":"src/lib.rs"}),
            }],
            usage: None,
        },
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "tool-1".to_string(),
                content: vec![ContentBlock::Text {
                    text: "Edited src/lib.rs\n```diff\n@@ -1 +1 @@\n-old\n+new\n```".to_string(),
                }],
                is_error: Some(false),
            }],
        },
    ];
    let mut app = ReplApp {
        scrollback_committed_until: 2,
        ..ReplApp::default()
    };

    app.replace_transcript_from_history(&messages);

    let pairs = app
        .messages
        .iter()
        .map(|m| (m.role, m.text.clone()))
        .collect::<Vec<_>>();
    assert_eq!(pairs[0], (MessageRole::User, long_text));
    assert!(pairs.iter().any(|(_, text)| {
        text.starts_with("[Tool use: edit]") && text.contains("\"file_path\":\"src/lib.rs\"")
    }));
    assert!(
        pairs
            .iter()
            .any(|(_, text)| { text.starts_with("✓ Tool succeeded: edit - Edited src/lib.rs") })
    );
    assert!(pairs.iter().any(|(_, text)| {
        text.starts_with("[Tool diff: edit]") && text.contains("-old") && text.contains("+new")
    }));
    assert_eq!(app.scrollback_committed_until, 0);
}
