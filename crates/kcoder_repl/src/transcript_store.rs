use crate::history_cell::{HistoryCell, HistoryCellKind, history_cell_from_display_message};
use crate::transcript_identity::{EntryId, EntryMetadata, TranscriptAnchor};
use kcoder_types::{DisplayMessage, MessageRole};
use std::collections::HashMap;
use std::ops::Deref;
#[cfg(test)]
use std::ops::Range;
use std::sync::Arc;

/// Authoritative committed transcript source.
///
/// Rendering, scrollback insertion, and search are derived from this store.
/// Content/order mutations advance a render epoch so index-based render caches
/// cannot outlive changed message content or shifted indexes. Pure appends keep
/// the epoch stable because existing cache entries remain valid.
#[derive(Debug, Clone, Default)]
pub struct TranscriptStore {
    cells: Vec<Arc<dyn HistoryCell>>,
    messages: Vec<DisplayMessage>,
    metadata: Vec<EntryMetadata>,
    redirects: HashMap<EntryId, TranscriptAnchor>,
    render_epoch: u64,
}

impl TranscriptStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn render_epoch(&self) -> u64 {
        self.render_epoch
    }

    pub(crate) fn identity(&self, index: usize) -> Option<EntryMetadata> {
        self.metadata.get(index).copied()
    }

    /// Complete sub-agent snapshots usually append or extend only the tail; preserve identities in the known-stable prefix.
    pub(crate) fn reconcile_projection(&mut self, updated: &[DisplayMessage]) {
        let common = self
            .messages
            .iter()
            .zip(updated)
            .take_while(|(a, b)| a.role == b.role && a.text == b.text)
            .count();
        let mut next = common;
        if let (Some(old), Some(new)) = (self.messages.get(common), updated.get(common))
            && old.role == new.role
            && new.text.starts_with(&old.text)
        {
            self.cells[common] = Arc::from(history_cell_from_display_message(new.clone()));
            self.messages[common] = new.clone();
            self.metadata[common].revision += 1;
            self.bump_render_epoch();
            next += 1;
        }
        self.truncate(next);
        for message in &updated[next..] {
            self.push(message.clone());
        }
    }

    pub(crate) fn resolve_anchor(&self, mut anchor: TranscriptAnchor) -> Option<(usize, usize)> {
        // Consolidation redirects form a directed acyclic chain; the limit also prevents corrupted state from looping forever.
        for _ in 0..=self.redirects.len() {
            if let Some(index) = self
                .metadata
                .iter()
                .position(|meta| meta.id == anchor.entry)
            {
                let text = &self.messages[index].text;
                return (anchor.source_byte <= text.len()
                    && text.is_char_boundary(anchor.source_byte))
                .then_some((index, anchor.source_byte));
            }
            let next = self.redirects.get(&anchor.entry)?;
            anchor = TranscriptAnchor {
                entry: next.entry,
                source_byte: next.source_byte.checked_add(anchor.source_byte)?,
            };
        }
        None
    }

    pub fn clear(&mut self) {
        if !self.cells.is_empty() {
            self.cells.clear();
            self.messages.clear();
            self.metadata.clear();
            self.redirects.clear();
            self.bump_render_epoch();
        }
    }

    pub fn push(&mut self, message: DisplayMessage) {
        self.push_cell(Arc::from(history_cell_from_display_message(message)));
    }

    pub fn retain(&mut self, mut keep: impl FnMut(&DisplayMessage) -> bool) {
        let before = self.cells.len();
        let keep_flags = self.messages.iter().map(&mut keep).collect::<Vec<_>>();
        let mut idx = 0usize;
        self.cells.retain(|_| {
            let should_keep = keep_flags[idx];
            idx += 1;
            should_keep
        });
        let mut index = 0;
        self.metadata.retain(|_| {
            let keep = keep_flags[index];
            index += 1;
            keep
        });
        if self.cells.len() != before {
            self.rebuild_projection();
            self.bump_render_epoch();
        }
    }

    pub fn truncate(&mut self, len: usize) {
        if len >= self.cells.len() {
            return;
        }
        self.cells.truncate(len);
        self.metadata.truncate(len);
        self.rebuild_projection();
        self.bump_render_epoch();
    }

    pub fn append_to_last_assistant(&mut self, text: &str) -> bool {
        let Some(last_cell) = self
            .cells
            .last()
            .filter(|cell| cell.kind() == HistoryCellKind::AgentMarkdown)
        else {
            return false;
        };
        let mut message = last_cell.display_message();
        message.text.push_str(text);
        let replacement = Arc::from(history_cell_from_display_message(message));
        if let Some(last) = self.cells.last_mut() {
            *last = replacement;
        }
        self.metadata.last_mut().unwrap().revision += 1;
        self.rebuild_projection();
        self.bump_render_epoch();
        true
    }

    pub(crate) fn replace_first(
        &mut self,
        mut predicate: impl FnMut(&DisplayMessage) -> bool,
        message: DisplayMessage,
    ) -> bool {
        let Some(index) = self.messages.iter().position(&mut predicate) else {
            return false;
        };
        self.cells[index] = Arc::from(history_cell_from_display_message(message));
        self.metadata[index].revision += 1;
        self.metadata[index].prefix_revision += 1;
        self.rebuild_projection();
        self.bump_render_epoch();
        true
    }

    #[cfg(test)]
    pub(crate) fn trailing_assistant_run_range(&self) -> Option<Range<usize>> {
        let end = self.cells.len();
        if end == 0 || self.cells[end - 1].kind() != HistoryCellKind::AgentMarkdown {
            return None;
        }

        let mut start = end - 1;
        while start > 0 && self.cells[start - 1].kind() == HistoryCellKind::AgentMarkdown {
            start -= 1;
        }

        (end.saturating_sub(start) > 1).then_some(start..end)
    }

    #[cfg(test)]
    pub(crate) fn consolidate_trailing_assistant_run(&mut self) -> Option<usize> {
        let range = self.trailing_assistant_run_range()?;
        self.consolidate_trailing_assistant_run_from(range.start)
    }

    pub(crate) fn consolidate_trailing_assistant_run_from(
        &mut self,
        start: usize,
    ) -> Option<usize> {
        let end = self.cells.len();
        if end.saturating_sub(start) <= 1 {
            return None;
        }
        if !self.cells[start..]
            .iter()
            .all(|cell| cell.kind() == HistoryCellKind::AgentMarkdown)
        {
            return None;
        }

        let range = start..end;
        let target = self.metadata[start].id;
        let mut offset = self.messages[start].text.len();
        for index in start + 1..end {
            self.redirects.insert(
                self.metadata[index].id,
                TranscriptAnchor {
                    entry: target,
                    source_byte: offset,
                },
            );
            offset += self.messages[index].text.len();
        }
        self.metadata[start].revision += 1;
        self.metadata.truncate(start + 1);
        let merged_text = self.cells[range.clone()]
            .iter()
            .map(|cell| cell.display_message().text)
            .collect::<String>();
        let replacement = Arc::from(history_cell_from_display_message(DisplayMessage {
            role: MessageRole::Assistant,
            text: merged_text,
        }));

        let start = range.start;
        self.cells.splice(range, std::iter::once(replacement));
        self.rebuild_projection();
        self.bump_render_epoch();
        Some(start)
    }

    #[cfg(test)]
    pub(crate) fn cell_kinds(&self) -> Vec<HistoryCellKind> {
        self.cells.iter().map(|cell| cell.kind()).collect()
    }

    fn push_cell(&mut self, cell: Arc<dyn HistoryCell>) {
        self.metadata.push(EntryMetadata::default());
        self.messages.push(cell.display_message());
        self.cells.push(cell);
    }

    fn rebuild_projection(&mut self) {
        self.messages = self
            .cells
            .iter()
            .map(|cell| cell.display_message())
            .collect();
    }

    fn bump_render_epoch(&mut self) {
        self.render_epoch = self.render_epoch.wrapping_add(1);
    }
}

