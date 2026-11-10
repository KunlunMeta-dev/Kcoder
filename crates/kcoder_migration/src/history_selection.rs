//! Source branch reconstruction creates read-only references, never resumed messages.
use anyhow::{Context, Result, ensure};
use kcoder_state::external_history::{
    ExternalHistoryReader, projection::HistoricalProjectionStore,
};
use kcoder_types::{
    external_history::EXTERNAL_HISTORY_MAX_RECORDS,
    historical_tool_links::HistoricalToolLinkProgress, imported_transcript::HistoricalRecordData,
    migration::MigrationSourceKind,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChainEnd {
    Root,
    MissingParent,
    Cycle,
}

#[derive(Clone, Copy)]
struct Memo {
    nearest: Option<u64>,
    end: ChainEnd,
}

pub struct ClaudeHistorySelection {
    normalization_revision: String,
    source_fingerprint: String,
    selection_sha256: String,
    records: Vec<u64>,
    leaf: Option<u64>,
    complete_path: bool,
    incomplete_source_nodes: u64,
    selected_records_with_diagnostics: u64,
    source_records_with_diagnostics: u64,
}

impl ClaudeHistorySelection {
    pub fn records(&self) -> &[u64] {
        &self.records
    }
    pub fn leaf(&self) -> Option<u64> {
        self.leaf
    }
    pub fn complete_path(&self) -> bool {
        self.complete_path
    }
    pub fn incomplete_source_nodes(&self) -> u64 {
        self.incomplete_source_nodes
    }
    pub fn selected_records_with_diagnostics(&self) -> u64 {
        self.selected_records_with_diagnostics
    }
    pub fn source_records_with_diagnostics(&self) -> u64 {
        self.source_records_with_diagnostics
    }
    pub fn selection_sha256(&self) -> &str {
        &self.selection_sha256
    }
}

fn walk(
    index: &HistoricalProjectionStore,
    start: u64,
    memo: &mut HashMap<u64, Memo>,
    checked: &mut u64,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<Memo> {
    let mut current = Some(index.record(start)?);
    let mut path = Vec::new();
    let mut seen = HashSet::new();
    let mut first_message = None;
    let mut tail;
    loop {
        ensure!(check(*checked), "history_selection_cancelled");
        let record = current.take().context("history_selection_missing_node")?;
        if let Some(cached) = memo.get(&record.record) {
            tail = *cached;
            break;
        }
        if !seen.insert(record.record) {
            tail = Memo {
                nearest: None,
                end: ChainEnd::Cycle,
            };
            break;
        }
        ensure!(
            (path.len() as u64) < EXTERNAL_HISTORY_MAX_RECORDS,
            "history_selection_node_budget_exceeded"
        );
        let message = matches!(record.data, HistoricalRecordData::Message { .. });
        if message && first_message.is_none() {
            first_message = Some(record.record);
        }
        path.push((record.record, message));
        *checked += 1;
        match record.parent_id.as_deref() {
            None => {
                tail = Memo {
                    nearest: None,
                    end: ChainEnd::Root,
                };
                break;
            }
            Some("") => {
                tail = Memo {
                    nearest: None,
                    end: ChainEnd::MissingParent,
                };
                break;
            }
            Some(parent) => match index.canonical_source_record(parent)? {
                Some(record) => current = Some(record),
                None => {
                    tail = Memo {
                        nearest: None,
                        end: ChainEnd::MissingParent,
                    };
                    break;
                }
            },
        }
    }
    let result = Memo {
        nearest: first_message.or(tail.nearest),
        end: tail.end,
    };
    for (ordinal, message) in path.into_iter().rev() {
        if message {
            tail.nearest = Some(ordinal);
        }
        memo.insert(ordinal, tail);
    }
    Ok(result)
}

/// UUID identity follows the final stored record. Message IDs and logical compaction
/// parents never replace that identity or splice an earlier branch into the active chain.
pub fn select_claude_history(
    index: &HistoricalProjectionStore,
    mut check: impl FnMut(u64) -> bool,
) -> Result<ClaudeHistorySelection> {
    ensure!(
        index.source_kind() == MigrationSourceKind::ClaudeCode,
        "history_selection_source_mismatch"
    );
    let source_progress = index.progress()?;
    ensure!(
        source_progress.normalization_complete,
        "history_selection_normalization_incomplete"
    );
    let mut memo = HashMap::new();
    let mut checked = 0;
    let mut main = None::<u64>;
    let mut fallback = None::<u64>;
    let mut cursor = 0;
    loop {
        ensure!(check(checked), "history_selection_cancelled");
        let page = index.source_nodes(cursor, 10, true)?;
        for terminal in page.nodes {
            let found = walk(index, terminal.record, &mut memo, &mut checked, &mut check)?;
            if let Some(leaf) = found.nearest {
                let record = index.record(leaf)?;
                if fallback.is_none_or(|previous| leaf > previous) {
                    fallback = Some(leaf);
                }
                if !record.hidden
                    && !record.sidechain
                    && main.is_none_or(|previous| leaf > previous)
                {
                    main = Some(leaf);
                }
            }
        }
        let Some(next) = page.next_cursor else {
            break;
        };
        cursor = next;
    }
    // Components containing cycles may have no terminal. Inspect canonical nodes as
    // well, so a newer broken main chain cannot silently fall back to an older one.
    cursor = 0;
    loop {
        ensure!(check(checked), "history_selection_cancelled");
        let page = index.source_nodes(cursor, 10, false)?;
        for node in page.nodes {
            let found = walk(index, node.record, &mut memo, &mut checked, &mut check)?;
            if node.is_message && found.end != ChainEnd::Root {
                if fallback.is_none_or(|previous| node.record > previous) {
                    fallback = Some(node.record);
                }
                if !node.hidden
                    && !node.sidechain
                    && main.is_none_or(|previous| node.record > previous)
                {
                    main = Some(node.record);
                }
            }
        }
        let Some(next) = page.next_cursor else {
            break;
        };
        cursor = next;
    }
    let leaf = main.or(fallback);
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    let mut current = leaf.map(|id| index.record(id)).transpose()?;
    let mut selected_records_with_diagnostics = 0;
    let complete_path = leaf.is_some_and(|id| memo[&id].end == ChainEnd::Root);
    while let Some(record) = current.take() {
        ensure!(check(checked), "history_selection_cancelled");
        checked += 1;
        if !seen.insert(record.record) {
            break;
        }
        if !record.diagnostics.is_empty() {
            selected_records_with_diagnostics += 1;
        }
        records.push(record.record);
        current = match record.parent_id.as_deref() {
            Some(parent) if !parent.is_empty() => index.canonical_source_record(parent)?,
            _ => None,
        };
    }
    records.reverse();
    let source_fingerprint = index.source_fingerprint();
    let recipe = serde_json::to_vec(&(
        "claude-parent-chain/v1",
        &source_fingerprint,
        leaf,
        &records,
        complete_path,
    ))?;
    let selection_sha256 = format!("{:x}", Sha256::digest(recipe));
    Ok(ClaudeHistorySelection {
        normalization_revision: index.adapter_revision().into(),
        source_fingerprint,
        selection_sha256,
        records,
        leaf,
        complete_path,
        incomplete_source_nodes: memo
            .values()
            .filter(|value| value.end != ChainEnd::Root)
            .count() as u64,
        selected_records_with_diagnostics,
        source_records_with_diagnostics: source_progress.records_with_diagnostics,
    })
}

/// A lost receipt resumes correlation from its durable cursor. The branch is re-derived
/// read-only from the immutable normalized source before accepting the same selection ID.
pub fn link_selected_claude_tools(
    archive: &ExternalHistoryReader,
    selection: &ClaudeHistorySelection,
    mut check: impl FnMut(u64) -> bool,
) -> Result<HistoricalToolLinkProgress> {
    let index = archive
        .projection(&selection.normalization_revision, false)?
        .context("history_selection_normalized_source_missing")?;
    ensure!(
        index.source_fingerprint() == selection.source_fingerprint,
        "history_selection_source_changed"
    );
    drop(index);
    let mut links = archive
        .tool_links(
            &selection.normalization_revision,
            selection.selection_sha256(),
            true,
        )?
        .context("history_selection_tool_links_missing")?;
    let mut progress = links.progress()?;
    ensure!(
        progress.processed_records <= selection.records.len() as u64,
        "history_selection_cursor_conflict"
    );
    for ordinal in selection
        .records
        .iter()
        .skip(progress.processed_records as usize)
    {
        ensure!(
            check(progress.processed_records),
            "history_selection_cancelled"
        );
        progress = links.append(progress.processed_records, *ordinal)?;
    }
    let progress = links.seal(selection.records.len() as u64)?;
    links.seal_for_collection(|| check(progress.processed_records))?;
    Ok(progress)
}
