use ratatui::text::Line;
use std::collections::HashMap;

type RenderLineCacheKey = (usize, u16, Option<ToolRailPos>, bool, bool);

/// Position of a committed tool message within an adjacent group.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ToolRailPos {
    /// Standalone tool message: no rail connector.
    Single,
    /// First message in a group.
    Top,
    /// Middle message in a group.
    Middle,
    /// Last message in a group.
    Bottom,
}

/// Cached rendered lines for committed transcript messages. Since messages are
/// immutable once committed, we can reuse their wrapped/rendered output across
/// frames and only re-render the active tail and any context-affected cells.
///
/// Each cache entry is keyed by `(message_index, width)` plus the rail,
/// "is last tool", and assistant-continuation flags. Width is the exact
/// terminal width the lines were wrapped for: a bucketed width let a
/// same-bucket resize reuse lines wrapped for a different width and re-wrap
/// them into garbled breaks. Entries are bounded by
/// [`RenderCache::MAX_ENTRIES`] so a long transcript does not grow the cache
/// without bound. Entries larger than [`RenderCache::MAX_LINES_PER_ENTRY`]
/// are deliberately not cached: re-wrapping a small message is cheap, but a
/// pathological 10k-line cache value would balloon memory and slow down
/// `clone()` on every frame.
#[derive(Debug)]
pub(crate) struct RenderCache {
    width: u16,
    transcript_epoch: u64,
    render_markdown: bool,
    code_theme: String,
    last_tool_expanded: bool,
    lines: HashMap<RenderLineCacheKey, Vec<Line<'static>>>,
    /// Insertion order for LRU-ish eviction. Updated on every `insert`.
    order: Vec<(usize, u16, Option<ToolRailPos>, bool, bool)>,
}

/// Content-addressed cache for the live transcript render plan.
///
/// Unlike [`RenderCache`], this cache is not keyed by committed message index.
/// The fullscreen tail may contain a temporary mixture of committed messages,
/// active-turn messages, and synthetic collapsed tool summaries. Stable blocks
/// keep the same fingerprint while the final streaming block changes, matching
/// keyed message/part ownership used by the transcript scroll box.
#[derive(Debug, Default)]
pub(crate) struct KeyedTranscriptBlockRenderCache {
    lines: HashMap<u64, Vec<Line<'static>>>,
    order: Vec<u64>,
    hit_count: usize,
}

impl KeyedTranscriptBlockRenderCache {
    const MAX_ENTRIES: usize = 1024;
    const MAX_LINES_PER_ENTRY: usize = 2000;

    pub(crate) fn get(&mut self, key: u64) -> Option<Vec<Line<'static>>> {
        let lines = self.lines.get(&key)?.clone();
        self.hit_count = self.hit_count.saturating_add(1);
        Some(lines)
    }

    pub(crate) fn insert(&mut self, key: u64, lines: Vec<Line<'static>>) {
        if lines.len() > Self::MAX_LINES_PER_ENTRY {
            return;
        }
        if self.lines.insert(key, lines).is_none() {
            self.order.push(key);
        } else if let Some(pos) = self.order.iter().position(|existing| *existing == key) {
            self.order.remove(pos);
            self.order.push(key);
        }
        while self.lines.len() > Self::MAX_ENTRIES {
            let Some(oldest) = self.order.first().copied() else {
                break;
            };
            self.order.remove(0);
            self.lines.remove(&oldest);
        }
    }

    pub(crate) fn clear(&mut self) {
        self.lines.clear();
        self.order.clear();
        self.hit_count = 0;
    }

    #[cfg(test)]
    pub(crate) fn hit_count(&self) -> usize {
        self.hit_count
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lines.len()
    }
}

impl RenderCache {
    /// Hard cap on cache size. 512 entries is enough for hundreds of messages
    /// at typical widths without leaking memory on very long sessions.
    const MAX_ENTRIES: usize = 512;
    /// Entries with more lines than this are not cached.
    const MAX_LINES_PER_ENTRY: usize = 2000;

    pub(crate) fn new() -> Self {
        Self {
            width: 0,
            transcript_epoch: 0,
            render_markdown: false,
            code_theme: String::new(),
            last_tool_expanded: false,
            lines: HashMap::new(),
            order: Vec::new(),
        }
    }

    pub(crate) fn clear(&mut self) {
        self.lines.clear();
        self.order.clear();
    }

    /// Clear the cache when a global rendering option changes in a way that
    /// invalidates every entry (markdown toggle, theme switch, last-tool
    /// expand state). Width changes drop stale-width entries only; entries
    /// are keyed by the *exact* width they were wrapped for, because
    /// bucketed widths made a same-bucket resize reuse lines wrapped for a
    /// different width and then re-wrap them into garbled breaks.
    pub(crate) fn invalidate_if_stale(
        &mut self,
        width: u16,
        transcript_epoch: u64,
        render_markdown: bool,
        code_theme: &str,
        last_tool_expanded: bool,
    ) {
        let needs_full_clear = self.transcript_epoch != transcript_epoch
            || self.render_markdown != render_markdown
            || self.code_theme != code_theme
            || self.last_tool_expanded != last_tool_expanded;
        if needs_full_clear {
            self.width = width;
            self.transcript_epoch = transcript_epoch;
            self.render_markdown = render_markdown;
            self.code_theme = code_theme.to_string();
            self.last_tool_expanded = last_tool_expanded;
            self.lines.clear();
            self.order.clear();
        } else if self.width != width {
            // Width moved: only drop width-mismatched entries. Entries at the
            // new width are untouched, and any still-valid entries at other
            // widths stay out of the way until eviction.
            self.width = width;
            self.lines.retain(|key, _| key.1 == width);
            self.order.retain(|key| key.1 == width);
        }
    }

    pub(crate) fn get(
        &self,
        index: usize,
        rail: Option<ToolRailPos>,
        is_last_tool: bool,
        assistant_continuation: bool,
    ) -> Option<&Vec<Line<'static>>> {
        self.lines.get(&(
            index,
            self.width,
            rail,
            is_last_tool,
            assistant_continuation,
        ))
    }

    pub(crate) fn insert(
        &mut self,
        index: usize,
        rail: Option<ToolRailPos>,
        is_last_tool: bool,
        assistant_continuation: bool,
        lines: Vec<Line<'static>>,
    ) {
        // Don't cache oversized entries; they cost more to clone than to
        // re-render.
        if lines.len() > Self::MAX_LINES_PER_ENTRY {
            return;
        }
        let key = (
            index,
            self.width,
            rail,
            is_last_tool,
            assistant_continuation,
        );
        if self.lines.insert(key, lines).is_none() {
            self.order.push(key);
        } else {
            if let Some(pos) = self.order.iter().position(|k| *k == key) {
                self.order.remove(pos);
            }
            self.order.push(key);
        }
        // Evict the oldest entries if we exceeded the cap. Drop a chunk to
        // amortize the cost.
        while self.lines.len() > Self::MAX_ENTRIES {
            if let Some(oldest) = self.order.first().cloned() {
                self.lines.remove(&oldest);
                self.order.remove(0);
            } else {
                break;
            }
        }
    }
}
