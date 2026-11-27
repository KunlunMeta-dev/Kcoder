//! Keep known physical families adjacent before slicing ten-leaf pages.
use super::*;
use std::path::PathBuf;

pub(super) fn order(entries: &mut Vec<Entry>) {
    // Entries already have newest-first order. Rank a family by its newest leaf,
    // then put its main file before its agents without sampling extra source bodies.
    let mut groups: Vec<Vec<Entry>> = Vec::new();
    let mut positions = BTreeMap::new();
    for entry in std::mem::take(entries) {
        let project: PathBuf = if entry.summary.source == MigrationSourceKind::ClaudeCode {
            entry
                .selected
                .relative_path()
                .components()
                .take(2)
                .collect()
        } else {
            PathBuf::new()
        };
        let key = (project, entry.summary.source_session_id.clone());
        let index = *positions.entry(key).or_insert_with(|| {
            groups.push(Vec::new());
            groups.len() - 1
        });
        groups[index].push(entry);
    }
    for mut group in groups {
        // Stable sort preserves newest-first order among physical variants and agents.
        group.sort_by_key(|entry| entry.summary.agent_id.is_some());
        entries.extend(group);
    }
}
