//! Request-local, complete-turn transcript projection and move-only page selection.

use super::{
    ApprovalDecisionArtifact, ThreadMessage, TurnOutcomeArtifact, Value,
    apply_turn_client_message_ids, apply_turn_outcomes, attach_approval_decision_blocks,
    attach_turn_file_change_blocks, coalesce_assistant_tool_fragments,
    history_entry_thread_message,
};
use kcoder_state::HistoryEntry;
use std::collections::{HashMap, VecDeque};

#[derive(Default)]
pub(super) struct Artifacts {
    pub(super) attempts: Vec<kcoder_state::turn_attempt_store::TurnAttemptRecord>,
    pub(super) turn_ids: HashMap<String, String>,
    pub(super) client_ids: HashMap<String, String>,
    pub(super) outcomes: HashMap<String, TurnOutcomeArtifact>,
    pub(super) approvals: Vec<ApprovalDecisionArtifact>,
    pub(super) file_changes: HashMap<String, Value>,
}

pub(super) struct Page {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) messages: Vec<ThreadMessage>,
}

struct Window<T> {
    rows: VecDeque<T>,
    limit: usize,
    end: Option<usize>,
    seen: usize,
}

impl<T> Window<T> {
    fn new(limit: Option<u32>, cursor: Option<&str>) -> Self {
        Self {
            rows: VecDeque::new(),
            limit: limit.unwrap_or(50).clamp(1, 100) as usize,
            end: cursor.and_then(|value| value.parse().ok()),
            seen: 0,
        }
    }

    fn complete(&self) -> bool {
        self.end.is_some_and(|end| self.seen >= end)
    }

    fn push(&mut self, row: T) {
        if !self.complete() {
            if self.rows.len() == self.limit {
                self.rows.pop_front();
            }
            self.rows.push_back(row);
            self.seen += 1;
        }
    }

    fn finish(self) -> (usize, usize, Vec<T>) {
        let start = self.seen.saturating_sub(self.limit);
        (start, self.seen, self.rows.into_iter().collect())
    }
}

pub(super) fn project(
    entries: Vec<HistoryEntry>,
    artifacts: Artifacts,
    limit: Option<u32>,
    cursor: Option<&str>,
) -> Page {
    let mut window = Window::new(limit, cursor);
    if !window.complete() {
        visit_rows(entries, artifacts, |_, message| {
            window.push(message);
            Ok(!window.complete())
        })
        .expect("in-memory page selection cannot fail");
    }
    let (start, end, messages) = window.finish();
    Page {
        start,
        end,
        messages,
    }
}

/// Emit final UI rows in global order after complete-turn projection. A durable
/// index sink can consume rows without accumulating the full rendered transcript.
/// Source loading and the global tool association pass remain caller-owned costs.
pub(super) fn visit_rows(
    entries: Vec<HistoryEntry>,
    artifacts: Artifacts,
    mut sink: impl FnMut(usize, ThreadMessage) -> anyhow::Result<bool>,
) -> anyhow::Result<usize> {
    let mut turns = TranscriptTurns::new(entries, artifacts);
    let mut emitted = 0;
    while let Some(messages) = turns.next_turn() {
        for message in messages {
            let keep_going = sink(emitted, message)?;
            emitted += 1;
            if !keep_going {
                return Ok(emitted);
            }
        }
    }
    Ok(emitted)
}

fn take_turn<T>(artifacts: &mut HashMap<String, T>, turn_id: &str) -> HashMap<String, T> {
    artifacts.remove_entry(turn_id).into_iter().collect()
}

type TurnEntry = (usize, HistoryEntry, Option<String>);

pub(super) struct TranscriptAssociationScan {
    entries: Vec<HistoryEntry>,
    processed: usize,
    contexts: super::TranscriptToolContexts,
}
impl TranscriptAssociationScan {
    pub(super) fn new(entries: Vec<HistoryEntry>) -> Self {
        Self {
            entries,
            processed: 0,
            contexts: HashMap::new(),
        }
    }
    pub(super) fn step(&mut self, limit: usize) -> anyhow::Result<bool> {
        anyhow::ensure!(
            (1..=4096).contains(&limit),
            "invalid association scan budget"
        );
        let end = self.processed.saturating_add(limit).min(self.entries.len());
        super::extend_transcript_tool_contexts(
            &mut self.contexts,
            &self.entries[self.processed..end],
            self.processed,
        );
        self.processed = end;
        Ok(end == self.entries.len())
    }
    pub(super) fn finish(self, artifacts: Artifacts) -> anyhow::Result<TranscriptTurns> {
        anyhow::ensure!(
            self.processed == self.entries.len(),
            "tool association scan is incomplete"
        );
        Ok(TranscriptTurns::with_contexts(
            self.entries,
            artifacts,
            self.contexts,
        ))
    }
}

