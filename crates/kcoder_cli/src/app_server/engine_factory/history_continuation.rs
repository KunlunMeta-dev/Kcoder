use super::*;
use anyhow::ensure;
use kcoder_config::PrivateDirectory;
use kcoder_migration::history_continuation_jobs::ContinuationTarget;
use kcoder_types::historical_continuation::HistoricalContinuationOptions;
use std::path::Path;
fn directory(path: &Path, create: bool) -> Result<PrivateDirectory> {
    let value = if create {
        PrivateDirectory::open_or_create(path)?
    } else {
        PrivateDirectory::open_existing(path)?
    };
    value.verify_trusted_config_directory()?;
    Ok(value)
}
impl AppServerEngineFactory {
    pub fn continuation_source(
        &self,
        thread_id: &str,
    ) -> Result<Option<kcoder_types::historical_continuation::HistoricalContinuationSource>> {
        let directory = self
            .history_directory
            .as_deref()
            .context("continuation_history_disabled")?;
        let path = super::super::candidate_thread_history_path(directory, thread_id)?;
        // An ordinary fresh thread can have no history yet; observation must not create it.
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            Ok(metadata) => ensure!(
                metadata.file_type().is_file(),
                "continuation_invalid_history"
            ),
        }
        let Some(source) = AppState::historical_source_for_path(&path, thread_id)? else {
            return Ok(None);
        };
        let cwd = kcoder_state::history_persisted_base_cwd(&path)?
            .context("continuation_workspace_missing")?;
        ensure!(
            std::fs::canonicalize(cwd)? == std::fs::canonicalize(&self.cwd)?,
            "continuation_workspace_changed"
        );
        Ok(Some(source))
    }

    pub fn continuation_workspace(&self) -> &Path {
        &self.cwd
    }
    /// Detached migration candidates start no Hook, user turn or resident runtime.
    pub fn continuation_candidate<'a>(
        &'a self,
        options: &'a HistoricalContinuationOptions,
        target: Option<&'a ContinuationTarget>,
    ) -> futures::future::BoxFuture<'a, Result<(QueryEngine, ContinuationTarget)>> {
        Box::pin(self.continuation_candidate_producer(options, target))
    }
    async fn continuation_candidate_producer(
        &self,
        options: &HistoricalContinuationOptions,
        target: Option<&ContinuationTarget>,
    ) -> Result<(QueryEngine, ContinuationTarget)> {
        let template = if let Some(target) = target {
            target
                .settings_template
                .as_ref()
                .map(|binding| {
                    super::super::config_templates::user_template_store()?
                        .recorded_session_path(binding)
                        .map(|path| (path, binding.clone()))
                })
                .transpose()?
        } else {
            match options.settings_template.as_deref() {
                Some(id) => Some(super::super::resolve_session_template(id)?),
                None => super::super::config_templates::default_session_template()?,
            }
        };
        let factory = match template.as_ref() {
            Some((path, _)) => {
                self.with_settings_template(path.clone())
                    .refreshed()
                    .await?
            }
            None => self.refreshed().await?,
        };
        let state = if let Some(target) = target {
            let state = AppState::for_reserved_historical_session(
                &factory.cwd,
                &factory.short_id_registry,
                &target.session_id,
            )?;
            let parent = factory
                .history_directory
                .as_ref()
                .context("continuation_history_disabled")?;
            ensure!(
                factory.base_settings.history_enabled,
                "continuation_history_disabled"
            );
            let path = parent.join(format!("{}.jsonl", target.session_id));
            if path.exists() {
                // Load the durable session before building: the build may
                // write session metadata (tool selection), and a fresh state
                // would overwrite newer goal or session settings.
                state.resume_from_history(&path)?;
            } else {
                state.with_deferred_history_path(path);
            }
            state
        } else {
            factory.new_state()?
        };
        let existing = state.history_path().is_some_and(|path| path.exists());
        let engine = factory.build(state, Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
        if !existing {
            if let Some(model) = options.model.as_deref() {
                engine.select_client_model(model)?;
            }
            engine
                .state
                .set_studio_work_mode_before_first_message(options.studio_work_mode)?;
        }
        let path = engine
            .state
            .history_path()
            .context("continuation_history_disabled")?;
        let history = path.parent().context("continuation_history_disabled")?;
        let artifacts = engine.client_storage_root();
        let history_dir = directory(history, target.is_none())?;
        let artifact_dir = directory(&artifacts, target.is_none())?;
        let observed = ContinuationTarget {
            settings_template: template.map(|(_, binding)| binding),
            session_id: engine.session_id(),
            history_directory: std::fs::canonicalize(history)?,
            history_identity: history_dir.directory_identity()?,
            artifact_directory: std::fs::canonicalize(artifacts)?,
            artifact_identity: artifact_dir.directory_identity()?,
        };
        if let Some(target) = target {
            ensure!(*target == observed, "continuation_target_changed")
        }
        Ok((engine, observed))
    }
}
