use super::*;
use rusqlite::OptionalExtension;

fn status(value: HistoricalToolLinkStatus) -> &'static str {
    match value {
        HistoricalToolLinkStatus::Linked => "linked",
        HistoricalToolLinkStatus::MissingResult => "missing_result",
        HistoricalToolLinkStatus::OrphanResult => "orphan_result",
        HistoricalToolLinkStatus::UnmatchedExecutionEvent => "unmatched_execution_event",
        HistoricalToolLinkStatus::Ambiguous => "ambiguous",
        HistoricalToolLinkStatus::ConflictingOutcome => "conflicting_outcome",
    }
}

fn decode_link(id: &str, bytes: &[u8], sha: &[u8]) -> Result<HistoricalToolLink> {
    ensure!(
        bytes.len() <= ENCODED_ROW && Sha256::digest(bytes).as_slice() == sha,
        "history_tool_links_record_changed"
    );
    let link: HistoricalToolLink = decode(bytes)?;
    ensure!(link.id == id, "history_tool_links_record_changed");
    Ok(link)
}

fn save(
    connection: &Connection,
    value: &HistoricalToolLink,
    progress: &mut HistoricalToolLinkProgress,
) -> Result<()> {
    let previous: Option<(Vec<u8>, Vec<u8>)> = connection
        .query_row(
            "SELECT body,sha FROM links WHERE id=?1",
            [&value.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((body, sha)) = previous {
        let previous = decode_link(&value.id, &body, &sha)?;
        ensure!(
            previous.call_id == value.call_id && previous.call == value.call,
            "history_tool_links_identity_changed"
        );
        if previous.status != HistoricalToolLinkStatus::Linked {
            progress.unresolved_links = progress
                .unresolved_links
                .checked_sub(1)
                .context("history_tool_links_invalid_progress")?;
        }
    } else {
        progress.recorded_links += 1;
    }
    if value.status != HistoricalToolLinkStatus::Linked {
        progress.unresolved_links += 1;
    }
    let bytes = encode(value)?;
    let open = value.call.is_some() && value.result.is_none();
    connection.execute("INSERT INTO links(id,call_id,turn_id,has_call,open,status,body,sha) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET turn_id=excluded.turn_id,has_call=excluded.has_call,open=excluded.open,status=excluded.status,body=excluded.body,sha=excluded.sha",params![&value.id,&value.call_id,&value.source_turn_id,value.call.is_some(),open,status(value.status),&bytes,Sha256::digest(&bytes).as_slice()])?;
    Ok(())
}

fn matching(
    connection: &Connection,
    call_id: &str,
    only_open: bool,
    turn_id: Option<&str>,
    allow_unknown: bool,
) -> Result<Vec<HistoricalToolLink>> {
    let mut statement=connection.prepare("SELECT id,body,sha FROM links WHERE call_id=?1 AND has_call=1 AND (?2=0 OR open=1) AND (?3 IS NULL OR turn_id=?3 OR (?4=1 AND turn_id IS NULL)) ORDER BY id LIMIT 3")?;
    let rows: Vec<(String, Vec<u8>, Vec<u8>)> = statement
        .query_map(params![call_id, only_open, turn_id, allow_unknown], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    rows.into_iter()
        .map(|(id, bytes, sha)| {
            let link = decode_link(&id, &bytes, &sha)?;
            ensure!(
                link.call_id == call_id
                    && link.call.is_some()
                    && (!only_open || link.result.is_none())
                    && turn_id.is_none_or(|id| link.source_turn_id.as_deref() == Some(id)
                        || allow_unknown && link.source_turn_id.is_none()),
                "history_tool_links_index_changed"
            );
            Ok(link)
        })
        .collect()
}

fn empty(
    call_id: &str,
    location: &HistoricalToolLocation,
    turn_id: Option<String>,
) -> Result<HistoricalToolLink> {
    ensure!(
        call_id.len() <= 4096 && turn_id.as_ref().is_none_or(|value| value.len() <= 4096),
        "history_tool_links_identity_budget_exceeded"
    );
    Ok(HistoricalToolLink {
        id: format!(
            "link-{:016x}-{:08x}",
            location.sequence,
            location.block.unwrap_or(u32::MAX)
        ),
        call_id: call_id.into(),
        name: None,
        namespace: None,
        source_turn_id: turn_id,
        call: None,
        result: None,
        execution_event: None,
        execution_outcome: None,
        status: HistoricalToolLinkStatus::MissingResult,
        outcome: HistoricalToolOutcome::OutcomeUnknown,
    })
}

fn combined_outcome(
    before: HistoricalToolOutcome,
    next: HistoricalToolOutcome,
) -> Option<HistoricalToolOutcome> {
    use HistoricalToolOutcome::*;
    if next == OutcomeUnknown {
        return Some(before);
    }
    match (before, next) {
        (OutcomeUnknown | RecordedResult, _) => Some(next),
        (_, RecordedResult) => Some(before),
        (before, after) if before == after => Some(before),
        _ => None,
    }
}

fn merge_outcome(link: &mut HistoricalToolLink, next: HistoricalToolOutcome) {
    if link.status == HistoricalToolLinkStatus::ConflictingOutcome {
        return;
    }
    match combined_outcome(link.outcome, next) {
        Some(value) => link.outcome = value,
        None => {
            link.status = HistoricalToolLinkStatus::ConflictingOutcome;
            link.outcome = HistoricalToolOutcome::OutcomeUnknown;
        }
    }
}

fn call(
    connection: &Connection,
    location: HistoricalToolLocation,
    call_id: &str,
    name: &str,
    namespace: Option<String>,
    turn_id: Option<String>,
    progress: &mut HistoricalToolLinkProgress,
) -> Result<()> {
    ensure!(
        name.len() <= 4096 && namespace.as_ref().is_none_or(|value| value.len() <= 4096),
        "history_tool_links_identity_budget_exceeded"
    );
    let existing = if call_id.is_empty() {
        Vec::new()
    } else {
        matching(connection, call_id, true, turn_id.as_deref(), true)?
    };
    let mut link = empty(call_id, &location, turn_id)?;
    link.call = Some(location);
    link.name = Some(name.into());
    link.namespace = namespace;
    if call_id.is_empty() || !existing.is_empty() {
        link.status = HistoricalToolLinkStatus::Ambiguous;
        for mut old in existing {
            old.status = HistoricalToolLinkStatus::Ambiguous;
            old.outcome = HistoricalToolOutcome::OutcomeUnknown;
            save(connection, &old, progress)?;
        }
    }
    save(connection, &link, progress)
}

fn result(
    connection: &Connection,
    location: HistoricalToolLocation,
    call_id: &str,
    outcome: HistoricalToolOutcome,
    turn_id: Option<String>,
    progress: &mut HistoricalToolLinkProgress,
) -> Result<()> {
    let open = if call_id.is_empty() {
        Vec::new()
    } else {
        matching(connection, call_id, true, turn_id.as_deref(), true)?
    };
    if open.len() == 1
        && open[0].status != HistoricalToolLinkStatus::Ambiguous
        && (turn_id.is_none()
            || open[0].source_turn_id.is_none()
            || turn_id == open[0].source_turn_id)
    {
        let mut link = open.into_iter().next().unwrap();
        link.result = Some(location);
        if link.status != HistoricalToolLinkStatus::ConflictingOutcome {
            link.status = HistoricalToolLinkStatus::Linked;
        }
        merge_outcome(&mut link, outcome);
        if let Some(execution) = link.execution_outcome {
            merge_outcome(&mut link, execution);
        }
        save(connection, &link, progress)
    } else {
        let mut link = empty(call_id, &location, turn_id)?;
        link.result = Some(location);
        link.outcome = outcome;
        link.status = if open.is_empty() && !call_id.is_empty() {
            HistoricalToolLinkStatus::OrphanResult
        } else {
            HistoricalToolLinkStatus::Ambiguous
        };
        save(connection, &link, progress)
    }
}

fn event(
    connection: &Connection,
    location: HistoricalToolLocation,
    call_id: &str,
    outcome: HistoricalToolOutcome,
    turn_id: Option<String>,
    progress: &mut HistoricalToolLinkProgress,
) -> Result<()> {
    let mut candidates = if call_id.is_empty() {
        Vec::new()
    } else {
        matching(connection, call_id, false, turn_id.as_deref(), false)?
    };
    if candidates.is_empty() && turn_id.is_some() {
        let all = matching(connection, call_id, false, None, false)?;
        if all.len() == 1 && all[0].source_turn_id.is_none() {
            candidates = all;
        }
    }
    if candidates.len() == 1 && candidates[0].status != HistoricalToolLinkStatus::Ambiguous {
        let mut link = candidates.into_iter().next().unwrap();
        if link.execution_event.is_none() {
            link.execution_event = Some(location);
        }
        let already_conflicted = link.status == HistoricalToolLinkStatus::ConflictingOutcome
            && link.execution_outcome == Some(HistoricalToolOutcome::OutcomeUnknown);
        if !already_conflicted {
            match combined_outcome(
                link.execution_outcome
                    .unwrap_or(HistoricalToolOutcome::OutcomeUnknown),
                outcome,
            ) {
                Some(value) => link.execution_outcome = Some(value),
                None => {
                    link.execution_outcome = Some(HistoricalToolOutcome::OutcomeUnknown);
                    link.status = HistoricalToolLinkStatus::ConflictingOutcome;
                    link.outcome = HistoricalToolOutcome::OutcomeUnknown;
                }
            }
        }
        // An exit receipt can prove execution facts without supplying the missing result.
        // Keep both facts so recovery never assumes that an unknown result means no action.
        if link.result.is_some() {
            let execution = link
                .execution_outcome
                .unwrap_or(HistoricalToolOutcome::OutcomeUnknown);
            merge_outcome(&mut link, execution);
        }
        save(connection, &link, progress)
    } else {
        let mut link = empty(call_id, &location, turn_id)?;
        link.execution_event = Some(location);
        link.execution_outcome = Some(outcome);
        link.status = HistoricalToolLinkStatus::UnmatchedExecutionEvent;
        save(connection, &link, progress)
    }
}

pub(super) fn append(
    connection: &Connection,
    sequence: u64,
    record: &HistoricalRecord,
    progress: &mut HistoricalToolLinkProgress,
) -> Result<()> {
    append_scoped(
        connection,
        sequence,
        record,
        &HistoricalToolOrigin {
            source_index: 0,
            replacement_index: None,
            omitted_blocks: Vec::new(),
        },
        progress,
    )
}

pub(super) fn append_scoped(
    connection: &Connection,
    sequence: u64,
    record: &HistoricalRecord,
    origin: &HistoricalToolOrigin,
    progress: &mut HistoricalToolLinkProgress,
) -> Result<()> {
    match &record.data {
        HistoricalRecordData::Message { blocks, .. } => {
            for (index, block) in blocks.iter().enumerate() {
                let location = origin
                    .location(sequence, record.record, Some(u32::try_from(index)?))
                    .context("history_tool_links_location_overflow")?;
                match block {
                    HistoricalBlock::ToolCall {
                        call_id,
                        name,
                        namespace,
                        ..
                    } => call(
                        connection,
                        location,
                        call_id,
                        name,
                        namespace.clone(),
                        record.turn_id.clone(),
                        progress,
                    )?,
                    HistoricalBlock::ToolResult {
                        call_id, outcome, ..
                    } => result(
                        connection,
                        location,
                        call_id,
                        *outcome,
                        record.turn_id.clone(),
                        progress,
                    )?,
                    _ => {}
                }
            }
        }
        HistoricalRecordData::Event {
            call_id: Some(call_id),
            outcome: Some(outcome),
            ..
        } => event(
            connection,
            origin
                .location(sequence, record.record, None)
                .context("history_tool_links_location_overflow")?,
            call_id,
            *outcome,
            record.turn_id.clone(),
            progress,
        )?,
        _ => {}
    }
    Ok(())
}
