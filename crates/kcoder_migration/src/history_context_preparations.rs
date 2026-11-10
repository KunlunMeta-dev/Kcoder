//! Compile and copy into target-owned immutable preparations without creating an active session.
use crate::{
    history_attachment_jobs::HistoryAttachmentJobs,
    history_context::{HistoryContextCompiler, HistoryContextProgress},
};
use anyhow::{Context, Result, ensure};
use kcoder_state::historical_contexts::{
    ContextPreparationProgress, HistoricalContextStore, PreparedContextReceipt,
};
use kcoder_types::historical_context::{
    HistoricalContextAttachmentProvenance, HistoricalContextPolicy, HistoricalContextReport,
    HistoricalLocalAttachmentBinding,
};
use std::path::Path;

#[derive(Clone, Copy)]
pub enum HistoryPreparationProgress {
    Compiling(HistoryContextProgress),
    Copying(ContextPreparationProgress),
}
pub enum HistoryPreparationOutcome {
    Blocked(HistoricalContextReport),
    Prepared {
        report: HistoricalContextReport,
        receipt: PreparedContextReceipt,
    },
}
pub fn prepare(
    profile: &Path,
    id: &str,
    job: &str,
    view: &str,
    policy: HistoricalContextPolicy,
    check: impl FnMut(HistoryPreparationProgress) -> bool,
) -> Result<HistoryPreparationOutcome> {
    prepare_with_local_attachments(profile, id, job, view, policy, &[], check)
}
pub fn prepare_with_local_attachments(
    profile: &Path,
    id: &str,
    job: &str,
    view: &str,
    policy: HistoricalContextPolicy,
    local_attachments: &[HistoricalLocalAttachmentBinding],
    mut check: impl FnMut(HistoryPreparationProgress) -> bool,
) -> Result<HistoryPreparationOutcome> {
    // Hold the admitted branch and its raw-source claims through compilation and publication.
    let branch =
        crate::history_branches::HistoryBranchStore::open(profile)?.reference_view(job, view)?;
    // Compile before creating preparation storage; blocked sources remain inert archives only.
    let compilation = HistoryContextCompiler::open(profile)?.compile_with_local_attachments(
        job,
        view,
        policy,
        local_attachments,
        |value| check(HistoryPreparationProgress::Compiling(value)),
    )?;
    if !compilation.report.context_compiled {
        return Ok(HistoryPreparationOutcome::Blocked(compilation.report));
    }
    let document = compilation
        .document
        .context("history_context_preparation_document_missing")?;
    let binding = compilation
        .binding
        .context("history_context_preparation_binding_missing")?;
    let attachments = HistoryAttachmentJobs::open_existing(profile)?;
    let local = if document
        .attachments
        .iter()
        .any(|attachment| attachment.provenance.is_some())
    {
        crate::local_attachment::HistoryLocalAttachments::open_existing(profile)?
    } else {
        None
    };
    let store = HistoricalContextStore::open(profile)?;
    let receipt = store.prepare_referenced(
        id,
        &document,
        &binding,
        &branch.source_guards(),
        |attachment, offset, limit| {
            if let Some(HistoricalContextAttachmentProvenance::UserSuppliedLocal { operation_id }) =
                &attachment.provenance
            {
                return local
                    .as_ref()
                    .context("history_context_preparation_local_missing")?
                    .chunk(
                        operation_id,
                        &attachment.selection,
                        &attachment.receipt,
                        offset,
                        limit,
                    );
            }
            let jobs = attachments
                .as_ref()
                .context("history_context_preparation_attachment_missing")?;
            let (receipt, bytes) = jobs.chunk(&attachment.selection, offset, limit)?;
            ensure!(
                receipt == attachment.receipt,
                "history_context_preparation_attachment_changed"
            );
            Ok(bytes)
        },
        |value| check(HistoryPreparationProgress::Copying(value)),
    )?;
    Ok(HistoryPreparationOutcome::Prepared {
        report: compilation.report,
        receipt,
    })
}
