use super::*;

#[derive(Default)]
struct Segment {
    turn_id: Option<String>,
    user_turn: bool,
    checkpoint: Option<usize>,
}

fn compatible(active: Option<&str>, incoming: Option<&str>) -> bool {
    active.is_none_or(|active| incoming.is_none_or(|incoming| active == incoming))
}

fn finish(segment: Segment, pending: &mut u64, selected: &mut Option<usize>) {
    if *pending > 0 {
        if segment.user_turn {
            *pending -= 1;
        }
    } else if selected.is_none() {
        *selected = segment.checkpoint;
    }
}

/// Find a surviving checkpoint before replaying its original suffix. Replacing history
/// with every checkpoint in a forward scan would erase the very turn rollback removes.
pub(super) fn checkpoint(
    entries: &[Entry],
    check: &mut impl FnMut(u64) -> bool,
) -> Result<Option<usize>> {
    let latest = entries
        .iter()
        .rposition(|entry| matches!(entry.kind, Kind::Compaction { .. }));
    let bounded = latest.filter(|at| {
        matches!(
            entries[*at].kind,
            Kind::Compaction {
                bounds_input: true,
                ..
            }
        )
    });
    let start = bounded.map_or(0, |at| at + 1);
    let checkpoint_turn = bounded.and_then(|at| match &entries[at].kind {
        Kind::Compaction { resume_turn_id, .. } => resume_turn_id.as_deref(),
        _ => None,
    });
    let mut starts = entries[start..]
        .iter()
        .rev()
        .filter(|entry| matches!(entry.kind, Kind::Start))
        .peekable();
    let mut active = None::<Segment>;
    let mut pending = 0u64;
    let mut selected = bounded;
    for at in (start..entries.len()).rev() {
        ensure!(check(entries[at].record), "history_selection_cancelled");
        let entry = &entries[at];
        let preceding = starts
            .peek()
            .and_then(|entry| entry.turn_id.as_deref())
            .or(checkpoint_turn);
        match &entry.kind {
            Kind::Compaction { replacement, .. } => {
                let segment = active.get_or_insert_with(Segment::default);
                if segment.checkpoint.is_none() && replacement.is_some() {
                    segment.checkpoint = Some(at);
                }
            }
            Kind::Rollback(turns) => pending = pending.saturating_add(*turns),
            Kind::Complete => {
                if !compatible(preceding, entry.turn_id.as_deref()) {
                    continue;
                }
                let segment = active.get_or_insert_with(Segment::default);
                if segment.turn_id.is_none() {
                    segment.turn_id = entry.turn_id.clone();
                }
            }
            Kind::Abort => {
                if !compatible(preceding, entry.turn_id.as_deref()) {
                    continue;
                }
                if let Some(segment) = active.as_mut() {
                    if segment.turn_id.is_none() {
                        segment.turn_id = entry.turn_id.clone();
                    }
                } else if entry.turn_id.is_some() {
                    active = Some(Segment {
                        turn_id: entry.turn_id.clone(),
                        ..Default::default()
                    });
                }
            }
            Kind::UserEvent | Kind::InterAgent => {
                active.get_or_insert_with(Segment::default).user_turn = true
            }
            Kind::Context => {
                let segment = active.get_or_insert_with(Segment::default);
                if segment.turn_id.is_none() {
                    segment.turn_id = entry.turn_id.clone();
                }
            }
            Kind::Start => {
                starts.next();
                if active.as_ref().is_some_and(|segment| {
                    compatible(segment.turn_id.as_deref(), entry.turn_id.as_deref())
                }) {
                    finish(
                        active.take().expect("checked active segment"),
                        &mut pending,
                        &mut selected,
                    );
                }
            }
            Kind::Item(item) => {
                active.get_or_insert_with(Segment::default).user_turn |=
                    item.metadata.user_turn_boundary == Some(true);
            }
            _ => {}
        }
    }
    if let Some(segment) = active {
        finish(segment, &mut pending, &mut selected);
    }
    Ok(selected)
}

