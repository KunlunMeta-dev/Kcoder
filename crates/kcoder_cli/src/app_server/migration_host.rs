//! CLI authority for migration's live configuration and detached history candidates.
use super::engine_factory::AppServerEngineFactory;
use anyhow::{Context, Result, ensure};
use futures::future::LocalBoxFuture;
use kcoder_app_protocol::{MetadataUpdate, ThreadMetadataUpdateParams};
use kcoder_engine::historical_context_projection::HistoricalModelProjectionOutcome;
use kcoder_migration::{
    discovery::DiscoveryRoots,
    history_context_preparations::{HistoryPreparationOutcome, HistoryPreparationProgress},
    history_continuation_jobs::ContinuationRun,
};
use kcoder_migration_rpc::host::MigrationHost;
use kcoder_state::historical_contexts::HistoricalContextStore;
use kcoder_types::historical_continuation::{
    HistoricalContinuationSource, HistoricalContinuationStage as Stage,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

impl MigrationHost for AppServerEngineFactory {
    fn clone_host(&self) -> Arc<dyn MigrationHost> {
        Arc::new(self.clone())
    }
    fn migration_source_roots(&self) -> Result<DiscoveryRoots> {
        self.migration_source_roots()
    }
    fn hook_user_settings_path(&self) -> Result<PathBuf> {
        self.hook_user_settings_path()
    }
    fn migration_user_settings_path(&self) -> Result<PathBuf> {
        self.migration_user_settings_path()
    }
    fn migration_mcp_settings_path(&self) -> Result<PathBuf> {
        self.migration_mcp_settings_path()
    }
    fn migration_project_settings_path(&self, fields: &[&str]) -> Result<PathBuf> {
        self.migration_project_settings_path(fields)
    }
    fn migration_project_target_context(&self) -> (PathBuf, Option<PathBuf>) {
        self.migration_project_target_context()
    }
    fn current_settings(&self) -> Result<kcoder_config::Settings> {
        self.current_settings()
    }
    fn current_skills(&self) -> Result<kcoder_skills::SkillRegistry> {
        self.current_skills()
    }
    fn current_mcp_names(&self) -> Result<Vec<String>> {
        Ok(self
            .current_mcp_servers()?
            .into_iter()
            .map(|server| server.config.name)
            .collect())
    }
    fn continuation_workspace(&self) -> &Path {
        self.continuation_workspace()
    }
    fn continuation_source(&self, thread_id: &str) -> Result<Option<HistoricalContinuationSource>> {
        self.continuation_source(thread_id)
    }
    fn continue_history<'a>(
        &'a self,
        profile: &'a Path,
        run: &'a mut ContinuationRun<'_>,
        token: &'a CancellationToken,
    ) -> LocalBoxFuture<'a, Result<()>> {
        futures::FutureExt::boxed_local(execute_run(self, profile, run, token))
    }
}

