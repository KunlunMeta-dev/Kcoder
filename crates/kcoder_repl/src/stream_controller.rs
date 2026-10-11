use crate::active_turn::{ActiveCell, ActiveEntry, ToolStatus};
use crate::stream_table_holdback::markdown_table_holdback_start;
use crate::table_detect::{FenceKind, FenceTracker};
use kcoder_types::DisplayMessage;

/// Owns the active-stream lifecycle rules.
///
/// The active cell remains separate from committed transcript history; this
/// controller decides when stable entries can move into the transcript and
/// when the whole active tail should be consolidated.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct StreamController;

impl StreamController {
    pub(crate) fn commit_complete_lines_prefix_with_limit(
        active_turn: &mut Option<ActiveCell>,
        expanded_tools: bool,
        max_source_lines: usize,
    ) -> Vec<DisplayMessage> {
        Self::commit_prefix(
            active_turn,
            expanded_tools,
            TextCommitMode::CompleteLines { max_source_lines },
        )
    }

    pub(crate) fn complete_source_lines_ready(active_turn: &Option<ActiveCell>) -> usize {
        let Some(active) = active_turn.as_ref() else {
            return 0;
        };
        let mut lines = 0usize;
        for entry in &active.entries {
            match entry {
                ActiveEntry::Text(text) => {
                    let candidate = stable_text_candidate(text);
                    lines += candidate.bytes().filter(|byte| *byte == b'\n').count();
                    if candidate.len() < text.len() {
                        break;
                    }
                }
                ActiveEntry::Tool(ToolStatus::Running { .. }) => break,
                ActiveEntry::Tool(_) => {}
                ActiveEntry::SubagentPanel(panel) if !panel.all_terminal() => break,
                ActiveEntry::SubagentPanel(_) => {}
            }
        }
        lines
    }

    pub(crate) fn commit_stable_prefix(
        active_turn: &mut Option<ActiveCell>,
        expanded_tools: bool,
    ) -> Vec<DisplayMessage> {
        Self::commit_prefix(active_turn, expanded_tools, TextCommitMode::All)
    }

    fn commit_prefix(
        active_turn: &mut Option<ActiveCell>,
        expanded_tools: bool,
        text_mode: TextCommitMode,
    ) -> Vec<DisplayMessage> {
        let Some(mut active) = active_turn.take() else {
            return Vec::new();
        };
        let commit_len = active
            .entries
            .iter()
            .position(|entry| {
                matches!(entry, ActiveEntry::Tool(ToolStatus::Running { .. }))
                    || matches!(entry, ActiveEntry::SubagentPanel(panel) if !panel.all_terminal())
            })
            .unwrap_or(active.entries.len());

        if commit_len == 0 {
            *active_turn = Some(active);
            return Vec::new();
        }

        let entries = std::mem::take(&mut active.entries);
        let (stable_entries, remaining_entries) =
            split_entries_for_stable_commit(entries, commit_len, text_mode);
        if stable_entries.is_empty() {
            active.entries = remaining_entries;
            if !active.entries.is_empty() {
                *active_turn = Some(active);
            }
            return Vec::new();
        }

        let committed_messages = ActiveCell {
            entries: stable_entries,
        }
        .display_messages(expanded_tools);

        if !remaining_entries.is_empty() {
            active.entries = remaining_entries;
            *active_turn = Some(active);
        }

        committed_messages
    }

    pub(crate) fn flush(
        active_turn: &mut Option<ActiveCell>,
        expanded_tools: bool,
    ) -> Vec<DisplayMessage> {
        active_turn
            .take()
            .map(|active| active.display_messages(expanded_tools))
            .unwrap_or_default()
    }
}

#[derive(Clone, Copy)]
enum TextCommitMode {
    All,
    CompleteLines { max_source_lines: usize },
}