/// Resumable complete-turn projection. Construction still builds global tool
/// associations; a single large turn is not a fixed CPU or memory budget.
pub(super) struct TranscriptTurns {
    attempt_rows: super::turn_attempts::AttemptRows,
    entries: std::iter::Peekable<Box<dyn Iterator<Item = TurnEntry> + Send>>,
    contexts: super::TranscriptToolContexts,
    artifacts: Artifacts,
    approvals: HashMap<String, Vec<ApprovalDecisionArtifact>>,
    retired: HashMap<super::TranscriptToolId, usize>,
}

impl TranscriptTurns {
    pub(super) fn new(entries: Vec<HistoryEntry>, artifacts: Artifacts) -> Self {
        let mut scan = TranscriptAssociationScan::new(entries);
        while !scan.step(128).expect("fixed association budget is valid") {}
        scan.finish(artifacts).expect("association scan completed")
    }

    fn with_contexts(
        entries: Vec<HistoryEntry>,
        mut artifacts: Artifacts,
        contexts: super::TranscriptToolContexts,
    ) -> Self {
        let mut approvals = HashMap::<String, Vec<ApprovalDecisionArtifact>>::new();
        for approval in std::mem::take(&mut artifacts.approvals) {
            approvals
                .entry(approval.turn_id.clone())
                .or_default()
                .push(approval);
        }
        let mut turn = 0usize;
        let mut active_turn = None;
        let turn_ids = std::mem::take(&mut artifacts.turn_ids);
        let admitted_users = turn_ids
            .values()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let visible_uuids = entries
            .iter()
            .filter_map(|entry| entry.uuid.clone())
            .collect::<std::collections::HashSet<_>>();
        let represented = entries
            .iter()
            .filter(|entry| kcoder_engine::agent::is_real_user_message(&entry.message))
            .enumerate()
            .map(|(index, entry)| {
                entry
                    .uuid
                    .as_ref()
                    .and_then(|uuid| turn_ids.get(uuid))
                    .cloned()
                    .unwrap_or_else(|| format!("turn-{}", index + 1))
            })
            .collect::<std::collections::HashSet<_>>();
        let entries: Box<dyn Iterator<Item = TurnEntry> + Send> =
            Box::new(entries.into_iter().enumerate().map(move |(index, entry)| {
                if kcoder_engine::agent::is_real_user_message(&entry.message) {
                    turn = turn.saturating_add(1);
                    active_turn = Some(entry.uuid.as_ref().and_then(|uuid| turn_ids.get(uuid)).cloned()
                        .unwrap_or_else(|| format!("turn-{turn}")));
                }
                (index, entry, active_turn.clone())
            }));
        Self {
            attempt_rows: super::turn_attempts::AttemptRows::new(std::mem::take(&mut artifacts.attempts), &represented, &admitted_users, &visible_uuids),
            entries: entries.peekable(),
            contexts,
            artifacts,
            approvals,
            retired: HashMap::new(),
        }
    }

