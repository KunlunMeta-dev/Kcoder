//! Reopening a copy uses its original operation; a batch claim routes mutation to its parent.
use super::*;
pub(in crate::migration_cli::guide) enum RecordSelection {
    Ready(Box<BatchSource>),
    Batch(String),
}
pub(in crate::migration_cli::guide) fn records(
    guide: &Guide<'_>,
) -> Result<Option<RecordSelection>> {
    let context = guide.fresh()?;
    let Some(store) = PluginMigrationStore::open_existing(&context.profile)? else {
        guide.io.notice(
            "plugin_migration_no_records",
            "The current target has no plugin copy records.",
        )?;
        return Ok(None);
    };
    let cancel = token(guide);
    let mut cursor = None;
    let mut cursors = vec![None];
    let mut index = 0usize;
    loop {
        guide.fresh()?;
        let (items, next) = store.list(cursor.as_deref())?;
        let rows = items
            .iter()
            .enumerate()
            .map(|(at, item)| Ok(json!({"number":at+1,"job":plugin::observed(&store,item)?})))
            .collect::<Result<Vec<_>>>()?;
        let answer = guide.io.ask(
            "plugin_records",
            "Up to 10 Native plugin records per page. A number opens its record; next/prev changes pages; back returns. Reading does not copy or publish.",
            json!({"page":index,"items":rows,"hasNextPage":next.is_some()}),
            None,
        )?;
        match answer.as_str() {
            "back" => return Ok(None),
            "next" if next.is_some() => {
                cursors.truncate(index + 1);
                cursors.push(next.clone());
                index += 1;
                cursor = next;
            }
            "prev" if index > 0 => {
                index -= 1;
                cursor = cursors[index].clone();
            }
            _ => {
                if let Some(item) = answer
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|n| items.get(n))
                {
                    if let Some(result) = record(guide, &store, &item.operation_id, &cancel)? {
                        return Ok(Some(result));
                    }
                } else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "Select a number on the current page or a valid paging operation.",
                    )?;
                }
            }
        }
    }
}
fn record(
    guide: &Guide<'_>,
    store: &PluginMigrationStore,
    id: &str,
    cancel: &PluginCancellationToken,
) -> Result<Option<RecordSelection>> {
    loop {
        guide.fresh()?;
        let current = store.read(id, cancel)?;
        show(guide, &current)?;
        let mut actions = vec![
            json!({"value":"read","label":"Read the original record"}),
            json!({"value":"back","label":"Return to the records list"}),
        ];
        if current.batch_job_id.is_some() {
            actions.push(json!({"value":"batch","label":"Open the linked unified batch"}));
        } else {
            if current.stage == PluginMigrationStage::Ready {
                actions.push(json!({"value":"use","label":"Include this original copy in a new unified inventory"}));
            }
            if !current.imported {
                actions.extend([
                    json!({"value":"capture","label":"Explicitly continue copying"}),
                    json!({"value":"resume","label":"Restore control after confirming the original cancellation progress"}),
                    json!({"value":"cancel","label":"Cancel this original operation"}),
                ]);
            } else if current.stage != PluginMigrationStage::Undone {
                actions.push(json!({"value":"undo","label":"Explicitly undo this standalone operation's original output"}));
            }
        }
        let answer=guide.io.ask("plugin_record_menu","Review the current operationId, sequence, state and readiness conditions. Batch-claimed records may only open their original batch; standalone operations cannot bypass ownership.",json!(actions),None)?;
        let result = match answer.as_str() {
            "back" => return Ok(None),
            "read" => continue,
            "batch" => {
                return Ok(Some(RecordSelection::Batch(
                    current
                        .batch_job_id
                        .ok_or_else(|| anyhow::anyhow!("plugin_migration_no_parent"))?,
                )));
            }
            "use" => {
                return plugin::binding(
                    &guide.fresh()?,
                    &MigrationPluginBinding {
                        operation_id: id.into(),
                        sequence: current.sequence,
                    },
                )
                .map(|source| Some(RecordSelection::Ready(Box::new(source))));
            }
            "capture" => {
                if !guide.io.yes("plugin_capture_consent","Explicitly continue the fixed copy under the same operationId? The source, version and parameters are unchanged; the installation is not published.")? {continue;}
                guide.fresh()?;
                store.capture(id, current.sequence, cancel)
            }
            "resume" => {
                guide.fresh()?;
                store.resume(id, current.sequence)
            }
            "cancel" => {
                guide.fresh()?;
                store.cancel(id, current.sequence)
            }
            "undo" => {
                if guide.io.text(
                    "plugin_undo_confirm",
                    "Enter UNDO to undo only this standalone operation's owned, unedited package. Batch records must use the original batch.",
                    None,
                )? != "UNDO"
                {
                    continue;
                }
                guide.fresh()?;
                store.undo(id, current.sequence, cancel)
            }
            _ => {
                guide.io.notice(
                    "migration_guide_invalid_selection",
                    "Choose an operation allowed by the current record.",
                )?;
                continue;
            }
        };
        match result {
            Ok(view) => show(guide, &view)?,
            Err(error) => {
                guide.io.notice(
                    &safe_error(&error),
                    "The operation was not treated as successful. Continue reading the same operationId.",
                )?;
                guide.io.active()?;
            }
        }
    }
}