pub(super) fn window(
    entries: &[Entry],
    checkpoint: Option<usize>,
    issues: &mut BTreeSet<String>,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<Vec<Item>> {
    let mut items = Vec::new();
    if let Some(Kind::Compaction {
        replacement: Some(replacement),
        ..
    }) = checkpoint.map(|at| &entries[at].kind)
    {
        for item in replacement {
            ensure!(check(item.location.record), "history_selection_cancelled");
            if item.role != HistoricalRole::System {
                items.push(item.clone());
            }
        }
    }
    let mut rollback_work = 0u64;
    for entry in &entries[checkpoint.map_or(0, |at| at + 1)..] {
        ensure!(check(entry.record), "history_selection_cancelled");
        match &entry.kind {
            Kind::Item(item) | Kind::Supplemental(item) if item.role != HistoricalRole::System => {
                items.push(item.as_ref().clone())
            }
            Kind::Rollback(turns) => {
                rollback(&mut items, *turns, issues, &mut rollback_work, check)?
            }
            Kind::Compaction {
                replacement: None, ..
            } => {
                issues.insert("legacy_codex_compaction_unresolved".into());
            }
            Kind::InterAgent => {
                issues.insert("codex_agent_context_conversion_required".into());
            }
            _ => {}
        }
    }
    Ok(items)
}

fn rollback(
    items: &mut Vec<Item>,
    turns: u64,
    issues: &mut BTreeSet<String>,
    work: &mut u64,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<()> {
    if turns == 0 {
        return Ok(());
    }
    // Many no-op rollbacks over context-only history otherwise cause quadratic
    // scans. Fail without modifying the immutable archive when work is exhausted.
    *work = work.saturating_add((items.len() as u64).saturating_mul(4).saturating_add(1));
    ensure!(
        *work <= 16 * 1024 * 1024,
        "history_selection_work_budget_exceeded"
    );
    let mut positions = Vec::new();
    for (at, item) in items.iter().enumerate() {
        if at % 1024 == 0 {
            ensure!(check(item.location.record), "history_selection_cancelled");
        }
        match item.metadata.user_turn_boundary {
            None => {
                issues.insert("codex_rollback_boundary_unresolved".into());
            }
            Some(true) => positions.push(at),
            _ => {}
        }
    }
    let Some(&first) = positions.first() else {
        return Ok(());
    };
    let mut cut = positions[positions
        .len()
        .saturating_sub(usize::try_from(turns).unwrap_or(usize::MAX))];
    let acceptance_order = items[cut].metadata.user_input_order;
    let first_turn_id = items[first].metadata.turn_id.clone();
    while cut > first
        && matches!(
            items[cut - 1].role,
            HistoricalRole::User | HistoricalRole::Developer
        )
        && items[cut - 1].metadata.contextual_message == Some(true)
    {
        cut -= 1;
    }
    items.truncate(cut);
    items.retain(|item| {
        !acceptance_order.is_some_and(|boundary| {
            (item.role == HistoricalRole::Assistant
                && item.metadata.response_type.as_deref() == Some("message")
                || item.metadata.response_type.as_deref() == Some("function_call"))
                && item
                    .metadata
                    .user_input_order
                    .is_some_and(|order| order >= boundary)
        })
    });
    if cut == first
        && let Some(first_turn) = first_turn_id
    {
        items.retain_mut(|item| {
            if item.role == HistoricalRole::Developer
                && item.metadata.turn_id.as_deref() == Some(first_turn.as_str())
            {
                item.location.omitted_blocks = item.metadata.rollback_first_context_blocks.clone();
                return item.location.omitted_blocks.len() < item.blocks;
            }
            true
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_context_only_rollbacks_stop_without_consuming_a_user_turn() {
        let raw = br#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>old context</environment_context>"}]}}"#;
        let record =
            crate::history_records::parse_reader(MigrationSourceKind::Codex, 0, &raw[..], |_| true)
                .unwrap();
        let prototype = Item::from_data(0, None, record.codex.as_ref().unwrap(), &record.data);
        let mut items = vec![prototype; 1000];
        let mut issues = BTreeSet::new();
        let mut work = 0;
        let failure = (0..10_000)
            .find_map(|_| rollback(&mut items, 1, &mut issues, &mut work, &mut |_| true).err())
            .expect("repeated no-op scans must be bounded");
        assert!(
            failure
                .to_string()
                .contains("history_selection_work_budget_exceeded")
        );
        assert_eq!(items.len(), 1000);
        assert!(issues.is_empty());
    }
}