    pub(super) fn next_turn(&mut self) -> Option<Vec<ThreadMessage>> {
        let orphan = match self.entries.peek() {
            Some((_, _, Some(turn))) => self.attempt_rows.before_turn(Some(turn)),
            None => self.attempt_rows.before_turn(None),
            _ => None,
        };
        if orphan.is_some() { return orphan; }
        let (index, entry, turn_id) = self.entries.next()?;
        let mut messages = Vec::new();
        let uuid = entry.uuid.clone();
        messages.extend(self.project_entry(index, entry, turn_id.clone()));
        messages.extend(self.attempt_rows.after_entry(uuid.as_deref(), turn_id.as_deref()));
        while self
            .entries
            .peek()
            .is_some_and(|(_, _, next_turn)| next_turn == &turn_id)
        {
            let (index, entry, entry_turn) = self.entries.next().expect("peeked entry exists");
            let uuid = entry.uuid.clone();
            messages.extend(self.project_entry(index, entry, entry_turn));
            messages.extend(self.attempt_rows.after_entry(uuid.as_deref(), turn_id.as_deref()));
        }
        messages.extend(self.attempt_rows.finish_turn(turn_id.as_deref()));
        // Complete-turn transforms run together so paging cannot alter coalescing
        // or the placement of client IDs, outcomes, approvals and file changes.
        coalesce_assistant_tool_fragments(&mut messages);
        if let Some(turn_id) = turn_id.as_deref() {
            apply_turn_client_message_ids(
                &mut messages,
                take_turn(&mut self.artifacts.client_ids, turn_id),
            );
            apply_turn_outcomes(
                &mut messages,
                take_turn(&mut self.artifacts.outcomes, turn_id),
            );
            attach_approval_decision_blocks(
                &mut messages,
                self.approvals.remove(turn_id).unwrap_or_default(),
            );
            attach_turn_file_change_blocks(
                &mut messages,
                take_turn(&mut self.artifacts.file_changes, turn_id),
            );
        }
        Some(messages)
    }

    fn project_entry(
        &mut self,
        index: usize,
        entry: HistoryEntry,
        turn_id: Option<String>,
    ) -> Option<ThreadMessage> {
        use kcoder_types::{ContentBlock, Message};
        let content = match &entry.message {
            Message::User { content, .. } | Message::Assistant { content, .. } => content,
        };
        let references = content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolUse { id, .. } => Some(id.as_str()),
                ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id.as_str()),
                _ => None,
            })
            .filter_map(|id| self.contexts.get_key_value(id).map(|(id, _)| id.clone()))
            .collect::<Vec<_>>();
        let message = history_entry_thread_message(index, entry, turn_id, &self.contexts);
        for id in references {
            let Some(calls) = self.contexts.get_mut(&id) else {
                continue;
            };
            let mut retired = self.retired.get(&id).copied().unwrap_or(0);
            // References for successive occurrences are ordered by source position.
            while retired < calls.len() && calls[retired].last_reference_index <= index {
                let context = &mut calls[retired];
                context.name = String::new();
                context.input = Value::Null;
                context.output = None;
                retired += 1;
            }
            if retired == calls.len() {
                self.contexts.remove(&id);
                self.retired.remove(&id);
            } else if retired > 0 {
                self.retired.insert(id, retired);
            }
        }
        message
    }
}

#[cfg(test)]
mod tests {
    use super::super::transcript_tool_contexts;
    use super::*;
    use kcoder_app_protocol::{ApprovalAction, ApprovalDecision};
    use kcoder_types::Message;
    use serde_json::json;