fn split_entries_for_stable_commit(
    entries: Vec<ActiveEntry>,
    commit_len: usize,
    text_mode: TextCommitMode,
) -> (Vec<ActiveEntry>, Vec<ActiveEntry>) {
    let mut stable_entries = Vec::new();
    let mut remaining_entries = Vec::new();
    let mut holding_back = false;

    for (idx, entry) in entries.into_iter().enumerate() {
        if holding_back || idx >= commit_len {
            remaining_entries.push(entry);
            continue;
        }

        match entry {
            ActiveEntry::Text(text) => {
                let (stable, tail) = split_text_for_stable_commit(text, text_mode);
                if !stable.is_empty() {
                    stable_entries.push(ActiveEntry::Text(stable));
                }
                if !tail.is_empty() {
                    remaining_entries.push(ActiveEntry::Text(tail));
                    holding_back = true;
                }
            }
            entry => stable_entries.push(entry),
        }
    }

    (stable_entries, remaining_entries)
}

fn split_text_for_stable_commit(text: String, text_mode: TextCommitMode) -> (String, String) {
    match text_mode {
        TextCommitMode::All => (text, String::new()),
        TextCommitMode::CompleteLines { max_source_lines } => {
            let (candidate_stable, candidate_tail) =
                if let Some(holdback_start) = markdown_holdback_start(&text) {
                    let (stable, tail) = text.split_at(holdback_start);
                    (stable.to_string(), tail.to_string())
                } else {
                    (text, String::new())
                };
            let Some(split_at) = complete_line_split_at(&candidate_stable, max_source_lines) else {
                let mut tail = candidate_stable;
                tail.push_str(&candidate_tail);
                return (String::new(), tail);
            };
            let (stable, partial_tail) = candidate_stable.split_at(split_at);
            let mut tail = partial_tail.to_string();
            tail.push_str(&candidate_tail);
            (stable.to_string(), tail)
        }
    }
}

fn stable_text_candidate(text: &str) -> &str {
    markdown_holdback_start(text)
        .map(|holdback_start| &text[..holdback_start])
        .unwrap_or(text)
}

fn markdown_holdback_start(text: &str) -> Option<usize> {
    let table_start = markdown_table_holdback_start(text);
    let fence_start = incomplete_fence_start(text);
    table_start.into_iter().chain(fence_start).min()
}

fn incomplete_fence_start(text: &str) -> Option<usize> {
    let mut tracker = FenceTracker::new();
    let mut open_start = None;
    let mut offset = 0usize;

    for line in text.split_inclusive('\n') {
        let before = tracker.kind();
        tracker.advance(line.trim_end_matches(['\r', '\n']));
        let after = tracker.kind();
        if before == FenceKind::Outside && after != FenceKind::Outside {
            open_start = Some(offset);
        } else if before != FenceKind::Outside && after == FenceKind::Outside {
            open_start = None;
        }
        offset += line.len();
    }

    (tracker.kind() != FenceKind::Outside)
        .then_some(open_start)
        .flatten()
}

