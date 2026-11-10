//! Native package records remain the authority before and after a unified batch accepts them.
use super::{context::Context, *};
use crate::cli_args::{
    MigrationPluginAction as Action, MigrationPluginBinding, MigrationPluginSourceArgs,
};
use kcoder_migration::plugin_migration::{
    PluginMigrationStage, PluginMigrationStore, PluginMigrationView,
};
use kcoder_plugins::PluginCancellationToken;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
#[path = "plugin/source.rs"]
mod source;
#[path = "plugin/view.rs"]
mod view;
pub(super) use source::{page, registry};
pub(super) use view::{candidate, public};

pub(super) fn private_profile(context: &Context) -> Result<()> {
    kcoder_config::PrivateDirectory::open_existing(&context.profile)?
        .verify_private_directory()
        .map_err(|_| anyhow::anyhow!("plugin_migration_target_profile_requires_private_access"))
}
pub(super) fn existing(context: &Context) -> Result<PluginMigrationStore> {
    private_profile(context)?;
    PluginMigrationStore::open_existing(&context.profile)?
        .ok_or_else(|| anyhow::anyhow!("plugin_migration_store_missing"))
}
pub(super) fn binding(
    context: &Context,
    selected: &MigrationPluginBinding,
) -> Result<kcoder_migration::batch::BatchSource> {
    let store = existing(context)?;
    let current = store.read(&selected.operation_id, &PluginCancellationToken::default())?;
    ensure!(
        current.sequence == selected.sequence,
        "plugin_migration_stale_sequence"
    );
    ensure!(
        current.stage == PluginMigrationStage::Ready && current.batch_job_id.is_none(),
        "plugin_migration_ready_unclaimed_operation_required"
    );
    Ok(kcoder_migration::batch::BatchSource::Plugin(Box::new(
        store.batch_source(&selected.operation_id, selected.sequence)?,
    )))
}
pub(super) fn records(context: &Context, cursor: Option<&str>) -> Result<Value> {
    private_profile(context)?;
    let Some(store) = PluginMigrationStore::open_existing(&context.profile)? else {
        ensure!(cursor.is_none(), "plugin_migration_invalid_page");
        return Ok(json!({"items":[],"nextCursor":null}));
    };
    let (items, next) = store.list(cursor)?;
    let items = items
        .iter()
        .map(|view| observed(&store, view))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"items":items,"nextCursor":next}))
}
pub(super) fn observed(store: &PluginMigrationStore, view: &PluginMigrationView) -> Result<Value> {
    let mut value = public(view);
    value["workerRunning"] = json!(store.running(&view.operation_id)?);
    Ok(value)
}
fn execute(action: &Action, context: &Context, cancel: &PluginCancellationToken) -> Result<Value> {
    match action {
        Action::Discover {
            source,
            page: index,
        } => {
            let (mut registry, kind) = registry(context, source)?;
            let result = page(&mut registry, kind, *index, cancel)?;
            Ok(
                json!({"items":result.candidates.iter().map(|item| candidate(&item.candidate)).collect::<Vec<_>>(),"page":index,"hasNextPage":result.next_cursor.is_some(),"problems":result.problems.iter().map(|p| json!({"code":p.code,"scope":p.scope})).collect::<Vec<_>>(),"selection":"prepare requires exact name/scope/installedVersion from a fresh authorized discovery"}),
            )
        }
        Action::Prepare {
            source,
            name,
            scope,
            installed_version,
            target_name,
            request_id,
            confirm,
        } => {
            ensure!(*confirm, "plugin_migration_explicit_confirmation_required");
            private_profile(context)?;
            let selected = source::select(
                context,
                source,
                name,
                scope,
                installed_version.as_deref(),
                cancel,
            )?;
            let store = PluginMigrationStore::open(&context.profile)?;
            Ok(public(&store.prepare_named(
                request_id,
                &selected,
                target_name.as_deref(),
            )?))
        }
        Action::Records { cursor } => records(context, cursor.as_deref()),
        Action::Read { operation_id } => {
            let store = existing(context)?;
            observed(&store, &store.read(operation_id, cancel)?)
        }
        Action::Capture {
            operation_id,
            expected_sequence,
            confirm,
        } => {
            ensure!(*confirm, "plugin_migration_explicit_confirmation_required");
            Ok(public(&existing(context)?.capture(
                operation_id,
                *expected_sequence,
                cancel,
            )?))
        }
        Action::Resume {
            operation_id,
            expected_sequence,
        } => Ok(public(
            &existing(context)?.resume(operation_id, *expected_sequence)?,
        )),
        Action::Cancel {
            operation_id,
            expected_sequence,
        } => Ok(public(
            &existing(context)?.cancel(operation_id, *expected_sequence)?,
        )),
        Action::Undo {
            operation_id,
            expected_sequence,
            confirm,
        } => {
            ensure!(*confirm, "plugin_migration_explicit_confirmation_required");
            Ok(public(&existing(context)?.undo(
                operation_id,
                *expected_sequence,
                cancel,
            )?))
        }
    }
}
pub(super) fn run(action: &Action, context: &Context) -> Result<()> {
    let stopped = Arc::new(AtomicBool::new(false));
    let probe = stopped.clone();
    let cancel =
        PluginCancellationToken::default().with_probe(move || probe.load(Ordering::Acquire));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()?;
    let signal = runtime.spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            stopped.store(true, Ordering::Release);
        }
    });
    let result = runtime
        .block_on(async { tokio::task::block_in_place(|| execute(action, context, &cancel)) });
    signal.abort();
    let value = result.map_err(|e| anyhow::anyhow!(super::guide::safe_error(&e)))?;
    super::batch::print(&value)
}
