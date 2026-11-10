//! Native terminal access to the same immutable archives and durable jobs used by Studio.
use super::{absolute, context::Context};
use crate::cli_args::{HistoryAction, HistorySelection, MigrationSourceArg};
use anyhow::{Context as _, Result, ensure};
use kcoder_migration::{
    history_branches::HistoryBranchStore, history_context::HistoryContextCompiler,
    history_discovery::HistoryCatalog, history_jobs::HistoryJobStore,
};
use kcoder_types::{
    external_history::HistoryImportStage, historical_context::HistoricalContextPolicy,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
#[path = "history/continuation.rs"]
mod continuation;
#[path = "history/local_attachment.rs"]
mod local_attachment;
#[path = "history/reinterpret.rs"]
mod reinterpret;
#[path = "history/rpc.rs"]
pub(super) mod rpc;
#[path = "history/search.rs"]
mod search;

pub(super) fn run(action: &HistoryAction, context: &Context, overlays: &[PathBuf]) -> Result<()> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(2)
        .enable_all()
        .build()?;
    let cancellation = cancelled.clone();
    let signal = runtime.spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            cancellation.store(true, Ordering::Release);
        }
    });
    // Keep the signal reactor alive while native callbacks reach their safe boundaries.
    let result = runtime.block_on(async {
        tokio::task::block_in_place(|| {
            if let HistoryAction::LocalAttachment { action } = action {
                local_attachment::run(action, context, overlays, &cancelled)
            } else if search::handles(action) {
                search::run(action, context, overlays, &cancelled)
            } else if continuation::handles(action) {
                continuation::run(action, context, overlays, &cancelled)
            } else {
                native(action, context, &cancelled)
            }
        })
    });
    signal.abort();
    result
}

fn source(
    selection: &HistorySelection,
    context: &Context,
    cancelled: &AtomicBool,
) -> Result<HistoryCatalog> {
    let kind = match selection.source {
        MigrationSourceArg::ClaudeCode => kcoder_types::migration::MigrationSourceKind::ClaudeCode,
        MigrationSourceArg::Codex => kcoder_types::migration::MigrationSourceKind::Codex,
    };
    HistoryCatalog::discover(
        &absolute(&selection.source_root, Some(&context.cwd))?,
        kind,
        |_| !cancelled.load(Ordering::Acquire),
    )
}

fn jobs(context: &Context) -> Result<HistoryJobStore> {
    HistoryJobStore::open_existing(&context.profile)?.context("history_job_not_found")
}

