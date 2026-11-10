//! Explicit, bounded metadata indexing before any page has been displayed.
use super::*;
use std::collections::BTreeSet;

mod header;
const INPUT_BUDGET: u64 = 64 * 1024 * 1024;
#[derive(Default)]
pub(super) struct Index {
    headers: BTreeMap<String, header::Header>,
    unresolved: BTreeSet<String>,
}
#[derive(Default)]
struct Relation {
    observed: Option<Option<String>>,
    unknown: bool,
    conflict: bool,
}
#[derive(Clone)]
struct Root {
    key: String,
    depth: usize,
}
impl Index {
    pub(super) fn build(
        catalog: &mut HistoryCatalog,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<Self> {
        let mut index = Self::default();
        let mut remaining = INPUT_BUDGET;
        let mut budget_exhausted = false;
        let mut relations: BTreeMap<String, Relation> = BTreeMap::new();
        for (position, entry) in catalog.entries.iter_mut().enumerate() {
            ensure!(check(position as u64), "history_discovery_cancelled");
            let relation = relations
                .entry(entry.summary.source_session_id.clone())
                .or_default();
            let mut cancelled = false;
            if remaining == 0 {
                budget_exhausted = true;
                relation.unknown = true;
                continue;
            }
            let read = header::read(
                &entry.selected,
                &entry.summary.source_session_id,
                &mut remaining,
                &mut || {
                    let current = check(position as u64);
                    cancelled |= !current;
                    current
                },
            );
            ensure!(!cancelled, "history_discovery_cancelled");
            match read {
                Ok(record) => {
                    if let Some(parent) = record.parent.clone() {
                        entry.summary.parent_session_id = parent.clone();
                        if relation.observed.as_ref().is_some_and(|old| old != &parent) {
                            relation.conflict = true;
                        }
                        relation.observed = Some(parent);
                    } else {
                        relation.unknown = true;
                    }
                    index
                        .headers
                        .insert(entry.summary.source_handle.clone(), record);
                }
                Err(_) => {
                    relation.unknown = true;
                    budget_exhausted |= remaining == 0;
                }
            }
        }
        if budget_exhausted {
            catalog
                .problems
                .insert("history_discovery_family_budget_exceeded".into(), 1);
        }
        let mut parents = BTreeMap::new();
        for (id, relation) in &relations {
            if relation.unknown || relation.conflict {
                index.unresolved.insert(id.clone());
            }
            if relation.unknown {
                *catalog
                    .problems
                    .entry("history_discovery_family_metadata_incomplete".into())
                    .or_default() += 1;
            }
            if relation.conflict {
                *catalog
                    .problems
                    .entry("history_discovery_family_parent_conflict".into())
                    .or_default() += 1;
            }
            parents.insert(
                id.clone(),
                if relation.unknown || relation.conflict {
                    None
                } else {
                    relation.observed.clone().flatten()
                },
            );
        }
        let missing: BTreeSet<_> = parents
            .values()
            .flatten()
            .filter(|id| !parents.contains_key(*id))
            .collect();
        if !missing.is_empty() {
            catalog.problems.insert(
                "history_discovery_family_parent_missing".into(),
                missing.len() as u64,
            );
        }
        let mut resolved = BTreeMap::new();
        let mut cycles = BTreeSet::new();
        for id in parents.keys() {
            resolve(id, &parents, &mut resolved, &mut cycles);
        }
        index.unresolved.extend(cycles.iter().cloned());
        if !cycles.is_empty() {
            catalog
                .problems
                .insert("history_discovery_family_cycle".into(), cycles.len() as u64);
        }
        let mut groups: Vec<Vec<Entry>> = Vec::new();
        let mut positions = BTreeMap::new();
        // The existing order ranks components by their newest physical member.
        for mut entry in std::mem::take(&mut catalog.entries) {
            let id = &entry.summary.source_session_id;
            let relation = &relations[id];
            if index.unresolved.contains(id) {
                entry.summary.parent_session_id = None;
            }
            entry.summary.preview_incomplete |=
                relation.unknown || relation.conflict || cycles.contains(id);
            let slot = *positions
                .entry(resolved[id].key.clone())
                .or_insert_with(|| {
                    groups.push(Vec::new());
                    groups.len() - 1
                });
            groups[slot].push(entry);
        }
        for mut group in groups {
            // Equal depths keep physical variants and siblings in their original stable order.
            group.sort_by_key(|entry| resolved[&entry.summary.source_session_id].depth);
            catalog.entries.extend(group);
        }
        let cost: usize = index
            .headers
            .iter()
            .map(|(key, value)| {
                key.len()
                    + 32
                    + 96
                    + value
                        .parent
                        .as_ref()
                        .and_then(Option::as_ref)
                        .map_or(0, String::len)
            })
            .sum::<usize>()
            + index.unresolved.len() * 84;
        ensure!(
            catalog.cost + cost <= MAX_METADATA_BYTES,
            "history_discovery_budget_exceeded"
        );
        catalog.cost += cost;
        Ok(index)
    }
    pub(super) fn parent(&self, entry: &Entry) -> Option<String> {
        if self.unresolved.contains(&entry.summary.source_session_id) {
            return None;
        }
        self.headers
            .get(&entry.summary.source_handle)
            .and_then(|header| header.parent.clone())
            .flatten()
    }
    pub(super) fn verify(&self, entry: &Entry, check: &mut impl FnMut() -> bool) -> Result<()> {
        if let Some(expected) = self.headers.get(&entry.summary.source_handle) {
            let mut budget = INPUT_BUDGET;
            let record = header::read(
                &entry.selected,
                &entry.summary.source_session_id,
                &mut budget,
                check,
            )?;
            ensure!(
                record.digest == expected.digest,
                "history_discovery_family_metadata_changed"
            );
        }
        Ok(())
    }
}
fn resolve(
    start: &str,
    parents: &BTreeMap<String, Option<String>>,
    resolved: &mut BTreeMap<String, Root>,
    cycles: &mut BTreeSet<String>,
) {
    if resolved.contains_key(start) {
        return;
    }
    let mut path = Vec::<String>::new();
    let mut positions = BTreeMap::new();
    let mut cursor = start.to_owned();
    let mut root = loop {
        if let Some(root) = resolved.get(&cursor) {
            break root.clone();
        }
        if let Some(&position) = positions.get(&cursor) {
            let key = format!("cycle:{}", path[position..].iter().min().unwrap());
            let root = Root { key, depth: 0 };
            for id in &path[position..] {
                cycles.insert(id.clone());
                resolved.insert(id.clone(), root.clone());
            }
            path.truncate(position);
            break root;
        }
        positions.insert(cursor.clone(), path.len());
        match parents.get(&cursor) {
            None => {
                break Root {
                    key: format!("missing:{cursor}"),
                    depth: 0,
                };
            }
            Some(None) => {
                let root = Root {
                    key: cursor.clone(),
                    depth: 0,
                };
                resolved.insert(cursor, root.clone());
                break root;
            }
            Some(Some(parent)) => {
                path.push(cursor);
                cursor = parent.clone();
            }
        }
    };
    for id in path.into_iter().rev() {
        root.depth += 1;
        resolved.insert(id, root.clone());
    }
}