impl Deref for TranscriptStore {
    type Target = [DisplayMessage];

    fn deref(&self) -> &Self::Target {
        &self.messages
    }
}

impl From<Vec<DisplayMessage>> for TranscriptStore {
    fn from(messages: Vec<DisplayMessage>) -> Self {
        let cells: Vec<Arc<dyn HistoryCell>> = messages
            .into_iter()
            .map(|message| Arc::from(history_cell_from_display_message(message)))
            .collect::<Vec<_>>();
        let messages: Vec<DisplayMessage> =
            cells.iter().map(|cell| cell.display_message()).collect();
        Self {
            render_epoch: if messages.is_empty() { 0 } else { 1 },
            metadata: (0..messages.len())
                .map(|_| EntryMetadata::default())
                .collect(),
            redirects: HashMap::new(),
            cells,
            messages,
        }
    }
}

impl FromIterator<DisplayMessage> for TranscriptStore {
    fn from_iter<T: IntoIterator<Item = DisplayMessage>>(iter: T) -> Self {
        Vec::from_iter(iter).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::MessageRole;

    #[test]
    fn navigation_identity_survives_append_and_merge_but_not_clear() {
        let mut store = TranscriptStore::new();
        store.push(message(MessageRole::User, "任务"));
        store.push(message(MessageRole::Assistant, "前文\n"));
        store.push(message(MessageRole::Assistant, "# 目标"));
        let first = store.identity(0).unwrap().id;
        let anchor = TranscriptAnchor {
            entry: store.identity(2).unwrap().id,
            source_byte: 2,
        };
        store.consolidate_trailing_assistant_run_from(1).unwrap();
        assert_eq!(store.identity(0).unwrap().id, first);
        assert_eq!(store.resolve_anchor(anchor), Some((1, "前文\n".len() + 2)));
        store.push(message(MessageRole::User, "后续"));
        assert_eq!(store.resolve_anchor(anchor), Some((1, "前文\n".len() + 2)));
        store.clear();
        store.push(message(MessageRole::Assistant, "# 目标"));
        assert_eq!(store.resolve_anchor(anchor), None);
    }

    #[test]
    fn navigation_identity_does_not_follow_shifted_indices() {
        let mut store: TranscriptStore = vec![
            message(MessageRole::User, "a"),
            message(MessageRole::Assistant, "b"),
        ]
        .into();
        let anchor = TranscriptAnchor {
            entry: store.identity(1).unwrap().id,
            source_byte: 0,
        };
        let clone = store.clone();
        store.retain(|message| message.role != MessageRole::User);
        assert_eq!(store.resolve_anchor(anchor), Some((0, 0)));
        assert_eq!(clone.resolve_anchor(anchor), Some((1, 0)));
        store.truncate(0);
        assert_eq!(store.resolve_anchor(anchor), None);
    }

    fn message(role: MessageRole, text: &str) -> DisplayMessage {
        DisplayMessage {
            role,
            text: text.to_string(),
        }
    }

    #[test]
    fn push_keeps_render_epoch_for_append_only_cache_stability() {
        let mut store = TranscriptStore::new();
        let start = store.render_epoch();

        store.push(message(MessageRole::User, "hello"));

        assert_eq!(store.render_epoch(), start);
        assert_eq!(store.len(), 1);
        assert_eq!(store.cell_kinds(), vec![HistoryCellKind::User]);
    }

    #[test]
    fn assistant_append_advances_render_epoch_and_updates_tail() {
        let mut store = TranscriptStore::new();
        store.push(message(MessageRole::Assistant, "hello "));
        let before = store.render_epoch();

        assert!(store.append_to_last_assistant("world"));

        assert!(store.render_epoch() > before);
        assert_eq!(store[0].text, "hello world");
        assert_eq!(store.cell_kinds(), vec![HistoryCellKind::AgentMarkdown]);
    }

    #[test]
    fn assistant_append_does_not_mutate_non_assistant_tail() {
        let mut store = TranscriptStore::new();
        store.push(message(MessageRole::User, "hello"));
        let before = store.render_epoch();

        assert!(!store.append_to_last_assistant(" world"));

        assert_eq!(store.render_epoch(), before);
        assert_eq!(store[0].text, "hello");
        assert_eq!(store.cell_kinds(), vec![HistoryCellKind::User]);
    }

    #[test]
    fn trailing_assistant_run_consolidates_only_adjacent_tail() {
        let mut store = TranscriptStore::new();
        store.push(message(MessageRole::User, "prompt"));
        store.push(message(MessageRole::Assistant, "one\n"));
        store.push(message(MessageRole::Assistant, "two\n"));
        store.push(message(MessageRole::Assistant, "three"));
        let before = store.render_epoch();

        assert_eq!(store.trailing_assistant_run_range(), Some(1..4));
        assert_eq!(store.consolidate_trailing_assistant_run(), Some(1));

        assert!(store.render_epoch() > before);
        assert_eq!(store.len(), 2);
        assert_eq!(store[1].role, MessageRole::Assistant);
        assert_eq!(store[1].text, "one\ntwo\nthree");
        assert_eq!(
            store.cell_kinds(),
            vec![HistoryCellKind::User, HistoryCellKind::AgentMarkdown]
        );
    }

    #[test]
    fn trailing_assistant_run_does_not_cross_non_assistant_tail() {
        let mut store = TranscriptStore::new();
        store.push(message(MessageRole::Assistant, "one"));
        store.push(message(MessageRole::System, "tool"));
        store.push(message(MessageRole::Assistant, "two"));
        let before = store.render_epoch();

        assert!(store.trailing_assistant_run_range().is_none());
        assert!(store.consolidate_trailing_assistant_run().is_none());

        assert_eq!(store.render_epoch(), before);
        assert_eq!(store.len(), 3);
    }

    #[test]
    fn trailing_assistant_run_from_consolidates_only_requested_stream_tail() {
        let mut store = TranscriptStore::new();
        store.push(message(MessageRole::Assistant, "previous"));
        store.push(message(MessageRole::Assistant, "one\n"));
        store.push(message(MessageRole::Assistant, "two"));

        assert_eq!(store.consolidate_trailing_assistant_run_from(1), Some(1));

        assert_eq!(store.len(), 2);
        assert_eq!(store[0].text, "previous");
        assert_eq!(store[1].text, "one\ntwo");
    }

    #[test]
    fn trailing_assistant_run_from_rejects_non_assistant_cells() {
        let mut store = TranscriptStore::new();
        store.push(message(MessageRole::Assistant, "one"));
        store.push(message(MessageRole::System, "tool"));
        store.push(message(MessageRole::Assistant, "two"));
        let before = store.render_epoch();

        assert!(store.consolidate_trailing_assistant_run_from(0).is_none());

        assert_eq!(store.render_epoch(), before);
        assert_eq!(store.len(), 3);
    }

    #[test]
    fn retain_advances_epoch_only_when_messages_are_removed() {
        let mut store = TranscriptStore::new();
        store.push(message(MessageRole::User, "keep"));
        store.push(message(MessageRole::System, "drop"));
        let before_remove = store.render_epoch();

        store.retain(|message| message.role == MessageRole::User);

        assert!(store.render_epoch() > before_remove);
        assert_eq!(store.len(), 1);
        assert_eq!(store.cell_kinds(), vec![HistoryCellKind::User]);
        let before_keep_all = store.render_epoch();

        store.retain(|_| true);

        assert_eq!(store.render_epoch(), before_keep_all);
    }

    #[test]
    fn truncate_advances_epoch_and_rebuilds_projection() {
        let mut store = TranscriptStore::new();
        store.push(message(MessageRole::User, "first"));
        store.push(message(MessageRole::Assistant, "second"));
        let before = store.render_epoch();

        store.truncate(1);

        assert!(store.render_epoch() > before);
        assert_eq!(store.len(), 1);
        assert_eq!(store[0].text, "first");
        assert_eq!(store.cell_kinds(), vec![HistoryCellKind::User]);
    }
}
