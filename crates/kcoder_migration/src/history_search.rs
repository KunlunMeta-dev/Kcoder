//! Incremental full-body search; each read has independent byte, record and CPU-step budgets.
use crate::{history_branches::HistoryBranchStore, history_display::HistoryArchiveView};
use anyhow::{Result, ensure};
use kcoder_types::historical_search::HistoricalSearchMatch;
use serde::{Deserialize, Serialize};

pub const SEARCH_READ_BYTES: u64 = 4 * 1024 * 1024;
pub const SEARCH_READ_RECORDS: usize = 32;
pub const SEARCH_READ_STEPS: usize = 256;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchTextRange {
    pub offset: u64,
    pub bytes: u64,
}
pub struct SearchPartRead {
    pub block: u32,
    pub range: SearchTextRange,
    pub offset: u64,
}
pub mod typed_parts;

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchPosition {
    pub position: u64,
    pub block: u32,
    pub offset: u64,
    pub previous_offset: Option<u64>,
    pub processed_bytes: u64,
    #[serde(default)]
    pub typed_cursor: Option<typed_parts::TypedPartsCursor>,
    #[serde(default)]
    pub typed_value: Option<kcoder_types::imported_transcript::HistoricalValueRef>,
    #[serde(default)]
    pub typed_done: bool,
    #[serde(default)]
    pub unsupported: u64,
    #[serde(default)]
    pub excluded: u64,
}

pub struct NativeSearchHit {
    pub found: HistoricalSearchMatch,
    pub body_start: u64,
    pub part: Option<SearchTextRange>,
}
pub struct NativeSearchPage {
    pub items: Vec<NativeSearchHit>,
    pub next: Option<SearchPosition>,
    pub scanned_records: u64,
    pub total_records: u64,
    pub processed_bytes: u64,
    pub unsupported: u64,
    pub excluded: u64,
}
pub struct SearchNeedle {
    normalized: String,
    case_sensitive: bool,
    folded_pattern: Option<regex::Regex>,
    pub(crate) overlap_chars: usize,
}
fn lower(text: &str) -> String {
    text.chars().flat_map(char::to_lowercase).collect()
}
impl SearchNeedle {
    pub fn new(query: &str, case_sensitive: bool) -> Result<Self> {
        ensure!(
            !query.trim().is_empty() && query.len() <= 1024 && query.chars().count() <= 256,
            "history_search_invalid_query"
        );
        let normalized = if case_sensitive {
            query.into()
        } else {
            lower(query)
        };
        let folded_pattern = (!case_sensitive)
            .then(|| {
                regex::RegexBuilder::new(&regex::escape(&normalized))
                    .case_insensitive(true)
                    .size_limit(1024 * 1024)
                    .build()
            })
            .transpose()
            .map_err(|_| anyhow::anyhow!("history_search_invalid_query"))?;
        Ok(Self {
            overlap_chars: normalized.chars().count(),
            normalized,
            case_sensitive,
            folded_pattern,
        })
    }
    pub(crate) fn find(&self, text: &str) -> Option<(usize, String, String, String)> {
        let normalized = if self.case_sensitive {
            text.into()
        } else {
            lower(text)
        };
        let (at, end) = if let Some(pattern) = &self.folded_pattern {
            let found = pattern.find(&normalized)?;
            (found.start(), found.end())
        } else {
            let at = normalized.find(&self.normalized)?;
            (at, at + self.normalized.len())
        };
        let (mut original_start, mut original_end, mut folded) = (None, text.len(), 0);
        for (offset, character) in text.char_indices() {
            let width = if self.case_sensitive {
                character.len_utf8()
            } else {
                character.to_lowercase().map(char::len_utf8).sum()
            };
            if original_start.is_none() && folded + width > at {
                original_start = Some(offset);
            }
            folded += width;
            if folded >= end {
                original_end = offset + character.len_utf8();
                break;
            }
        }
        let start = original_start?;
        let before: String = text[..start]
            .chars()
            .rev()
            .take(80)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let after: String = text[original_end..].chars().take(80).collect();
        Some((start, before, text[start..original_end].into(), after))
    }
}
pub(crate) struct SearchWork<'a> {
    pub cursor: SearchPosition,
    pub needle: &'a SearchNeedle,
    pub items: Vec<NativeSearchHit>,
    pub steps: usize,
    pub bytes: u64,
    pub limit: usize,
    pub paused: bool,
}
impl SearchWork<'_> {
    pub fn stopped(&self) -> bool {
        self.paused
            || self.items.len() >= self.limit
            || self.steps >= SEARCH_READ_STEPS
            || self.bytes >= SEARCH_READ_BYTES
    }
    pub fn charge(&mut self, bytes: u64) -> Result<()> {
        self.bytes += bytes;
        self.cursor.processed_bytes = self
            .cursor
            .processed_bytes
            .checked_add(bytes)
            .ok_or_else(|| anyhow::anyhow!("history_search_budget_exceeded"))?;
        Ok(())
    }
    pub fn next_block(&mut self) {
        self.cursor.block += 1;
        self.cursor.offset = 0;
        self.cursor.previous_offset = None;
        self.cursor.typed_cursor = None;
        self.cursor.typed_value = None;
        self.cursor.typed_done = false;
    }
}
pub enum HistorySearchSource<'a> {
    Archive(&'a HistoryArchiveView),
    Branch {
        store: &'a HistoryBranchStore,
        root_job: &'a str,
        view_id: &'a str,
    },
}
impl HistorySearchSource<'_> {
    pub fn snapshot(&self) -> Result<(String, u64)> {
        match self {
            Self::Archive(view) => view.search_snapshot(),
            Self::Branch {
                store,
                root_job,
                view_id,
            } => {
                let (snapshot, identity) = store.snapshot(root_job, view_id, 0)?;
                ensure!(
                    snapshot.progress.stage
                        == kcoder_types::historical_branch::HistoricalBranchStage::Ready,
                    "history_search_branch_not_ready"
                );
                Ok((identity, snapshot.progress.written_items))
            }
        }
    }
    pub fn page(
        &self,
        needle: &SearchNeedle,
        cursor: SearchPosition,
        limit: u8,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<NativeSearchPage> {
        ensure!((1..=10).contains(&limit), "history_search_invalid_limit");
        let (identity, total) = self.snapshot()?;
        ensure!(cursor.position <= total, "history_search_invalid_cursor");
        let mut work = SearchWork {
            cursor,
            needle,
            items: Vec::new(),
            steps: 0,
            bytes: 0,
            limit: limit as usize,
            paused: false,
        };
        let mut records = 0;
        while work.cursor.position < total && records < SEARCH_READ_RECORDS && !work.stopped() {
            ensure!(
                check(work.cursor.processed_bytes),
                "history_search_cancelled"
            );
            match self {
                Self::Archive(view) => view.scan_search_record(&mut work, &mut check)?,
                Self::Branch {
                    store,
                    root_job,
                    view_id,
                } => store.scan_search_record(root_job, view_id, &mut work, &mut check)?,
            }
            records += 1;
        }
        ensure!(
            self.snapshot()? == (identity, total),
            "history_search_source_changed"
        );
        Ok(NativeSearchPage {
            scanned_records: work.cursor.position,
            total_records: total,
            unsupported: work.cursor.unsupported,
            excluded: work.cursor.excluded,
            processed_bytes: work.cursor.processed_bytes,
            next: (work.cursor.position < total).then_some(work.cursor),
            items: work.items,
        })
    }
}