fn active(run: &mut ContinuationRun<'_>, token: &CancellationToken) -> Result<bool> {
    Ok(!token.is_cancelled() && !run.cancelled()?)
}
async fn execute_run(
    factory: &AppServerEngineFactory,
    profile: &Path,
    run: &mut ContinuationRun<'_>,
    token: &CancellationToken,
) -> Result<()> {
    if !active(run, token)? {
        run.stop(Stage::Cancelled, None)?;
        return Ok(());
    }
    let view = run.view().clone();
    let target = run.target().cloned();
    let candidate = factory.continuation_candidate(&view.options, target.as_ref());
    tokio::pin!(candidate);
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    let (engine, target) = loop {
        tokio::select! {
            result=&mut candidate=>break result?,
            _=interval.tick()=>{if !active(run,token)? {run.stop(Stage::Cancelled,None)?;return Ok(())}}
        }
    };
    run.reserve_target(target)?;
    let history_path = engine
        .state
        .history_path()
        .context("continuation_history_disabled")?;
    ensure!(
        engine.session_lease_target() == history_path,
        "historical_undo_wrong_owner"
    );
    let lease = kcoder_state::historical_undo::HistoricalUndoLease::try_acquire(
        &history_path,
        &engine.client_storage_root(),
        &engine.session_id(),
    )?;
    if let Some(binding) = run.binding().cloned() {
        let path = engine
            .state
            .history_path()
            .ok_or_else(|| anyhow::anyhow!("continuation_history_disabled"))?;
        if path.exists() {
            engine.state.resume_from_history(&path)?;
            let receipt = engine.state.reconcile_historical_seed(&binding)?;
            let seal = publication_undo_seal(&lease, &receipt.binding, run, token);
            run.imported_with_undo(receipt, seal)?;
            return Ok(());
        }
        if matches!(view.stage, Stage::Publishing | Stage::PublishUnknown) {
            anyhow::bail!("continuation_publication_unconfirmed")
        }
    }
    let mode = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("continuation_settings_unavailable"))?
        .permission_mode;
    super::record_thread_creation_configuration(
        &engine,
        &engine.session_id(),
        mode,
        run.target()
            .and_then(|target| target.settings_template.as_ref()),
    )?;
    run.stage(Stage::Preparing)?;
    let outcome = kcoder_migration::history_context_preparations::prepare_with_local_attachments(
        profile,
        &view.job_id,
        &view.source_job_id,
        &view.view_id,
        view.policy.clone(),
        &view.options.local_attachments,
        |progress| {
            let bytes = match progress {
                HistoryPreparationProgress::Compiling(value) => value.bytes,
                HistoryPreparationProgress::Copying(value) => value.processed_bytes,
            };
            active(run, token).unwrap_or(false) && run.progress(bytes).is_ok()
        },
    )?;
    let report = match outcome {
        HistoryPreparationOutcome::Blocked(report) => {
            run.compilation(report)?;
            run.stop(Stage::Blocked, None)?;
            return Ok(());
        }
        HistoryPreparationOutcome::Prepared { report, .. } => report,
    };
    run.compilation(report)?;
    if !active(run, token)? {
        run.stop(Stage::Cancelled, None)?;
        return Ok(());
    }
    run.stage(Stage::Admitting)?;
    let prepared = HistoricalContextStore::open_existing(profile)?
        .ok_or_else(|| anyhow::anyhow!("continuation_preparation_missing"))?
        .reader(&view.job_id, |_| active(run, token).unwrap_or(false))?;
    let projection = engine
        .prepare_historical_context(&view.job_id, &prepared, |progress| {
            active(run, token).unwrap_or(false) && run.progress(progress.processed_bytes).is_ok()
        })
        .await?;
    let projection = match projection {
        HistoricalModelProjectionOutcome::Blocked(report) => {
            run.admission(report, None)?;
            run.stop(Stage::Blocked, None)?;
            return Ok(());
        }
        HistoricalModelProjectionOutcome::Ready(projection) => *projection,
    };
    run.admission(
        projection.report().clone(),
        Some(projection.binding().clone()),
    )?;
    if !active(run, token)? {
        run.stop(Stage::Cancelled, None)?;
        return Ok(());
    }
    engine.activate_client_session();
    let archive = kcoder_migration::history_jobs::HistoryJobStore::open_existing(profile)?
        .ok_or_else(|| anyhow::anyhow!("continuation_source_missing"))?
        .archive_reader(&view.source_job_id)?;
    let origin = archive.origin();
    let title: String = origin
        .title
        .as_deref()
        .unwrap_or(&origin.source_session_id)
        .chars()
        .filter(|character| !character.is_control())
        .take(200)
        .collect();
    let title = if title.trim().is_empty() {
        origin.source_session_id.clone()
    } else {
        title
    };
    super::thread_metadata::update_historical_thread_metadata(
        &engine,
        ThreadMetadataUpdateParams {
            thread_id: engine.session_id(),
            title: MetadataUpdate::Set(title),
            model: MetadataUpdate::Unchanged,
            archived_at: MetadataUpdate::Unchanged,
            parent: MetadataUpdate::Unchanged,
        },
        &lease,
    )?;
    run.stage(Stage::Publishing)?;
    let receipt = engine
        .publish_prepared_historical_context(projection, |_| active(run, token).unwrap_or(false))?;
    let seal = publication_undo_seal(&lease, &receipt.binding, run, token);
    run.imported_with_undo(receipt, seal)?;
    Ok(())
}
fn publication_undo_seal(
    lease: &kcoder_state::historical_undo::HistoricalUndoLease,
    binding: &kcoder_types::historical_context::HistoricalSessionSeedBinding,
    run: &mut ContinuationRun<'_>,
    token: &CancellationToken,
) -> Option<kcoder_types::historical_undo::HistoricalUndoSealReceipt> {
    match kcoder_state::historical_undo::seal_historical_session(lease, binding, |_| {
        active(run, token).unwrap_or(false)
    }) {
        Ok(seal) => Some(seal),
        Err(error) => {
            // Publication is already authoritative. Undo readiness cannot turn it into a replayable failure.
            tracing::warn!(%error, "historical session published without an available undo seal");
            None
        }
    }
}