    #[test]
    fn transcript_association_batches_preserve_reused_ids_and_global_ordinals() {
        let call = || json!({"role":"assistant","content":[{"type":"tool_use","id":"same","name":"Read","input":{}}]});
        let result = |text: &str| json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"same","content":[{"type":"text","text":text}]}]});
        let history = entries(vec![call(), result("first"), call(), result("second")]);
        assert!(
            TranscriptAssociationScan::new(history.clone())
                .finish(Artifacts::default())
                .is_err()
        );
        for budget in [1, 2, 3, 4096] {
            let mut scan = TranscriptAssociationScan::new(history.clone());
            assert!(scan.step(0).is_err());
            while !scan.step(budget).unwrap() {}
            assert_eq!(
                serde_json::to_value(&scan.contexts).unwrap(),
                serde_json::to_value(transcript_tool_contexts(&history)).unwrap()
            );
            assert!(scan.step(budget).unwrap());
            let calls = &scan.contexts["same"];
            assert_eq!(calls.len(), 2);
            assert_eq!((calls[0].entry_index, calls[1].entry_index), (0, 2));
            assert_eq!(calls[0].output.as_deref(), Some("first"));
            assert_eq!(calls[1].output.as_deref(), Some("second"));
            let mut turns = scan.finish(Artifacts::default()).unwrap();
            assert!(turns.next_turn().is_some());
        }
    }

    #[test]
    fn typed_associations_match_json_oracle_for_mixed_blocks_and_orphan_results() {
        let history = entries(vec![
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"orphan","content":[{"type":"text","text":"first"},{"type":"text","text":"second"}],"is_error":true}]}),
            json!({"role":"assistant","content":[{"type":"text","text":"ignored"},{"type":"thinking","thinking":"ignored","signature":""},{"type":"tool_use","id":"same","name":"Read","input":{"value":-0.0}}]}),
            json!({"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"ignored"}},{"type":"tool_result","tool_use_id":"same","content":[{"type":"text","text":"one"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"ignored"}},{"type":"text","text":"two"}]}]}),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"same","content":[],"is_error":false}]}),
            json!({"role":"assistant","content":[{"type":"tool_use","id":"same","name":"Write","input":{"value":0.0}}]}),
        ]);
        let expected = serde_json::to_value(transcript_tool_contexts(&history)).unwrap();
        for budget in [1, 2, 128] {
            let mut scan = TranscriptAssociationScan::new(history.clone());
            while !scan.step(budget).unwrap() {}
            assert_eq!(serde_json::to_value(scan.contexts).unwrap(), expected);
        }
    }

    #[test]
    fn transcript_projection_releases_finished_payloads_but_preserves_reused_ids() {
        let call = |value: &str| json!({"role":"assistant","content":[{"type":"tool_use","id":"same","name":"Read","input":{"payload":value.repeat(32768)}}]});
        let result = |value: &str| json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"same","content":[{"type":"text","text":value}]}]});
        let history = entries(vec![
            user("first"),
            call("a"),
            result("first output"),
            user("second"),
            call("b"),
            result("second output"),
        ]);
        let expected = old_page(history.clone(), Artifacts::default(), Some(100), None).messages;
        let mut turns = TranscriptTurns::new(history, Artifacts::default());
        let mut actual = turns.next_turn().unwrap();
        let contexts = &turns.contexts["same"];
        let key = turns.contexts.keys().next().unwrap();
        let retired_key = turns.retired.keys().next().unwrap();
        assert!(std::sync::Arc::ptr_eq(&key.0, &retired_key.0));
        assert!(contexts[0].input.is_null());
        assert!(contexts[0].output.is_none());
        assert!(contexts[0].name.is_empty());
        assert_eq!(contexts[1].input["payload"].as_str().unwrap().len(), 32768);
        actual.extend(turns.next_turn().unwrap());
        assert!(turns.contexts.is_empty());
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }

    #[test]
    fn transcript_projection_keeps_payload_until_late_cross_turn_result() {
        let history = entries(vec![
            user("first"),
            json!({"role":"assistant","content":[{"type":"tool_use","id":"late","name":"Read","input":{"payload":"retain"}}]}),
            user("second"),
            assistant("answer"),
            user("third"),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"late","content":[{"type":"text","text":"late result"}]}]}),
        ]);
        let expected = old_page(history.clone(), Artifacts::default(), Some(100), None).messages;
        let mut turns = TranscriptTurns::new(history, Artifacts::default());
        let mut actual = turns.next_turn().unwrap();
        assert_eq!(turns.contexts["late"][0].input["payload"], "retain");
        actual.extend(turns.next_turn().unwrap());
        assert_eq!(
            turns.contexts["late"][0].output.as_deref(),
            Some("late result")
        );
        actual.extend(turns.next_turn().unwrap());
        assert!(turns.contexts.is_empty());
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }

    #[test]
    fn transcript_association_scan_obeys_entry_budget() {
        let history = entries((0..250).map(|n| user(&format!("request {n}"))).collect());
        let mut scan = TranscriptAssociationScan::new(history);
        assert!(!scan.step(1).unwrap());
        assert_eq!(scan.processed, 1);
    }

    #[test]
    fn transcript_turn_projection_can_pause_without_rendering_all_turns() {
        let history = entries((0..250).map(|n| user(&format!("request {n}"))).collect());
        let mut turns = TranscriptTurns::new(history, Artifacts::default());
        assert_eq!(turns.next_turn().unwrap().len(), 1);
        for _ in 1..250 {
            assert_eq!(turns.next_turn().unwrap().len(), 1);
        }
        assert!(turns.next_turn().is_none());
        assert!(turns.next_turn().is_none());
    }

    #[test]
    fn transcript_row_sink_emits_beyond_page_limit_and_propagates_failure() {
        let history = entries((0..250).map(|n| user(&format!("request {n}"))).collect());
        let mut count = 0;
        assert_eq!(
            visit_rows(history.clone(), Artifacts::default(), |ordinal, _| {
                assert_eq!(ordinal, count);
                count += 1;
                Ok(true)
            })
            .unwrap(),
            250
        );
        let mut calls = 0;
        let failure = visit_rows(history.clone(), Artifacts::default(), |_, _| {
            calls += 1;
            if calls == 2 {
                anyhow::bail!("index write failed");
            }
            Ok(true)
        })
        .unwrap_err();
        assert_eq!(calls, 2);
        assert_eq!(failure.to_string(), "index write failed");
        let mut calls = 0;
        assert_eq!(
            visit_rows(history, Artifacts::default(), |_, _| {
                calls += 1;
                Ok(false)
            })
            .unwrap(),
            1
        );
        assert_eq!(calls, 1);
    }

    #[test]
    fn transcript_window_retains_only_limit_and_moves_allocations() {
        let rows = (0..5)
            .map(|index| format!("owned-row-{index}"))
            .collect::<Vec<_>>();
        let addresses = rows.iter().map(|row| row.as_ptr()).collect::<Vec<_>>();
        let mut window = Window::new(Some(2), None);
        let mut high_water = 0;
        for row in rows {
            window.push(row);
            high_water = high_water.max(window.rows.len());
        }
        let (start, end, rows) = window.finish();
        assert_eq!((start, end), (3, 5));
        assert_eq!(rows, ["owned-row-3", "owned-row-4"]);
        assert_eq!(
            rows.iter().map(|row| row.as_ptr()).collect::<Vec<_>>(),
            addresses[3..]
        );
        assert_eq!(high_water, 2, "discarded display rows must not accumulate");
    }

    #[test]
    fn transcript_window_cursor_and_limit_matrix() {
        for count in [0, 5, 105] {
            for limit in [None, Some(0), Some(1), Some(2), Some(100), Some(u32::MAX)] {
                for cursor in [
                    None,
                    Some("0"),
                    Some("1"),
                    Some("3"),
                    Some("5"),
                    Some("500"),
                    Some("invalid"),
                    Some("-1"),
                    Some("999999999999999999999999999999999999999"),
                ] {
                    let mut window = Window::new(limit, cursor);
                    for row in 0..count {
                        window.push(row);
                        assert!(window.rows.len() <= window.limit);
                    }
                    let end = cursor
                        .and_then(|value| value.parse::<usize>().ok())
                        .unwrap_or(count)
                        .min(count);
                    let start = end.saturating_sub(limit.unwrap_or(50).clamp(1, 100) as usize);
                    assert_eq!(
                        window.finish(),
                        (start, end, (start..end).collect::<Vec<_>>()),
                        "count={count}, limit={limit:?}, cursor={cursor:?}"
                    );
                }
            }
        }
    }

    // Keep the pre-window implementation independent as a compatibility oracle.
    fn old_page(
        entries: Vec<HistoryEntry>,
        artifacts: Artifacts,
        limit: Option<u32>,
        cursor: Option<&str>,
    ) -> Page {
        let history_messages = entries
            .iter()
            .map(|entry| entry.message.clone())
            .collect::<Vec<_>>();
        let ids = kcoder_engine::client_turn_ids_for_messages(&history_messages);
        let contexts = transcript_tool_contexts(&entries);
        let mut messages = entries
            .into_iter()
            .zip(ids)
            .enumerate()
            .filter_map(|(index, (entry, turn))| {
                history_entry_thread_message(index, entry, turn, &contexts)
            })
            .collect::<Vec<_>>();
        coalesce_assistant_tool_fragments(&mut messages);
        apply_turn_client_message_ids(&mut messages, artifacts.client_ids);
        apply_turn_outcomes(&mut messages, artifacts.outcomes);
        attach_approval_decision_blocks(&mut messages, artifacts.approvals);
        attach_turn_file_change_blocks(&mut messages, artifacts.file_changes);
        let end = cursor
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(messages.len())
            .min(messages.len());
        let start = end.saturating_sub(limit.unwrap_or(50).clamp(1, 100) as usize);
        Page {
            start,
            end,
            messages: messages[start..end].to_vec(),
        }
    }

    fn entries(raw: Vec<Value>) -> Vec<HistoryEntry> {
        raw.into_iter()
            .enumerate()
            .map(|(index, message)| HistoryEntry {
                session_id: "session".into(),
                timestamp_ms: 100 + index as u64,
                uuid: (index % 2 == 0).then(|| format!("entry-{index}")),
                parent_uuid: None,
                message: serde_json::from_value(message).unwrap(),
            })
            .collect()
    }

    fn user(text: &str) -> Value {
        serde_json::to_value(Message::user_text(text)).unwrap()
    }
    fn assistant(text: &str) -> Value {
        json!({"role":"assistant", "content":[{"type":"text", "text":text}]})
    }
    fn call(id: &str, name: &str) -> Value {
        json!({"type":"tool_use", "id":id, "name":name, "input":{"command":"pwd"}})
    }
    fn result(id: &str, output: &str) -> Value {
        json!({"type":"tool_result", "tool_use_id":id, "content":[{"type":"text", "text":output}]})
    }

    fn artifacts() -> Artifacts {
        let mut artifacts = Artifacts::default();
        for (index, turn) in ["turn-1", "turn-2", "turn-3", "turn-4", "turn-99"]
            .into_iter()
            .enumerate()
        {
            artifacts
                .client_ids
                .insert(turn.into(), format!("client-{turn}"));
            artifacts.outcomes.insert(
                turn.into(),
                TurnOutcomeArtifact {
                    version: 1,
                    thread_id: "session".into(),
                    turn_id: turn.into(),
                    status: if index % 2 == 0 {
                        "interrupted"
                    } else {
                        "failed"
                    }
                    .into(),
                    error: Some("failure detail".into()),
                    provider_failure: None,
                    continuation_context_hash: None,
                    completed_at_ms: 1000 + index as u64,
                },
            );
            artifacts.file_changes.insert(
                turn.into(),
                json!({"artifact_id":turn,"files":[{"path":"src/main.rs"}],"status":"ready"}),
            );
        }
        for (index, turn) in ["turn-2", "turn-1", "turn-2", "turn-3", "turn-99"]
            .into_iter()
            .enumerate()
        {
            artifacts.approvals.push(ApprovalDecisionArtifact {
                version: 1,
                artifact_id: format!("approval-{index}"),
                thread_id: "session".into(),
                turn_id: turn.into(),
                approval_id: format!("request-{index}"),
                action: ApprovalAction::Command {
                    command: "pwd".into(),
                },
                reason: "Please confirm".into(),
                decision: ApprovalDecision::Accept,
                resolution_reason: "user".into(),
                requested_at_ms: 2000 + index as u64,
                resolved_at_ms: 2100 + index as u64,
            });
        }
        artifacts
    }

    fn assert_pages_match(history: Vec<HistoryEntry>, with_artifacts: bool) {
        let make_artifacts = || {
            if with_artifacts {
                artifacts()
            } else {
                Artifacts::default()
            }
        };
        let total = old_page(history.clone(), make_artifacts(), Some(100), None).end;
        let mut indexed_rows = Vec::new();
        let emitted = visit_rows(history.clone(), make_artifacts(), |ordinal, message| {
            assert_eq!(ordinal, indexed_rows.len());
            indexed_rows.push(message);
            Ok(true)
        })
        .unwrap();
        assert_eq!(emitted, total);
        let mut cursors = vec![
            None,
            Some("invalid".into()),
            Some("99999999999999999999999999999999999999".into()),
        ];
        cursors.extend((0..=total + 2).map(|end| Some(end.to_string())));
        for cursor in cursors {
            for limit in [
                None,
                Some(0),
                Some(1),
                Some(2),
                Some(3),
                Some(100),
                Some(u32::MAX),
            ] {
                let expected =
                    old_page(history.clone(), make_artifacts(), limit, cursor.as_deref());
                let actual = project(history.clone(), make_artifacts(), limit, cursor.as_deref());
                assert_eq!(
                    serde_json::to_value(&indexed_rows[expected.start..expected.end]).unwrap(),
                    serde_json::to_value(&expected.messages).unwrap(),
                    "index sink cursor={cursor:?}, limit={limit:?}"
                );
                assert_eq!(
                    (actual.start, actual.end),
                    (expected.start, expected.end),
                    "cursor={cursor:?}, limit={limit:?}"
                );
                assert_eq!(
                    serde_json::to_value(&actual.messages).unwrap(),
                    serde_json::to_value(&expected.messages).unwrap(),
                    "cursor={cursor:?}, limit={limit:?}"
                );
            }
        }
    }

    #[test]
    fn transcript_window_oracle_empty_prefix_and_hidden_turns() {
        assert_pages_match(Vec::new(), true);
        assert_pages_match(
            entries(vec![assistant("prefix"), assistant("second prefix")]),
            true,
        );
        let hidden = json!({"role":"user","content":[{"type":"text","text":"<system-reminder>hidden</system-reminder>"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}}]});
        assert_pages_match(
            entries(vec![
                assistant("prefix"),
                hidden.clone(),
                user("second turn"),
            ]),
            true,
        );
        let history = entries(vec![
            assistant("prefix"),
            assistant("second prefix"),
            user("<system-reminder>context</system-reminder>"),
            user("first turn"),
            assistant("first reply"),
            hidden,
            assistant("hidden turn reply"),
            user("empty interrupted"),
            user("empty failed"),
        ]);
        assert!(kcoder_engine::agent::is_real_user_message(
            &history[5].message
        ));
        let visible = history_entry_thread_message(
            5,
            history[5].clone(),
            Some("turn-2".into()),
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(visible.role, "user");
        assert_eq!(visible.content, "<system-reminder>hidden</system-reminder>\n[image]");
        assert_pages_match(history, true);
        let many_turns = (0..60)
            .flat_map(|index| {
                [
                    user(&format!("prompt {index}")),
                    assistant(&format!("answer {index}")),
                ]
            })
            .collect();
        assert_pages_match(entries(many_turns), false);
    }

    #[test]
    fn transcript_window_oracle_global_reused_parallel_and_late_results() {
        let history = entries(vec![
            user("first"),
            json!({"role":"assistant","content":[{"type":"thinking","thinking":"reason before","signature":""},{"type":"text","text":"commentary"},call("reused","bash"),call("parallel","Read")]}),
            user("second"),
            json!({"role":"user","content":[result("parallel","B"),result("reused","first")]}),
            json!({"role":"user","content":[result("reused","late replacement")]}),
            assistant("separate answer"),
            assistant("second answer"),
            json!({"role":"assistant","content":[call("reused","Read")]}),
            json!({"role":"user","content":[result("reused","second"),{"type":"text","text":"visible user without a new turn"}]}),
            json!({"role":"assistant","content":[{"type":"thinking","thinking":"reason after","signature":""},{"type":"text","text":"done"}]}),
            user("third"),
            json!({"role":"user","content":[result("reused","late duplicate in third turn")]}),
        ]);
        assert_pages_match(history, true);
    }

    #[test]
    fn transcript_window_oracle_large_blocks_attachments_and_questions() {
        let prompt = format!(
            "{}\n\n<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
            "你".repeat(super::super::MAX_TRANSCRIPT_MESSAGE_BYTES),
            json!({"filename":"screen.png","mimeType":"image/png","fileSize":42,"path":"/private/screen.png"})
        );
        let history = entries(vec![
            user(&prompt),
            json!({"role":"assistant","content":[{"type":"thinking","thinking":"x".repeat(300_000),"signature":""},{"type":"text","text":"large commentary"},{"type":"tool_use","id":"question","name":"AskUserQuestion","input":{"questions":[{"question":"Which?","header":"Option","options":[{"label":"ALPHA","description":"A"},{"label":"BETA","description":"B"}],"multi_select":false}]}}]}),
            json!({"role":"user","content":[result("question", &json!({"questions":[],"answers":{"Which?":"BETA"},"annotations":null}).to_string())]}),
            assistant("finished"),
            user("next"),
            assistant("last"),
        ]);
        assert_pages_match(history, true);
    }
}
