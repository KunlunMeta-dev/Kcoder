//! Opening a record reads its existing journal; it never creates a replacement operation.
use super::*;
use serde_json::json;

pub(super) enum Entry {
    New {
        history: bool,
        plugins: bool,
        memory: bool,
        definitions: bool,
    },
    ReadyPlugin(Box<kcoder_migration::batch::BatchSource>),
    Existing(String),
    Instructions,
    Projects,
    Creation,
    Quit,
}
pub(super) fn choose(guide: &Guide<'_>) -> Result<Entry> {
    loop {
        match guide.io.ask("entry","Start a new migration or continue from an original record. Use /migration for history-specific reading and continuation.",json!([
            {"value":"projects","label":"Import project lists and explicitly associate Native target directories (without copying worktrees)"},
            {"value":"instructions","label":"Explicitly authorize instruction directories and map them to the current workspace"},{"value":"creation","label":"Check or resume an unpublished capture using its original request"},
            {"value":"new","label":"Migrate configuration and compatible assets"},{"value":"new-with-history","label":"Migrate configuration, compatible assets and explicitly selected history"},{"value":"new-with-plugins","label":"Review and import explicitly selected plugins"},{"value":"new-all","label":"Explicitly select configuration, assets, history, plugins and memory"},{"value":"new-with-definitions","label":"Save pending Agent/Hook definitions (without executing them)"},{"value":"new-with-memory","label":"Explicitly select unverified source memory notes"},{"value":"memory-records","label":"Manage imported unverified notes"},{"value":"records","label":"Browse existing batches by page"},{"value":"plugin-records","label":"Read and resume plugin copy records"},{"value":"quit","label":"Quit"}
        ]),None)?.as_str() {
            "new-with-definitions"=>return Ok(Entry::New {history:false,plugins:false,memory:false,definitions:true}),
            "projects"=>return Ok(Entry::Projects),
            "instructions"=>return Ok(Entry::Instructions),
            "creation"=>return Ok(Entry::Creation),
            "new"=>return Ok(Entry::New { history: false, plugins:false, memory:false, definitions:false }),
            "new-with-history"=>return Ok(Entry::New { history: true, plugins:false, memory:false, definitions:false }),
            "new-with-plugins"=>return Ok(Entry::New { history: false, plugins:true, memory:false, definitions:false }),
            "new-with-memory"=>return Ok(Entry::New { history:false, plugins:false, memory:true, definitions:false }),
            "new-all"=>return Ok(Entry::New { history: true, plugins:true, memory:true, definitions:false }),"quit"=>return Ok(Entry::Quit),
            "memory-records"=>super::memory::records(guide)?,
            "plugin-records"=>match plugin_sources::records(guide)? {
                Some(plugin_sources::RecordSelection::Ready(source))=>return Ok(Entry::ReadyPlugin(source)),
                Some(plugin_sources::RecordSelection::Batch(id))=>return Ok(Entry::Existing(id)),None=>{},
            },
            "records"=>if let Some(id)=records(guide)? {return Ok(Entry::Existing(id));},
            _=>guide.io.notice("migration_guide_invalid_selection","Choose a listed source/record entry; the target was not changed.")?,
        }
    }
}
fn records(guide: &Guide<'_>) -> Result<Option<String>> {
    let context = guide.fresh()?;
    let store = match MigrationStore::open_existing(&context.profile) {
        Ok(store) => store,
        Err(error)
            if error.chain().any(|e| {
                e.downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            guide.io.notice(
                "migration_guide_no_records",
                "The current target has no migration records.",
            )?;
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let mut cursor = None;
    loop {
        let (records, next) = store.records(cursor.as_deref())?;
        let rows=records.iter().enumerate().map(|(index,record)|json!({"number":index+1,"jobId":record.job_id,"source":record.source,"status":record.status,"isBatch":record.batch,"selectedItems":record.selected_items,"committedItems":record.committed_items,"hasUnconfirmedOutcomes":record.has_unconfirmed_outcomes})).collect::<Vec<_>>();
        let answer = guide.io.ask(
            "records",
            "Up to 10 records per page. Enter a number to open its original record, next for the next page, or back to return. Reads do not retry changes.",
            json!({"items":rows,"hasNextPage":next.is_some()}),
            None,
        )?;
        match answer.as_str() {
            "back" => return Ok(None),
            "next" if next.is_some() => cursor = next,
            _ => {
                if let Some(record) = answer
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|n| records.get(n))
                {
                    return Ok(Some(record.job_id.clone()));
                } else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "Select a number on this page or a valid paging operation.",
                    )?;
                }
            }
        }
    }
}
