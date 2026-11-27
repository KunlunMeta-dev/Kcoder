//! Candidate selection creates owned package records; publication belongs to the fixed batch.
use super::super::plugin;
use super::*;
use crate::cli_args::MigrationPluginBinding;
use kcoder_migration::{
    batch::BatchSource,
    discovery::SourceRegistry,
    plugin_migration::{PluginMigrationStage, PluginMigrationStore},
};
use kcoder_plugins::PluginCancellationToken;
use kcoder_types::migration::MigrationSourceKind;
use serde_json::json;
use std::collections::BTreeMap;
#[path = "plugin_sources/records.rs"]
mod records;
pub(super) use records::{RecordSelection, records};

fn token(guide: &Guide<'_>) -> PluginCancellationToken {
    let stopped = guide.cancelled.clone();
    PluginCancellationToken::default().with_probe(move || stopped.load(Ordering::Acquire))
}
fn show(
    guide: &Guide<'_>,
    value: &kcoder_migration::plugin_migration::PluginMigrationView,
) -> Result<()> {
    let store = plugin::existing(&guide.fresh()?)?;
    guide
        .io
        .state("plugin_job", &plugin::observed(&store, value)?)
}
fn captured(
    guide: &Guide<'_>,
    registry: &SourceRegistry,
    id: &str,
    saved: &mut BTreeMap<String, MigrationPluginBinding>,
    cancel: &PluginCancellationToken,
) -> Result<Option<BatchSource>> {
    let context = guide.fresh()?;
    plugin::private_profile(&context)?;
    let selected = if let Some(previous) = saved.get(id) {
        previous.clone()
    } else {
        let candidate = registry.selected_plugin(id)?;
        guide
            .io
            .state("plugin_candidate", &plugin::candidate(&candidate))?;
        ensure!(
            candidate.scope == "user" && candidate.pending.is_empty(),
            "plugin_migration_pending_resolution_required"
        );
        let request = guide.io.text("plugin_request_id", "Save this operationId. After interruption or a lost receipt, use plugin read/records to check the same record; do not create a replacement identity.", Some(&uuid::Uuid::new_v4().to_string()))?;
        ensure!(
            uuid::Uuid::parse_str(&request).is_ok_and(|id| id.to_string() == request),
            "plugin_migration_invalid_operation"
        );
        if !guide.io.yes("plugin_capture_consent", "Explicitly copy this selected local plugin package? Commands, Hooks and MCP are not run. Ready only means static capture is complete; first IMPORT still checks that the original source is unchanged. Keep the original plugin directory until submission completes. The target is disabled by default.")? { return Ok(None); }
        guide.fresh()?;
        guide.io.state(
            "operation",
            &json!({"operationId":request,"step":"plugin_prepare_intent","publication":false}),
        )?;
        let store = PluginMigrationStore::open(&context.profile)?;
        guide.fresh()?;
        let prepared = store.prepare(&request, &candidate)?;
        show(guide, &prepared)?;
        let result = store.capture(&request, prepared.sequence, cancel);
        let ready = match result {
            Ok(value) => value,
            Err(error) => {
                if let Ok(view) = store.read(&request, &PluginCancellationToken::default()) {
                    show(guide, &view)?;
                }
                return Err(error);
            }
        };
        show(guide, &ready)?;
        ensure!(
            ready.stage == PluginMigrationStage::Ready,
            "plugin_migration_plan_not_ready"
        );
        let selected = MigrationPluginBinding {
            operation_id: request,
            sequence: ready.sequence,
        };
        saved.insert(id.into(), selected.clone());
        selected
    };
    let store = plugin::existing(&guide.fresh()?)?;
    show(guide, &store.read(&selected.operation_id, cancel)?)?;
    if !guide.io.yes("plugin_use_consent", "After reviewing capabilities, pending and readiness, include this Ready static copy in the unified inventory? First IMPORT still checks the original source. Pending readiness configuration does not mean copy failure or runtime readiness; imports are disabled by default.")? {return Ok(None);}
    plugin::binding(&guide.fresh()?, &selected).map(Some)
}
pub(super) fn choose(
    guide: &Guide<'_>,
    registry: &mut SourceRegistry,
    kind: MigrationSourceKind,
    other_sources: usize,
) -> Result<Vec<BatchSource>> {
    let cancel = token(guide);
    let mut page = registry.discover_plugins(&[kind], None, &cancel)?;
    let mut cursors = vec![None];
    let mut index = 0usize;
    let mut selected = BTreeMap::<String, BatchSource>::new();
    let mut saved = BTreeMap::<String, MigrationPluginBinding>::new();
    let mut unresolved = false;
    loop {
        guide.fresh()?;
        let rows = page.candidates.iter().enumerate().map(|(at,item)|json!({"number":at+1,"selected":selected.contains_key(&item.candidate_id),"candidate":plugin::candidate(&item.candidate)})).collect::<Vec<_>>();
        let answer = guide.io.ask("plugin_selection", "Up to 10 installed plugins per page. select N reviews and explicitly copies/deselects; details N reads; next/prev changes pages; done fixes the selection; skip excludes plugins. /migrate stop may stop copying; records are retained.",json!({"page":index,"selected":selected.len(),"hasNextPage":page.next_cursor.is_some(),"items":rows,"problems":page.problems.iter().map(|p|json!({"code":p.code,"scope":p.scope})).collect::<Vec<_>>()}),None)?;
        let mut words = answer.split_whitespace();
        match words.next().unwrap_or("") {
            "skip" => return Ok(Vec::new()),
            "done" => {
                if (unresolved || !page.problems.is_empty()) && !guide.io.yes("plugin_partial_consent", "Some compatibility/discovery issues or unready records are not included. Continue this batch using only explicitly selected Ready copies? Other records are not counted as successful imports and can be read in plugin-records.")? {continue;}
                return Ok(selected.into_values().collect());
            }
            "next" if page.next_cursor.is_some() => {
                cursors.truncate(index + 1);
                cursors.push(page.next_cursor.clone());
                index += 1;
                page = registry.discover_plugins(&[kind], cursors[index].as_deref(), &cancel)?;
            }
            "prev" if index > 0 => {
                index -= 1;
                page = registry.discover_plugins(&[kind], cursors[index].as_deref(), &cancel)?;
            }
            action @ ("select" | "details") => {
                let item = words
                    .next()
                    .and_then(|v| v.parse::<usize>().ok())
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|n| page.candidates.get(n));
                let Some(item) = item else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "Select a plugin number on the current page.",
                    )?;
                    continue;
                };
                if action == "details" {
                    guide
                        .io
                        .state("plugin_candidate", &plugin::candidate(&item.candidate))?;
                    continue;
                }
                if selected.remove(&item.candidate_id).is_some() {
                    continue;
                }
                if other_sources.saturating_add(selected.len()) >= 64 {
                    guide.io.notice(
                        "migration_batch_budget_exceeded",
                        "Up to 64 sources combined; this package was not copied.",
                    )?;
                    continue;
                }
                match captured(guide, registry, &item.candidate_id, &mut saved, &cancel) {
                    Ok(Some(source)) => {
                        selected.insert(item.candidate_id.clone(), source);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        unresolved = true;
                        guide.io.notice(&safe_error(&error),"This plugin was not treated as successfully included. Its created original operationId record can be read and explicitly resumed; do not retry under a different identity.")?;
                        guide.io.active()?;
                    }
                }
            }
            _ => guide.io.notice(
                "migration_guide_invalid_selection",
                "Select a plugin on this page or a valid operation; plugins were not published.",
            )?,
        }
    }
}