fn complete_line_split_at(text: &str, max_source_lines: usize) -> Option<usize> {
    if max_source_lines == 0 {
        return None;
    }
    let mut lines = 0usize;
    let mut offset = 0;
    let mut safe_end = None;
    let mut tracker = FenceTracker::new();
    for line in text.split_inclusive('\n') {
        if !line.ends_with('\n') {
            break;
        }
        tracker.advance(line.trim_end_matches(['\r', '\n']));
        offset += line.len();
        lines += 1;
        if tracker.kind() == FenceKind::Outside {
            safe_end = Some(offset);
            if lines >= max_source_lines {
                break;
            }
        } else if lines >= max_source_lines && safe_end.is_some() {
            break;
        }
    }
    // The line count is a smoothing budget and cannot split a fence. Commit a leading block atomically to guarantee progress.
    safe_end
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subagent_panel::{SubagentPanel, SubagentPhase};
    use kcoder_types::MessageRole;

    fn running_subagent_panel() -> SubagentPanel {
        let mut panel = SubagentPanel::new(1);
        panel.add_pending(
            "tool-1".to_string(),
            "inspect UI".to_string(),
            crate::subagent_panel::SubagentDelivery::Foreground,
        );
        panel.associate(
            "tool-1",
            "agent-1",
            crate::subagent_panel::SubagentDelivery::Foreground,
        );
        panel
    }

    #[test]
    fn running_subagent_panel_stays_out_of_native_scrollback_until_terminal() {
        let mut panel = running_subagent_panel();
        let mut active = Some(ActiveCell {
            entries: vec![
                ActiveEntry::Text("before".to_string()),
                ActiveEntry::SubagentPanel(panel.clone()),
            ],
        });

        let committed = StreamController::commit_stable_prefix(&mut active, true);
        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].text, "before");
        assert!(matches!(
            active.as_ref().and_then(|cell| cell.entries.first()),
            Some(ActiveEntry::SubagentPanel(_))
        ));

        panel.finish("agent-1", SubagentPhase::Completed, "Completed");
        active = Some(ActiveCell {
            entries: vec![ActiveEntry::SubagentPanel(panel)],
        });
        let committed = StreamController::commit_stable_prefix(&mut active, true);
        assert_eq!(committed.len(), 1);
        assert!(active.is_none());
    }

    #[test]
    fn commit_stable_prefix_keeps_running_tool_tail_active() {
        let mut active = Some(ActiveCell {
            entries: vec![
                ActiveEntry::Text("before".to_string()),
                ActiveEntry::Tool(ToolStatus::Running {
                    id: "tool-1".to_string(),
                    name: "read".to_string(),
                    input: "{}".to_string(),
                    write_preview: None,
                }),
                ActiveEntry::Text("after".to_string()),
            ],
        });

        let committed = StreamController::commit_stable_prefix(&mut active, true);

        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].role, MessageRole::Assistant);
        assert_eq!(committed[0].text, "before");
        assert_eq!(active.as_ref().map(|cell| cell.entries.len()), Some(2));
    }

    #[test]
    fn commit_stable_prefix_commits_completed_markdown_table() {
        let mut active = Some(ActiveCell {
            entries: vec![ActiveEntry::Text(
                "intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n".to_string(),
            )],
        });

        let committed = StreamController::commit_stable_prefix(&mut active, true);

        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].role, MessageRole::Assistant);
        assert_eq!(
            committed[0].text,
            "intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n"
        );
        assert!(active.is_none());
    }

    #[test]
    fn commit_complete_lines_prefix_keeps_partial_line_active() {
        let mut active = Some(ActiveCell {
            entries: vec![ActiveEntry::Text("hello".to_string())],
        });

        let committed = StreamController::commit_complete_lines_prefix_with_limit(
            &mut active,
            true,
            usize::MAX,
        );

        assert!(committed.is_empty());
        let remaining = active.expect("partial line should stay active");
        match &remaining.entries[0] {
            ActiveEntry::Text(text) => assert_eq!(text, "hello"),
            _ => panic!("expected text tail"),
        }
    }

    #[test]
    fn commit_complete_lines_prefix_commits_newline_terminated_prefix() {
        let mut active = Some(ActiveCell {
            entries: vec![ActiveEntry::Text("hello\npartial".to_string())],
        });

        let committed = StreamController::commit_complete_lines_prefix_with_limit(
            &mut active,
            true,
            usize::MAX,
        );

        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].text, "hello\n");
        let remaining = active.expect("partial line should stay active");
        match &remaining.entries[0] {
            ActiveEntry::Text(text) => assert_eq!(text, "partial"),
            _ => panic!("expected text tail"),
        }
    }

    #[test]
    fn commit_complete_lines_prefix_with_limit_commits_only_requested_lines() {
        let mut active = Some(ActiveCell {
            entries: vec![ActiveEntry::Text("one\ntwo\nthree\npartial".to_string())],
        });

        let committed =
            StreamController::commit_complete_lines_prefix_with_limit(&mut active, true, 2);

        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].text, "one\ntwo\n");
        let remaining = active.expect("remaining lines should stay active");
        match &remaining.entries[0] {
            ActiveEntry::Text(text) => assert_eq!(text, "three\npartial"),
            _ => panic!("expected text tail"),
        }
    }

    #[test]
    fn complete_source_lines_ready_respects_table_holdback() {
        let active = Some(ActiveCell {
            entries: vec![ActiveEntry::Text(
                "intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n".to_string(),
            )],
        });

        assert_eq!(StreamController::complete_source_lines_ready(&active), 1);
    }

    #[test]
    fn commit_complete_lines_prefix_holds_back_confirmed_markdown_table() {
        let mut active = Some(ActiveCell {
            entries: vec![ActiveEntry::Text(
                "intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n".to_string(),
            )],
        });

        let committed = StreamController::commit_complete_lines_prefix_with_limit(
            &mut active,
            true,
            usize::MAX,
        );

        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].role, MessageRole::Assistant);
        assert_eq!(committed[0].text, "intro\n");
        let remaining = active.expect("table tail should stay active");
        assert_eq!(remaining.entries.len(), 1);
        match &remaining.entries[0] {
            ActiveEntry::Text(text) => assert!(text.starts_with("| A | B |")),
            _ => panic!("expected text tail"),
        }
    }

    #[test]
    fn commit_complete_lines_prefix_holds_back_blockquoted_markdown_table() {
        let mut active = Some(ActiveCell {
            entries: vec![ActiveEntry::Text(
                "intro\n> | A | B |\n> | --- | --- |\n> | 1 | 2 |\n".to_string(),
            )],
        });

        let committed = StreamController::commit_complete_lines_prefix_with_limit(
            &mut active,
            true,
            usize::MAX,
        );

        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].role, MessageRole::Assistant);
        assert_eq!(committed[0].text, "intro\n");
        let remaining = active.expect("blockquoted table tail should stay active");
        assert_eq!(remaining.entries.len(), 1);
        match &remaining.entries[0] {
            ActiveEntry::Text(text) => assert!(text.starts_with("> | A | B |")),
            _ => panic!("expected text tail"),
        }
    }

    #[test]
    fn commit_complete_lines_prefix_holds_back_pending_table_header() {
        let mut active = Some(ActiveCell {
            entries: vec![ActiveEntry::Text("intro\nA | B\n".to_string())],
        });

        let committed = StreamController::commit_complete_lines_prefix_with_limit(
            &mut active,
            true,
            usize::MAX,
        );

        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].text, "intro\n");
        let remaining = active.expect("pending table header should stay active");
        match &remaining.entries[0] {
            ActiveEntry::Text(text) => assert_eq!(text, "A | B\n"),
            _ => panic!("expected text tail"),
        }
    }

    #[test]
    fn commit_complete_lines_holds_back_open_code_fence_with_its_lead_in() {
        let mut active = Some(ActiveCell {
            entries: vec![ActiveEntry::Text(
                "intro\n- Cargo 依据：\n  ```toml\n  [workspace]\n".to_string(),
            )],
        });

        let committed = StreamController::commit_complete_lines_prefix_with_limit(
            &mut active,
            true,
            usize::MAX,
        );

        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].text, "intro\n- Cargo 依据：\n");
        let remaining = active.expect("open code fence should remain active");
        match &remaining.entries[0] {
            ActiveEntry::Text(text) => assert_eq!(text, "  ```toml\n  [workspace]\n"),
            _ => panic!("expected text tail"),
        }
    }

    #[test]
    fn closed_fence_is_atomic_even_when_line_budget_is_small() {
        let block = "```text\nline-001\nline-002\nline-003\n```\n";
        assert_eq!(complete_line_split_at(block, 1), Some(block.len()));
        assert_eq!(
            complete_line_split_at(&format!("intro\n{block}"), 2),
            Some("intro\n".len())
        );
        assert_eq!(complete_line_split_at("one\ntwo\nthree\n", 2), Some(8));
        assert_eq!(complete_line_split_at(block, 0), None);
    }

    #[test]
    fn commit_complete_lines_commits_closed_code_fence_in_source_order() {
        let source = "- Cargo 依据：\n  ```toml\n  [workspace]\n  ```\n- done\n";
        let mut active = Some(ActiveCell {
            entries: vec![ActiveEntry::Text(source.to_string())],
        });

        let committed = StreamController::commit_complete_lines_prefix_with_limit(
            &mut active,
            true,
            usize::MAX,
        );

        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].text, source);
        assert!(active.is_none());
    }

    #[test]
    fn commit_stable_prefix_ignores_table_like_code_fence() {
        let source = "```rust\n| A | B |\n| --- | --- |\n```\n";
        let mut active = Some(ActiveCell {
            entries: vec![ActiveEntry::Text(source.to_string())],
        });

        let committed = StreamController::commit_stable_prefix(&mut active, true);

        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].text, source);
        assert!(active.is_none());
    }

    #[test]
    fn flush_consolidates_active_cell_and_clears_tail() {
        let mut active = Some(ActiveCell {
            entries: vec![ActiveEntry::Text("done".to_string())],
        });

        let committed = StreamController::flush(&mut active, true);

        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].text, "done");
        assert!(active.is_none());
    }
}
