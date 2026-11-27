//! Execution receipts follow only uniquely retained calls; discarded branches grant no facts.
use super::*;
use std::collections::BTreeMap;

type Location = (u32, u64, Option<u32>);
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Identity {
    call_id: String,
    turn_id: Option<String>,
}
#[derive(Default)]
pub(super) struct Scope {
    calls: BTreeMap<Identity, Vec<Location>>,
    events: BTreeMap<Location, Identity>,
}
fn location(value: &HistoricalCodexItemRef) -> Location {
    (value.source_index, value.record, value.replacement_index)
}
fn charge(charged: &mut usize, bytes: usize) -> Result<()> {
    *charged = charged.saturating_add(bytes);
    ensure!(
        *charged <= SELECTION_MEMORY_BYTES,
        "history_selection_memory_budget_exceeded"
    );
    Ok(())
}
impl Scope {
    pub fn capture(
        &mut self,
        item: &Item,
        data: &HistoricalRecordData,
        charged: &mut usize,
    ) -> Result<()> {
        let identity = |call_id: &str| Identity {
            call_id: call_id.into(),
            turn_id: item
                .metadata
                .turn_id
                .clone()
                .filter(|turn| !turn.is_empty()),
        };
        match data {
            HistoricalRecordData::Message { blocks, .. } => {
                for block in blocks {
                    if let HistoricalBlock::ToolCall { call_id, .. } = block {
                        let key = identity(call_id);
                        charge(
                            charged,
                            160 + key.call_id.len() + key.turn_id.as_ref().map_or(0, String::len),
                        )?;
                        self.calls
                            .entry(key)
                            .or_default()
                            .push(location(&item.location));
                    }
                }
            }
            HistoricalRecordData::Event {
                source_type,
                call_id: Some(call_id),
                outcome: Some(_),
                ..
            } if matches!(source_type.as_str(), "exec_command_end" | "patch_apply_end") => {
                let key = identity(call_id);
                charge(
                    charged,
                    160 + key.call_id.len() + key.turn_id.as_ref().map_or(0, String::len),
                )?;
                self.events.insert(location(&item.location), key);
            }
            _ => {}
        }
        Ok(())
    }
    pub fn selected(
        self,
        mut items: Vec<Item>,
        issues: &mut BTreeSet<String>,
        mut charged: usize,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<Vec<Item>> {
        if self.events.is_empty() {
            return Ok(items);
        }
        charge(&mut charged, items.len().saturating_mul(128))?;
        let selected = items
            .iter()
            .map(|item| location(&item.location))
            .collect::<BTreeSet<_>>();
        let mut counts = BTreeMap::new();
        for (identity, locations) in &self.calls {
            charge(&mut charged, 64)?;
            let mut count = 0usize;
            for &(source, record, replacement) in locations {
                ensure!(check(record), "history_selection_cancelled");
                if selected.contains(&(source, record, replacement)) {
                    count = count.saturating_add(1);
                }
            }
            counts.insert(identity, (count, locations.len()));
        }
        let mut keep = BTreeSet::new();
        for item in &items {
            ensure!(check(item.location.record), "history_selection_cancelled");
            let at = location(&item.location);
            let Some(identity) = self.events.get(&at) else {
                keep.insert(at);
                continue;
            };
            if identity.turn_id.is_none() {
                issues.insert("codex_execution_turn_identity_required".into());
                continue;
            }
            match counts.get(identity).copied() {
                Some((1, 1)) => {
                    keep.insert(at);
                }
                Some((0, _)) => {} // All explicitly identified owners were discarded.
                Some(_) => {
                    issues.insert("codex_execution_call_ambiguous".into());
                }
                None => {
                    issues.insert("codex_execution_call_unresolved".into());
                }
            }
        }
        items.retain(|item| keep.contains(&location(&item.location)));
        Ok(items)
    }
}