fn native(action: &HistoryAction, context: &Context, cancelled: &AtomicBool) -> Result<()> {
    let active = || !cancelled.load(Ordering::Acquire);
    let value = match action {
        HistoryAction::Reinterpret { action } => reinterpret::execute(action, context)?,
        HistoryAction::Scan { selection, page } => {
            let catalog = source(selection, context, cancelled)?;
            let cursor = (*page > 0).then(|| format!("{}:{}", catalog.id(), u64::from(*page) * 10));
            serde_json::to_value(catalog.page(cursor.as_deref(), |_| active())?)?
        }
        HistoryAction::Select {
            selection,
            source_session_id,
            source_artifact_id,
            source_agent_id,
            request_id,
            resources,
        } => {
            let limits = resources.limits()?;
            let catalog = source(selection, context, cancelled)?;
            let mut cursor = None;
            let mut candidates = Vec::new();
            loop {
                let page = catalog.page(cursor.as_deref(), |_| active())?;
                for item in page.items {
                    if &item.source_session_id == source_session_id
                        && item.agent_id.as_ref() == source_agent_id.as_ref()
                        && source_artifact_id
                            .as_ref()
                            .is_none_or(|id| item.source_artifact_id.as_ref() == Some(id))
                    {
                        candidates.push(item.source_handle);
                    }
                }
                cursor = page.next_cursor;
                if cursor.is_none() {
                    break;
                }
            }
            ensure!(
                candidates.len() == 1,
                if candidates.is_empty() {
                    "history_discovery_selection_unavailable"
                } else {
                    "history_discovery_selection_ambiguous"
                }
            );
            serde_json::to_value(
                HistoryJobStore::open(&context.profile)?.create_selected_with_resource_limits(
                    request_id,
                    catalog.selection(&candidates[0])?.pin()?,
                    limits,
                )?,
            )?
        }
        HistoryAction::Jobs { cursor } => match HistoryJobStore::open_existing(&context.profile)? {
            Some(store) => {
                let (jobs, next) = store.records(cursor.as_deref())?;
                json!({"jobs": jobs, "nextCursor": next})
            }
            None => json!({"jobs": [], "nextCursor": null}),
        },
        HistoryAction::Read { job_id } => serde_json::to_value(jobs(context)?.read(job_id)?)?,
        HistoryAction::Run {
            job_id,
            expected_sequence,
            resume_job,
        } => {
            let store = jobs(context)?;
            ensure!(
                *resume_job
                    || store.execution_state(job_id)?
                        != kcoder_migration::history_jobs::HistoryExecutionState::Unknown,
                "{}",
                store.execution_unknown_code(job_id)?
            );
            let metadata_only = *resume_job
                && store.execution_state(job_id)?
                    == kcoder_migration::history_jobs::HistoryExecutionState::Unknown
                && store.execution_unknown_code(job_id)? == "history_job_execution_untracked"
                && store.resume_only_checks_owner(job_id)?;
            if metadata_only {
                serde_json::to_value(store.resume(job_id, *expected_sequence)?)?
            } else {
                let (execution, sequence) = if *resume_job {
                    store.claim_resume_execution(job_id, *expected_sequence)?
                } else {
                    (
                        store.claim_execution(job_id, *expected_sequence)?,
                        *expected_sequence,
                    )
                };
                let mut job = if *resume_job {
                    store.resume_owned(&execution, sequence)?
                } else {
                    let job = store.read(job_id)?;
                    ensure!(
                        job.sequence == *expected_sequence,
                        "history_job_revision_conflict"
                    );
                    job
                };
                while (job.stage == HistoryImportStage::Normalized
                    && job.failure_code.as_deref()
                        == Some(
                            kcoder_migration::history_jobs::HISTORY_PROJECTION_RECOVERY_REQUIRED,
                        ))
                    || !matches!(
                        job.stage,
                        HistoryImportStage::Normalized
                            | HistoryImportStage::Cancelled
                            | HistoryImportStage::Failed
                    )
                {
                    job = store.step_owned(&execution, job.sequence, 10, |_| active())?;
                }
                serde_json::to_value(job)?
            }
        }
        HistoryAction::Cancel { job_id } => {
            let store = jobs(context)?;
            let job = store.request_cancel(job_id)?;
            // An idle job can settle immediately; an owned writer observes the durable control.
            let job = store
                .step(job_id, job.sequence, 10, |_| false)
                .or_else(|_| store.read(job_id))?;
            serde_json::to_value(job)?
        }
        HistoryAction::Page {
            job_id,
            view_id,
            cursor,
        } => {
            if let Some(id) = view_id {
                serde_json::to_value(HistoryBranchStore::open(&context.profile)?.page(
                    job_id,
                    id,
                    *cursor,
                    |_| active(),
                )?)?
            } else {
                serde_json::to_value(
                    jobs(context)?
                        .archive_view(job_id)?
                        .page(*cursor, |_| active())?,
                )?
            }
        }
        HistoryAction::Blocks {
            job_id,
            view_id,
            record,
            cursor,
        } => {
            if let Some(id) = view_id {
                serde_json::to_value(HistoryBranchStore::open(&context.profile)?.blocks(
                    job_id,
                    id,
                    *record,
                    *cursor,
                    |_| active(),
                )?)?
            } else {
                serde_json::to_value(jobs(context)?.archive_view(job_id)?.blocks(
                    *record,
                    *cursor,
                    |_| active(),
                )?)?
            }
        }
        HistoryAction::Text {
            job_id,
            view_id,
            record,
            block,
            offset,
        } => {
            if let Some(id) = view_id {
                serde_json::to_value(HistoryBranchStore::open(&context.profile)?.text(
                    job_id,
                    id,
                    *record,
                    *block,
                    *offset,
                    |_| active(),
                )?)?
            } else {
                serde_json::to_value(jobs(context)?.archive_view(job_id)?.text(
                    *record,
                    *block,
                    *offset,
                    |_| active(),
                )?)?
            }
        }
        HistoryAction::Branch {
            job_id,
            related_job_id,
            resume_sequence,
            tools_resume_sequence,
        } => {
            let store = HistoryBranchStore::open(&context.profile)?;
            let mut progress = store.prepare(job_id, related_job_id)?;
            if let Some(sequence) = resume_sequence {
                store.resume(job_id, &progress.view_id, *sequence)?;
            }
            progress = store.build(job_id, &progress.view_id, active)?;
            let tools = if progress.stage
                == kcoder_types::historical_branch::HistoricalBranchStage::Ready
            {
                Some(store.correlate(job_id, &progress.view_id, *tools_resume_sequence, active)?)
            } else {
                None
            };
            json!({"progress":progress, "tools": tools})
        }
        HistoryAction::BranchRead { job_id, view_id } => {
            let store = HistoryBranchStore::open(&context.profile)?;
            json!({"progress":store.progress(job_id, view_id)?,"tools":store.tools_state(job_id, view_id)?})
        }
        HistoryAction::BranchCancel { job_id, view_id } => {
            let store = HistoryBranchStore::open(&context.profile)?;
            store.cancel(job_id, view_id)?;
            store.cancel_tools(job_id, view_id)?;
            json!({"viewId":view_id,"cancelRequested":true})
        }
        HistoryAction::Tools {
            job_id,
            view_id,
            cursor,
        } => serde_json::to_value(HistoryBranchStore::open(&context.profile)?.tools_page(
            job_id,
            view_id,
            cursor.as_deref(),
        )?)?,
        HistoryAction::Check {
            job_id,
            view_id,
            local,
        } => {
            let bindings = local_attachment::parse_bindings(local)?;
            let result = HistoryContextCompiler::open(&context.profile)?
                .compile_with_local_attachments(
                    job_id,
                    view_id,
                    HistoricalContextPolicy::default(),
                    &bindings,
                    |_| active(),
                )?;
            // The compiled body remains native-only; output only its diagnostics and bounded counts.
            json!({"report":result.report,"createsSession":false,"currentModelChecked":false})
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    };
    super::batch::print(&value)?;
    if cancelled.load(Ordering::Acquire) {
        anyhow::bail!("migration_cancelled")
    }
    if value["stage"] == "failed" {
        anyhow::bail!("history_job_failed")
    }
    Ok(())
}
