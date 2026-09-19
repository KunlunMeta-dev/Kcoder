//! Lightweight derived state for the conversation outline; it owns no body text and does not change transcript scroll position.

use std::collections::{HashMap, HashSet, VecDeque};

use kcoder_types::MessageRole;

use crate::message_render::{
    LIVE_THINKING_MESSAGE_PREFIX, THINKING_MESSAGE_PREFIX, display_text_is_hidden_internal_context,
};
use crate::transcript_identity::{EntryId, TranscriptAnchor};
use crate::transcript_store::TranscriptStore;

const INDEX_BATCH: usize = 256;
const HEADING_BYTES_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum OutlineKind {
    Turn,
    Answer,
    Heading,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct OutlineKey {
    pub(crate) anchor: TranscriptAnchor,
    pub(crate) kind: OutlineKind,
}

#[derive(Debug, Clone)]
pub(crate) struct OutlineHeading {
    pub(crate) level: u8,
    pub(crate) source_byte: usize,
    pub(crate) title: String,
}

#[derive(Debug, Clone)]
pub(crate) struct OutlineRow {
    pub(crate) key: OutlineKey,
    pub(crate) anchor: TranscriptAnchor,
    pub(crate) kind: OutlineKind,
    pub(crate) depth: usize,
    pub(crate) label: String,
    pub(crate) expandable: bool,
    pub(crate) expanded: bool,
}

#[derive(Debug, Clone)]
struct Answer {
    anchor: TranscriptAnchor,
    revision: u64,
    label: String,
}

#[derive(Debug, Clone)]
struct Turn {
    anchor: TranscriptAnchor,
    label: String,
    answers: Vec<Answer>,
}

#[derive(Debug, Clone)]
struct HeadingDetail {
    revision: u64,
    headings: Vec<OutlineHeading>,
    bytes: usize,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct OutlineModel {
    pub(crate) query: String,
    list_focus: bool,
    selected: Option<OutlineKey>,
    scroll: usize,
    view_revision: u64,
    indexed: usize,
    total: usize,
    epoch: Option<u64>,
    first_id: Option<EntryId>,
    turns: Vec<Turn>,
    entry_turn: HashMap<EntryId, usize>,
    entry_index: HashMap<EntryId, usize>,
    answer_revisions: HashMap<EntryId, u64>,
    collapsed: HashSet<OutlineKey>,
    known_turns: HashSet<EntryId>,
    headings: HashMap<EntryId, HeadingDetail>,
    heading_lru: VecDeque<EntryId>,
    heading_bytes: usize,
    rows: Vec<OutlineRow>,
    viewport_rows: usize,
    reveal_selected: bool,
    pending_headings: Vec<(EntryId, u64)>,
    unavailable_headings: HashMap<EntryId, u64>,
    prune_after_rebuild: bool,
    evicted_headings: HashMap<EntryId, u64>,
    streaming_turn: Option<EntryId>,
    pending_open: Option<Option<TranscriptAnchor>>,
    turn_rows_start: Vec<usize>,
}

fn key(anchor: TranscriptAnchor, kind: OutlineKind) -> OutlineKey {
    OutlineKey { anchor, kind }
}

fn summary(text: &str, fallback: &str) -> String {
    // Read only a bounded prefix so labels never scan an entire oversized user input.
    let prefix: String = text.chars().take(192).collect();
    let label = prefix.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.is_empty() {
        fallback.to_string()
    } else {
        label
    }
}

impl OutlineModel {
    pub(crate) fn sync(&mut self, store: &TranscriptStore) -> bool {
        let first_id = store.identity(0).map(|meta| meta.id);
        let reset = self.epoch != Some(store.render_epoch())
            || self.first_id != first_id
            || self.indexed > store.len();
        if reset {
            self.prune_after_rebuild = true;
            let same_scope = self.first_id == first_id && first_id.is_some();
            self.indexed = 0;
            self.turns.clear();
            self.entry_turn.clear();
            self.entry_index.clear();
            self.answer_revisions.clear();
            self.rows.clear();
            self.turn_rows_start.clear();
            if !same_scope {
                self.headings.clear();
                self.heading_lru.clear();
                self.heading_bytes = 0;
                self.collapsed.clear();
                self.known_turns.clear();
                self.unavailable_headings.clear();
                self.evicted_headings.clear();
                self.streaming_turn = None;
                self.pending_open = None;
                self.selected = None;
                self.scroll = 0;
            }
            self.epoch = Some(store.render_epoch());
            self.first_id = first_id;
        }
        self.total = store.len();
        let previous_turns = self.turns.len();
        let end = self.total.min(self.indexed.saturating_add(INDEX_BATCH));
        if !reset && end == self.indexed {
            return true;
        }
        for index in self.indexed..end {
            let message = &store[index];
            let Some(meta) = store.identity(index) else {
                continue;
            };
            let anchor = TranscriptAnchor {
                entry: meta.id,
                source_byte: 0,
            };
            self.entry_index.insert(meta.id, index);
            let is_user = message.role == MessageRole::User;
            let hidden = display_text_is_hidden_internal_context(&message.text, is_user);
            if is_user && !hidden {
                let turn_key = key(anchor, OutlineKind::Turn);
                if self.known_turns.insert(anchor.entry) {
                    self.collapsed.insert(turn_key);
                }
                self.turns.push(Turn {
                    anchor,
                    label: format!(
                        "Turn {}  {}",
                        self.turns.len() + 1,
                        summary(&message.text, "Attachment task")
                    ),
                    answers: Vec::new(),
                });
            } else if message.role == MessageRole::Assistant
                && !hidden
                && !message.text.trim().is_empty()
                && !message.text.starts_with(THINKING_MESSAGE_PREFIX)
                && !message.text.starts_with(LIVE_THINKING_MESSAGE_PREFIX)
            {
                if self.turns.is_empty() {
                    self.turns.push(Turn {
                        anchor,
                        label: "History segment".to_string(),
                        answers: Vec::new(),
                    });
                }
                let turn = self.turns.last_mut().expect("turn should already exist");
                let prefix = if turn.answers.is_empty() {
                    "Answer start"
                } else {
                    "Answer continuation"
                };
                turn.answers.push(Answer {
                    anchor,
                    revision: meta.revision,
                    label: format!("{prefix} · {}", summary(&message.text, "Answer")),
                });
                self.answer_revisions.insert(meta.id, meta.revision);
            }
            if !self.turns.is_empty() {
                self.entry_turn.insert(meta.id, self.turns.len() - 1);
            }
        }
        self.indexed = end;
        if self.prune_after_rebuild && end == self.total {
            self.known_turns
                .retain(|entry| self.entry_index.contains_key(entry));
            self.collapsed
                .retain(|key| self.entry_index.contains_key(&key.anchor.entry));
            self.headings
                .retain(|entry, detail| self.answer_revisions.get(entry) == Some(&detail.revision));
            self.heading_lru
                .retain(|entry| self.headings.contains_key(entry));
            self.heading_bytes = self.headings.values().map(|detail| detail.bytes).sum();
            self.unavailable_headings
                .retain(|entry, revision| self.answer_revisions.get(entry) == Some(revision));
            self.prune_after_rebuild = false;
            self.evicted_headings
                .retain(|entry, revision| self.answer_revisions.get(entry) == Some(revision));
        }
        self.rebuild_rows_from(previous_turns.saturating_sub(1));
        if end == self.total
            && let Some(anchor) = self.pending_open.take()
        {
            self.open_at(anchor);
        }
        end == self.total
    }

    pub(crate) fn set_headings(
        &mut self,
        entry: EntryId,
        revision: u64,
        headings: Vec<OutlineHeading>,
    ) {
        if self.answer_revisions.get(&entry) != Some(&revision) {
            return;
        }
        if self
            .headings
            .get(&entry)
            .is_some_and(|detail| detail.revision == revision)
        {
            return;
        }
        let bytes = headings
            .iter()
            .map(|heading| heading.title.len() + std::mem::size_of::<OutlineHeading>())
            .sum();
        if bytes > HEADING_BYTES_LIMIT {
            self.mark_headings_unavailable(entry, revision);
            return;
        }
        if let Some(old) = self.headings.remove(&entry) {
            self.heading_bytes = self.heading_bytes.saturating_sub(old.bytes);
        }
        self.heading_lru.retain(|id| *id != entry);
        while self.heading_bytes + bytes > HEADING_BYTES_LIMIT {
            let Some(old) = self.heading_lru.pop_front() else {
                break;
            };
            if let Some(detail) = self.headings.remove(&old) {
                self.heading_bytes = self.heading_bytes.saturating_sub(detail.bytes);
                self.evicted_headings.insert(old, detail.revision);
            }
        }
        for heading in &headings {
            if heading.level >= 3 {
                self.collapsed.insert(key(
                    TranscriptAnchor {
                        entry,
                        source_byte: heading.source_byte,
                    },
                    OutlineKind::Heading,
                ));
            }
        }
        self.heading_bytes += bytes;
        self.unavailable_headings.remove(&entry);
        self.evicted_headings.remove(&entry);
        self.heading_lru.push_back(entry);
        self.headings.insert(
            entry,
            HeadingDetail {
                revision,
                headings,
                bytes,
            },
        );
        self.rebuild_rows();
    }

    pub(crate) fn next_missing_headings(
        &self,
        store: &TranscriptStore,
    ) -> Option<(EntryId, u64, usize)> {
        self.pending_headings.iter().find_map(|(id, revision)| {
            let index = *self.entry_index.get(id)?;
            let meta = store.identity(index)?;
            (meta.id == *id && meta.revision == *revision).then_some((*id, *revision, index))
        })
    }

    pub(crate) fn mark_headings_unavailable(&mut self, entry: EntryId, revision: u64) {
        if self.answer_revisions.get(&entry) == Some(&revision) {
            self.unavailable_headings.insert(entry, revision);
            self.rebuild_rows();
        }
    }

    pub(crate) fn has_pending_work(&self) -> bool {
        self.indexing() || !self.pending_headings.is_empty()
    }
    pub(crate) fn is_indexing(&self) -> bool {
        self.indexing()
    }
    pub(crate) fn has_pending_headings(&self) -> bool {
        !self.pending_headings.is_empty()
    }
    pub(crate) fn headings_unavailable(&self) -> bool {
        !self.unavailable_headings.is_empty() || !self.evicted_headings.is_empty()
    }

    pub(crate) fn set_streaming_turn(&mut self, anchor: Option<TranscriptAnchor>) {
        let entry = anchor.map(|anchor| anchor.entry);
        if self.streaming_turn != entry {
            self.streaming_turn = entry;
            self.rebuild_rows();
        }
    }

    pub(crate) fn open_at(&mut self, anchor: Option<TranscriptAnchor>) {
        if self.indexing()
            && anchor.is_none_or(|anchor| !self.entry_turn.contains_key(&anchor.entry))
        {
            self.pending_open = Some(anchor);
        }
        let turn_index = anchor
            .and_then(|anchor| self.entry_turn.get(&anchor.entry).copied())
            .or_else(|| self.turns.len().checked_sub(1));
        if let Some(index) = turn_index {
            let turn = &self.turns[index];
            self.collapsed.remove(&key(turn.anchor, OutlineKind::Turn));
            for answer in &turn.answers {
                self.evicted_headings.remove(&answer.anchor.entry);
                if self.headings.contains_key(&answer.anchor.entry) {
                    self.heading_lru
                        .retain(|entry| *entry != answer.anchor.entry);
                    self.heading_lru.push_back(answer.anchor.entry);
                }
            }
            self.selected = Some(
                anchor
                    .and_then(|anchor| {
                        turn.answers
                            .iter()
                            .find(|answer| answer.anchor.entry == anchor.entry)
                    })
                    .map_or(key(turn.anchor, OutlineKind::Turn), |answer| {
                        key(answer.anchor, OutlineKind::Answer)
                    }),
            );
        }
        self.rebuild_rows();
    }

    pub(crate) fn set_query(&mut self, query: &str) {
        if self.query != query {
            self.pending_open = None;
            self.query = query.to_string();
            self.evicted_headings.clear();
            self.scroll = 0;
            self.rebuild_rows();
        }
    }

    pub(crate) fn search_focus(&self) -> bool {
        !self.list_focus
    }
    pub(crate) fn toggle_focus(&mut self) {
        self.list_focus = !self.list_focus;
    }
    pub(crate) fn selected_key(&self) -> Option<OutlineKey> {
        self.selected
    }
    pub(crate) fn selected_anchor(&self) -> Option<TranscriptAnchor> {
        self.selected.map(|key| key.anchor)
    }
    pub(crate) fn visible_rows(&self) -> &[OutlineRow] {
        &self.rows
    }
    pub(crate) fn view_revision(&self) -> u64 {
        self.view_revision
    }
    pub(crate) fn scroll_offset(&self) -> usize {
        self.scroll
    }
    pub(crate) fn indexing(&self) -> bool {
        self.indexed < self.total
    }

    #[cfg(test)]
    fn select_key(&mut self, key: OutlineKey) -> bool {
        if self.rows.iter().any(|row| row.key == key) {
            self.selected = Some(key);
            self.view_revision = self.view_revision.wrapping_add(1);
            true
        } else {
            false
        }
    }

    pub(crate) fn move_selection(&mut self, delta: isize, page_rows: usize) {
        self.pending_open = None;
        if self.rows.is_empty() {
            return;
        }
        let current = self
            .selected
            .and_then(|key| self.rows.iter().position(|row| row.key == key))
            .unwrap_or(0);
        let next = current
            .saturating_add_signed(delta)
            .min(self.rows.len() - 1);
        self.selected = Some(self.rows[next].key);
        self.ensure_visible(page_rows);
        self.view_revision = self.view_revision.wrapping_add(1);
    }

    pub(crate) fn scroll_list(&mut self, delta: isize, page_rows: usize) {
        self.scroll = self
            .scroll
            .saturating_add_signed(delta)
            .min(self.rows.len().saturating_sub(page_rows.max(1)));
        self.view_revision = self.view_revision.wrapping_add(1);
        self.reveal_selected = false;
    }

    pub(crate) fn prepare_viewport(&mut self, page_rows: usize) {
        if self.viewport_rows != page_rows || self.reveal_selected {
            self.viewport_rows = page_rows;
            self.ensure_visible(page_rows);
            self.reveal_selected = false;
        }
    }

    pub(crate) fn ensure_visible(&mut self, page_rows: usize) {
        let Some(index) = self
            .selected
            .and_then(|key| self.rows.iter().position(|row| row.key == key))
        else {
            return;
        };
        let height = page_rows.max(1);
        let old = self.scroll;
        if index < self.scroll {
            self.scroll = index;
        }
        if index >= self.scroll + height {
            self.scroll = index + 1 - height;
        }
        if self.scroll != old {
            self.view_revision = self.view_revision.wrapping_add(1);
        }
    }

    pub(crate) fn toggle_key(&mut self, key: OutlineKey) {
        if !self.rows.iter().any(|row| row.key == key && row.expandable) {
            return;
        }
        if !self.collapsed.remove(&key) {
            self.collapsed.insert(key);
        } else {
            self.request_evicted_details(key);
        }
        self.rebuild_rows();
    }

    pub(crate) fn collapse_selected(&mut self) {
        if let Some(key) = self.selected {
            self.collapsed.insert(key);
            self.rebuild_rows();
        }
    }

    pub(crate) fn expand_selected(&mut self) {
        if let Some(key) = self.selected {
            self.collapsed.remove(&key);
            self.request_evicted_details(key);
            self.rebuild_rows();
        }
    }

    fn request_evicted_details(&mut self, key: OutlineKey) {
        let Some(turn) = self
            .entry_turn
            .get(&key.anchor.entry)
            .and_then(|index| self.turns.get(*index))
        else {
            return;
        };
        for answer in &turn.answers {
            if key.kind == OutlineKind::Turn || answer.anchor.entry == key.anchor.entry {
                self.evicted_headings.remove(&answer.anchor.entry);
            }
        }
    }

    pub(crate) fn latest_turn(&self) -> Option<TranscriptAnchor> {
        self.turns.last().map(|turn| turn.anchor)
    }
    pub(crate) fn answer_start_for(&self, anchor: TranscriptAnchor) -> Option<TranscriptAnchor> {
        let turn = self.turns.get(*self.entry_turn.get(&anchor.entry)?)?;
        Some(
            turn.answers
                .first()
                .map_or(turn.anchor, |answer| answer.anchor),
        )
    }
    pub(crate) fn previous_turn(&self, anchor: TranscriptAnchor) -> Option<TranscriptAnchor> {
        self.turns
            .get(self.entry_turn.get(&anchor.entry)?.checked_sub(1)?)
            .map(|turn| turn.anchor)
    }
    pub(crate) fn next_turn(&self, anchor: TranscriptAnchor) -> Option<TranscriptAnchor> {
        self.turns
            .get(self.entry_turn.get(&anchor.entry)?.checked_add(1)?)
            .map(|turn| turn.anchor)
    }

    fn rebuild_rows(&mut self) {
        self.rebuild_rows_from(0);
    }

    fn rebuild_rows_from(&mut self, start_turn: usize) {
        // A regular append rebuilds at most the previous final turn and new turns; only search or structural invalidation rebuilds all lightweight rows.
        let start_turn = if self.query.is_empty() && start_turn < self.turn_rows_start.len() {
            start_turn
        } else {
            0
        };
        let prefix_rows = self.turn_rows_start.get(start_turn).copied().unwrap_or(0);
        self.turn_rows_start.truncate(start_turn);
        self.pending_headings = self
            .turns
            .iter()
            .filter(|turn| {
                self.streaming_turn != Some(turn.anchor.entry)
                    && (!self.query.is_empty()
                        || !self
                            .collapsed
                            .contains(&key(turn.anchor, OutlineKind::Turn)))
            })
            .flat_map(|turn| &turn.answers)
            .filter(|answer| {
                self.unavailable_headings.get(&answer.anchor.entry) != Some(&answer.revision)
                    && self.evicted_headings.get(&answer.anchor.entry) != Some(&answer.revision)
                    && self
                        .headings
                        .get(&answer.anchor.entry)
                        .is_none_or(|detail| detail.revision != answer.revision)
            })
            .map(|answer| (answer.anchor.entry, answer.revision))
            .collect();
        let mut all: Vec<(OutlineRow, Option<usize>)> = Vec::new();
        let mut turn_starts = Vec::new();
        for turn in self.turns.iter().skip(start_turn) {
            let turn_index = all.len();
            turn_starts.push(turn_index);
            let turn_key = key(turn.anchor, OutlineKind::Turn);
            all.push((
                OutlineRow {
                    key: turn_key,
                    anchor: turn.anchor,
                    kind: OutlineKind::Turn,
                    depth: 0,
                    label: if self.streaming_turn == Some(turn.anchor.entry) {
                        format!("{}  streaming", turn.label)
                    } else {
                        turn.label.clone()
                    },
                    expandable: !turn.answers.is_empty(),
                    expanded: !self.collapsed.contains(&turn_key),
                },
                None,
            ));
            for answer in &turn.answers {
                let answer_index = all.len();
                let answer_key = key(answer.anchor, OutlineKind::Answer);
                let detail = self
                    .headings
                    .get(&answer.anchor.entry)
                    .filter(|detail| detail.revision == answer.revision);
                all.push((
                    OutlineRow {
                        key: answer_key,
                        anchor: answer.anchor,
                        kind: OutlineKind::Answer,
                        depth: 1,
                        label: answer.label.clone(),
                        expandable: detail.is_some_and(|detail| !detail.headings.is_empty()),
                        expanded: !self.collapsed.contains(&answer_key),
                    },
                    Some(turn_index),
                ));
                let mut parents: Vec<(u8, usize)> = Vec::new();
                for heading in detail.into_iter().flat_map(|detail| &detail.headings) {
                    while parents
                        .last()
                        .is_some_and(|(level, _)| *level >= heading.level)
                    {
                        parents.pop();
                    }
                    let parent = parents.last().map_or(answer_index, |(_, index)| *index);
                    let depth = all[parent].0.depth + 1;
                    let anchor = TranscriptAnchor {
                        entry: answer.anchor.entry,
                        source_byte: heading.source_byte,
                    };
                    let heading_key = key(anchor, OutlineKind::Heading);
                    all[parent].0.expandable = true;
                    parents.push((heading.level, all.len()));
                    all.push((
                        OutlineRow {
                            key: heading_key,
                            anchor,
                            kind: OutlineKind::Heading,
                            depth,
                            label: heading.title.clone(),
                            expandable: false,
                            expanded: !self.collapsed.contains(&heading_key),
                        },
                        Some(parent),
                    ));
                }
            }
        }
        let query = self.query.to_ascii_lowercase();
        let mut keep = vec![false; all.len()];
        if query.is_empty() {
            for index in 0..all.len() {
                keep[index] = all[index]
                    .1
                    .is_none_or(|parent| keep[parent] && all[parent].0.expanded);
            }
        } else {
            for index in 0..all.len() {
                if all[index].0.label.to_ascii_lowercase().contains(&query) {
                    let mut cursor = Some(index);
                    while let Some(index) = cursor {
                        keep[index] = true;
                        cursor = all[index].1;
                    }
                }
            }
        }
        let mut visible_offset = prefix_rows;
        let mut next_turn = turn_starts.into_iter().peekable();
        for (index, kept) in keep.iter().enumerate() {
            if next_turn.peek() == Some(&index) {
                self.turn_rows_start.push(visible_offset);
                next_turn.next();
            }
            visible_offset += usize::from(*kept);
        }
        self.rows.truncate(prefix_rows);
        self.rows.extend(
            all.into_iter()
                .zip(keep)
                .filter_map(|((row, _), keep)| keep.then_some(row)),
        );
        let selected_in_prefix = self
            .selected
            .and_then(|key| self.entry_turn.get(&key.anchor.entry))
            .is_some_and(|turn| *turn < start_turn);
        if !selected_in_prefix
            && !self.rows[prefix_rows..]
                .iter()
                .any(|row| Some(row.key) == self.selected)
        {
            let pending_entry = self.selected.is_some_and(|key| {
                self.indexing() && !self.entry_index.contains_key(&key.anchor.entry)
            });
            if !pending_entry {
                // When heading body text is replaced, prefer the start of the same answer rather than another turn.
                self.selected = self
                    .selected
                    .and_then(|key| {
                        self.rows
                            .iter()
                            .find(|row| {
                                row.anchor.entry == key.anchor.entry
                                    && row.kind == OutlineKind::Answer
                            })
                            .map(|row| row.key)
                    })
                    .or_else(|| self.rows.first().map(|row| row.key));
            }
        }
        self.scroll = self.scroll.min(self.rows.len().saturating_sub(1));
        self.view_revision = self.view_revision.wrapping_add(1);
        self.reveal_selected = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::DisplayMessage;

    fn store(messages: &[(MessageRole, &str)]) -> TranscriptStore {
        messages
            .iter()
            .map(|(role, text)| DisplayMessage {
                role: *role,
                text: text.to_string(),
            })
            .collect()
    }

    #[test]
    fn groups_answer_segments_and_excludes_internal_context_and_thinking() {
        let store = store(&[
            (MessageRole::User, "task"),
            (MessageRole::Assistant, "first"),
            (
                MessageRole::User,
                "[system] All tracked background sub-agents have finished.",
            ),
            (MessageRole::Assistant, "[Thinking] secret"),
            (MessageRole::System, "tool"),
            (MessageRole::Assistant, "second"),
            (MessageRole::User, ""),
        ]);
        let mut model = OutlineModel::default();
        assert!(model.sync(&store));
        assert_eq!(model.turns.len(), 2);
        assert_eq!(model.turns[0].answers.len(), 2);
        assert!(model.turns[1].label.contains("Attachment task"));
        assert!(!model.rows.iter().any(|row| row.label.contains("secret")));
    }

    #[test]
    fn search_keeps_ancestors_and_duplicate_heading_positions() {
        let store = store(&[
            (MessageRole::User, "task"),
            (MessageRole::Assistant, "body"),
        ]);
        let meta = store.identity(1).unwrap();
        let mut model = OutlineModel::default();
        model.sync(&store);
        model.set_headings(
            meta.id,
            meta.revision,
            vec![
                OutlineHeading {
                    level: 1,
                    source_byte: 0,
                    title: "结果ABC".to_string(),
                },
                OutlineHeading {
                    level: 2,
                    source_byte: 3,
                    title: "结果ABC".to_string(),
                },
            ],
        );
        model.set_query("结果abc");
        assert_eq!(model.rows.len(), 4);
        assert_ne!(model.rows[2].key, model.rows[3].key);
    }

    #[test]
    fn unchanged_sync_is_constant_work_and_append_keeps_identity() {
        let mut store = store(&[(MessageRole::User, "first")]);
        let mut model = OutlineModel::default();
        model.sync(&store);
        let selected = model.selected;
        let version = model.view_revision();
        model.sync(&store);
        assert_eq!(model.view_revision(), version);
        store.push(DisplayMessage {
            role: MessageRole::Assistant,
            text: "answer".to_string(),
        });
        model.sync(&store);
        assert_eq!(model.selected, selected);
        assert_eq!(model.turns.len(), 1);
    }

    #[test]
    fn initial_index_yields_and_clear_invalidates_old_targets() {
        let mut store: TranscriptStore = (0..1000)
            .map(|_| DisplayMessage {
                role: MessageRole::User,
                text: "task".to_string(),
            })
            .collect();
        let mut model = OutlineModel::default();
        assert!(!model.sync(&store));
        assert_eq!(model.indexed, INDEX_BATCH);
        while !model.sync(&store) {}
        let old = model.latest_turn().unwrap();
        store.clear();
        model.sync(&store);
        assert!(model.visible_rows().is_empty());
        assert!(model.answer_start_for(old).is_none());
    }

    #[test]
    fn opening_latest_while_indexing_selects_latest_after_remaining_batches() {
        let store: TranscriptStore = (0..1000)
            .map(|index| DisplayMessage {
                role: MessageRole::User,
                text: format!("task-{index}"),
            })
            .collect();
        let mut model = OutlineModel::default();
        assert!(!model.sync(&store));
        model.open_at(None);
        while !model.sync(&store) {}
        assert_eq!(
            model.selected_anchor().unwrap().entry,
            store.identity(999).unwrap().id
        );
    }

    #[test]
    fn revision_update_preserves_open_turn_and_retries_only_new_revision() {
        let mut store = store(&[
            (MessageRole::User, "task"),
            (MessageRole::Assistant, "body"),
        ]);
        let mut model = OutlineModel::default();
        model.sync(&store);
        model.open_at(None);
        let (entry, revision, _) = model.next_missing_headings(&store).unwrap();
        model.mark_headings_unavailable(entry, revision);
        assert!(model.next_missing_headings(&store).is_none());
        assert!(!model.has_pending_work());
        store.append_to_last_assistant(" updated");
        model.sync(&store);
        assert!(
            model
                .visible_rows()
                .iter()
                .any(|row| row.kind == OutlineKind::Answer)
        );
        assert_eq!(model.next_missing_headings(&store).unwrap().1, revision + 1);
    }

    #[test]
    fn heading_depth_is_collapsed_until_expanded_and_selection_is_stable() {
        let store = store(&[
            (MessageRole::User, "task"),
            (MessageRole::Assistant, "body"),
        ]);
        let mut model = OutlineModel::default();
        model.sync(&store);
        model.open_at(None);
        let selected = model.selected_key();
        let meta = store.identity(1).unwrap();
        model.set_headings(
            meta.id,
            meta.revision,
            (1..=6)
                .map(|level| OutlineHeading {
                    level,
                    source_byte: level as usize,
                    title: format!("heading-{level}"),
                })
                .collect(),
        );
        assert_eq!(model.selected_key(), selected);
        assert_eq!(model.visible_rows().len(), 5);
        let h3 = model.visible_rows().last().unwrap().key;
        model.select_key(h3);
        model.expand_selected();
        assert_eq!(model.visible_rows().len(), 6);
        model.set_query("heading-6");
        assert_eq!(model.visible_rows().len(), 8);
    }

    #[test]
    fn navigation_uses_turns_instead_of_assistant_segments() {
        let store = store(&[
            (MessageRole::User, "first"),
            (MessageRole::Assistant, "one"),
            (MessageRole::Assistant, "two"),
            (MessageRole::User, "second"),
        ]);
        let mut model = OutlineModel::default();
        model.sync(&store);
        let last = model.latest_turn().unwrap();
        let first = model.previous_turn(last).unwrap();
        assert_eq!(model.next_turn(first), Some(last));
        assert_eq!(
            model.answer_start_for(first).unwrap().entry,
            store.identity(1).unwrap().id
        );
        assert_eq!(model.answer_start_for(last), Some(last));
    }

    #[test]
    fn streaming_turn_defers_headings_until_completion_without_revision_change() {
        let store = store(&[
            (MessageRole::User, "task"),
            (MessageRole::Assistant, "body"),
        ]);
        let mut model = OutlineModel::default();
        model.sync(&store);
        model.open_at(None);
        model.set_streaming_turn(model.latest_turn());
        assert!(model.next_missing_headings(&store).is_none());
        assert!(!model.has_pending_work());
        assert!(model.visible_rows()[0].label.contains("streaming"));
        model.set_streaming_turn(None);
        assert!(model.next_missing_headings(&store).is_some());
    }

    #[test]
    fn ten_thousand_message_index_reports_batched_and_hot_path_cost() {
        let store: TranscriptStore = (0..10_000)
            .map(|index| DisplayMessage {
                role: if index % 2 == 0 {
                    MessageRole::User
                } else {
                    MessageRole::Assistant
                },
                text: format!("合成性能样例-{index}"),
            })
            .collect();
        let mut model = OutlineModel::default();
        let started = std::time::Instant::now();
        let mut ticks = Vec::new();
        loop {
            let tick = std::time::Instant::now();
            let complete = model.sync(&store);
            ticks.push(tick.elapsed());
            if complete {
                break;
            }
        }
        let initial = started.elapsed();
        let version = model.view_revision();
        let hot = std::time::Instant::now();
        for _ in 0..10_000 {
            std::hint::black_box(model.sync(&store));
        }
        let hot = hot.elapsed();
        assert_eq!(model.view_revision(), version);
        assert_eq!(ticks.len(), 10_000usize.div_ceil(INDEX_BATCH));
        ticks.sort();
        eprintln!(
            "outline debug 10000 messages: initial={initial:?}, tick_p95={:?}, hot_10000_calls={hot:?}",
            ticks[ticks.len() * 95 / 100]
        );
    }
}
