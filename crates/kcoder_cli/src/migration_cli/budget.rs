//! Native quota controls retain their original owner, receipts, cancellation and execution state.
use super::{batch::print, context::Context, settings_targets};
use crate::cli_args::{MigrationBudgetAction as Action, MigrationBudgetScope as Scope};
use anyhow::{Context as _, Result, ensure};
use kcoder_app_protocol::MigrationHistoryResourceResult;
use kcoder_migration::{history_jobs::HistoryJobStore, store::MigrationStore};

fn history(context: &Context) -> Result<HistoryJobStore> {
    HistoryJobStore::open_existing(&context.profile)?.context("history_job_not_found")
}

fn history_view(
    store: &HistoryJobStore,
    job_id: &str,
    request_id: Option<&str>,
) -> Result<MigrationHistoryResourceResult> {
    let (owner_job_id, initial_limits, budget) =
        store.observe_resource_budget(job_id, request_id)?;
    Ok(MigrationHistoryResourceResult {
        owner_job_id,
        initial_limits: initial_limits.map(Into::into),
        budget,
    })
}

fn writable_batch(context: &Context, job_id: &str) -> Result<MigrationStore> {
    let store = MigrationStore::open_existing(&context.profile)?;
    settings_targets::verify(context, &store.read(job_id)?)?;
    Ok(store)
}

pub(super) fn run(action: &Action, context: &Context) -> Result<()> {
    match action {
        Action::Read {
            scope,
            job_id,
            request_id,
        } => match scope {
            Scope::Batch => print(
                &MigrationStore::open_existing(&context.profile)?
                    .batch_resource_budget(job_id, request_id.as_deref())?,
            ),
            Scope::History => print(&history_view(
                &history(context)?,
                job_id,
                request_id.as_deref(),
            )?),
        },
        Action::Increase {
            owner,
            request_id,
            expected_policy_revision,
            limits,
            confirm,
        } => {
            ensure!(*confirm, "migration_resource_consent_required");
            let limits = limits.native()?;
            let receipt = match owner.scope {
                Scope::Batch => writable_batch(context, &owner.job_id)?
                    .raise_batch_resource_budget(
                        &owner.job_id,
                        owner
                            .plan_id
                            .as_deref()
                            .context("migration_plan_required")?,
                        request_id,
                        *expected_policy_revision,
                        limits,
                        true,
                    )?,
                Scope::History => {
                    ensure!(
                        owner.plan_id.is_none(),
                        "history_resource_unexpected_parent_plan"
                    );
                    history(context)?.raise_resource_budget(
                        &owner.job_id,
                        request_id,
                        *expected_policy_revision,
                        limits,
                        true,
                    )?
                }
            };
            print(&receipt)
        }
        Action::Attach {
            owner,
            expected_sequence,
            limits,
            confirm,
        } => {
            ensure!(*confirm, "migration_resource_consent_required");
            let limits = limits.native()?;
            match owner.scope {
                Scope::Batch => print(
                    &writable_batch(context, &owner.job_id)?.attach_batch_resource_budget(
                        &owner.job_id,
                        owner
                            .plan_id
                            .as_deref()
                            .context("migration_plan_required")?,
                        *expected_sequence,
                        limits,
                        true,
                        &history(context)?,
                    )?,
                ),
                Scope::History => {
                    ensure!(
                        owner.plan_id.is_none(),
                        "history_resource_unexpected_parent_plan"
                    );
                    let store = history(context)?;
                    store.attach_resource_budget(
                        &owner.job_id,
                        *expected_sequence,
                        limits,
                        true,
                    )?;
                    print(&history_view(&store, &owner.job_id, None)?)
                }
            }
        }
    }
}
