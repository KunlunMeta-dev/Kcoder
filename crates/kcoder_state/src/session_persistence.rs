use super::*;
use crate::task_state::persistable_delegated_tasks;

/// Output recorded on a managed background task whose owning process exited
/// while it ran. Its outcome is unknown: neither success nor failed work.
pub const PROCESS_EXIT_TASK_INTERRUPTION: &str =
    "task was interrupted because its owning KCoder process exited";

impl AppState {
    /// Bind Studio intent once. Runtime entrypoints must separately authorize each turn.
    pub fn set_studio_work_mode_before_first_message(
        &self,
        mode: kcoder_types::StudioWorkMode,
    ) -> anyhow::Result<()> {
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        if inner.studio_work_mode == mode {
            return Ok(());
        }
        let durable_history_started = inner.history_path.as_ref().is_some_and(|path| {
            std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
        });
        anyhow::ensure!(
            !inner.conversation_started && inner.messages.is_empty() && !durable_history_started,
            "Studio work mode is immutable after the first message; create a new conversation to switch modes"
        );
        if inner.history_path.is_some() {
            require_history_source(&inner)?;
        }
        let previous = inner.studio_work_mode;
        inner.studio_work_mode = mode;
        if let Some(path) = inner.session_state_path.clone() {
            let state = PersistedSessionState::from_inner(&inner);
            let result = match inner.history_source.as_ref() {
                Some(source) => source.write_metadata(&path, || {
                    prepare_legacy_session_state_write(&path, state.clone())
                }),
                None => write_session_state(&path, &state),
            };
            if let Err(error) = result {
                if crate::history_store::is_uncertain_mutation(&error) {
                    inner.history_write_fault = Some(format!("{error:#}"));
                } else {
                    inner.studio_work_mode = previous;
                }
                return Err(error)
                    .with_context(|| format!("failed to persist Studio work mode to {path:?}"));
            }
        }
        Ok(())
    }

    /// Freeze the non-secret Studio tool surface for this session.
    pub fn bind_studio_tool_selection_once(
        &self,
        selection: kcoder_types::StudioToolSelections,
    ) -> anyhow::Result<()> {
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        if inner.studio_tool_selection.as_ref() == Some(&selection) {
            return Ok(());
        }
        anyhow::ensure!(
            inner.studio_tool_selection.is_none(),
            "Studio tool selection is immutable for an existing session"
        );
        if inner.history_path.is_some() {
            require_history_source(&inner)?;
        }
        let previous = inner.studio_tool_selection.clone();
        inner.studio_tool_selection = Some(selection);
        if let Some(path) = inner.session_state_path.clone() {
            let state = PersistedSessionState::from_inner(&inner);
            let result = match inner.history_source.as_ref() {
                Some(source) => source.write_metadata(&path, || {
                    prepare_legacy_session_state_write(&path, state.clone())
                }),
                None => write_session_state(&path, &state),
            };
            if let Err(error) = result {
                if crate::history_store::is_uncertain_mutation(&error) {
                    inner.history_write_fault = Some(format!("{error:#}"));
                } else {
                    inner.studio_tool_selection = previous;
                }
                return Err(error).with_context(|| {
                    format!("failed to persist Studio tool selection to {path:?}")
                });
            }
        }
        Ok(())
    }

    pub fn studio_tool_selection(&self) -> Option<kcoder_types::StudioToolSelections> {
        self.read_inner().studio_tool_selection.clone()
    }

    pub fn studio_work_mode(&self) -> kcoder_types::StudioWorkMode {
        self.read_inner().studio_work_mode
    }

    /// Persist selection intent without changing the resolved model snapshot.
    pub fn set_model_selection_mode(
        &self,
        mode: kcoder_types::ModelSelectionMode,
    ) -> anyhow::Result<()> {
        self.update_model_selection(mode, None)
    }

    /// Atomically persist the mode and last resolved provider-qualified model.
    pub fn set_model_selection(
        &self,
        mode: kcoder_types::ModelSelectionMode,
        selected: Option<String>,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            selected
                .as_ref()
                .is_none_or(|value| !value.trim().is_empty()),
            "Selected model must not be empty"
        );
        self.update_model_selection(mode, Some(selected))
    }

    fn update_model_selection(
        &self,
        mode: kcoder_types::ModelSelectionMode,
        selected: Option<Option<String>>,
    ) -> anyhow::Result<()> {
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        if inner.history_path.is_some() {
            require_history_source(&inner)?;
        }
        let selected = selected.unwrap_or_else(|| inner.selected_model.clone());
        let previous = (inner.model_selection_mode, inner.selected_model.clone());
        if previous.0 == mode && previous.1 == selected {
            return Ok(());
        }
        inner.model_selection_mode = mode;
        inner.selected_model = selected;
        if let Some(path) = inner.session_state_path.clone() {
            let state = PersistedSessionState::from_inner(&inner);
            let write = || write_session_state(&path, &state);
            let result = match inner.history_source.as_ref() {
                Some(source) => source.write_metadata(&path, || {
                    prepare_legacy_session_state_write(&path, state.clone())
                }),
                None => write(),
            };
            if let Err(error) = result {
                if crate::history_store::is_uncertain_mutation(&error) {
                    inner.history_write_fault = Some(format!("{error:#}"));
                } else {
                    inner.model_selection_mode = previous.0;
                    inner.selected_model = previous.1;
                }
                return Err(error).with_context(|| {
                    format!("failed to persist model selection mode to {:?}", path)
                });
            }
        }
        Ok(())
    }

    pub fn selected_model(&self) -> Option<String> {
        self.read_inner().selected_model.clone()
    }

    pub fn model_selection_mode(&self) -> kcoder_types::ModelSelectionMode {
        self.read_inner().model_selection_mode
    }

    /// Return the sole authoritative session-level mode.
    pub fn session_mode(&self) -> SessionMode {
        self.read_inner().session_mode
    }

    pub fn workflow_definition_id(&self) -> Option<String> {
        self.read_inner().workflow_definition_id.clone()
    }

    /// Bind a design conversation once; the binding survives recovery and forks.
    pub fn bind_workflow_definition_before_first_message(&self, id: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            !id.is_empty()
                && id.len() <= 64
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
            "Invalid workflow definition ID"
        );
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        anyhow::ensure!(
            inner.session_mode == SessionMode::WorkflowDraft,
            "Workflow binding requires a workflow design session"
        );
        if inner.workflow_definition_id.as_deref() == Some(id) {
            return Ok(());
        }
        anyhow::ensure!(
            inner.workflow_definition_id.is_none(),
            "Workflow binding is immutable"
        );
        anyhow::ensure!(
            !inner.conversation_started && inner.messages.is_empty(),
            "Bind the workflow before the first message"
        );
        if inner.history_path.is_some() {
            require_history_source(&inner)?;
        }
        inner.workflow_definition_id = Some(id.into());
        if let Some(path) = inner.session_state_path.clone() {
            let state = PersistedSessionState::from_inner(&inner);
            let result = match inner.history_source.as_ref() {
                Some(source) => source.write_metadata(&path, || {
                    prepare_legacy_session_state_write(&path, state.clone())
                }),
                None => write_session_state(&path, &state),
            };
            if let Err(error) = result {
                if crate::history_store::is_uncertain_mutation(&error) {
                    inner.history_write_fault = Some(format!("{error:#}"));
                } else {
                    inner.workflow_definition_id = None;
                }
                return Err(error).context("Failed to persist workflow conversation binding");
            }
        }
        Ok(())
    }

    /// Enter orchestration session mode only before the first conversation message is written.
    ///
    /// Return true when this call performs the transition and false when the mode was
    /// already active. State checking, mutation, and sidecar writing share one critical
    /// section, and persistence failure rolls back the transition.
    pub fn enter_orchestrate_before_first_message(&self) -> anyhow::Result<bool> {
        self.enter_session_mode_before_first_message(SessionMode::Orchestrate)
    }

    pub fn enter_workflow_draft_before_first_message(&self) -> anyhow::Result<bool> {
        self.enter_session_mode_before_first_message(SessionMode::WorkflowDraft)
    }

    /// Select an immutable creation mode, including when inheriting a fork source.
    pub fn enter_session_mode_before_first_message(
        &self,
        target: SessionMode,
    ) -> anyhow::Result<bool> {
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        if inner.session_mode == target {
            return Ok(false);
        }
        anyhow::ensure!(
            inner.session_mode.is_default(),
            "Session mode is immutable; start a new session"
        );
        if inner.history_path.is_some() {
            require_history_source(&inner)?;
        }
        let durable_history_started = inner.history_path.as_ref().is_some_and(|path| {
            std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
        });
        if inner.conversation_started || !inner.messages.is_empty() || durable_history_started {
            anyhow::bail!("{target:?} mode can only be entered before the first message");
        }

        inner.session_mode = target;
        if let Some(path) = inner.session_state_path.clone() {
            let state = PersistedSessionState::from_inner(&inner);
            let write = || write_session_state(&path, &state);
            let result = match inner.history_source.as_ref() {
                Some(source) => source.write_metadata(&path, || {
                    prepare_legacy_session_state_write(&path, state.clone())
                }),
                None => write(),
            };
            if let Err(error) = result {
                if crate::history_store::is_uncertain_mutation(&error) {
                    inner.history_write_fault = Some(format!("{error:#}"));
                } else {
                    inner.session_mode = SessionMode::Default;
                }
                return Err(error).with_context(|| {
                    format!("failed to persist {target:?} session mode to {:?}", path)
                });
            }
        }
        Ok(true)
    }

    /// Enable persistent history writing to the given path and start a
    /// background flusher that batches disk writes.
    pub fn with_history_path(&self, path: impl Into<PathBuf>) {
        let _persist = self.lock_session_state_persistence();
        {
            let mut inner = self.write_inner();
            Self::install_history_path(&mut inner, path.into());
        }
        self.persist_latest_session_state_locked();
    }

    /// Configure history/flushing for an uncommitted runtime without creating a session sidecar.
    ///
    /// A candidate app-server engine commits explicitly after model validation and lease
    /// acquisition, so a failed `thread/start` cannot leave an invisible empty session on disk.
    pub fn with_deferred_history_path(&self, path: impl Into<PathBuf>) {
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        Self::install_history_path(&mut inner, path.into());
    }

    /// Commit the complete session sidecar for the current runtime.
    pub fn commit_session_state(&self) {
        self.persist_latest_session_state();
    }

    /// Reread the latest state and commit a complete sidecar snapshot under the
    /// persistence mutex. Callers must not pass field snapshots captured before locking.
    pub(super) fn persist_latest_session_state(&self) {
        let _persist = self.lock_session_state_persistence();
        self.persist_latest_session_state_locked();
    }

    /// The caller must already hold `session_state_persist_lock`.
    pub(super) fn persist_latest_session_state_locked(&self) {
        if let Err(error) = self.try_persist_latest_session_state_locked() {
            warn!("failed to persist session state: {error}");
        }
    }

    /// Fallible authority boundary for mutations that report successful commit.
    pub(super) fn try_persist_latest_session_state_locked(&self) -> anyhow::Result<()> {
        let (path, mut state, source, imported) = {
            let inner = self.read_inner();
            check_direct_history_fault(&inner)?;
            anyhow::ensure!(
                inner.history_path.is_none() || inner.history_source.is_some(),
                "cannot persist a session sidecar without a bound history source"
            );
            (
                inner.session_state_path.clone(),
                PersistedSessionState::from_inner(&inner),
                inner.history_source.clone(),
                inner
                    .imported_context_snapshot
                    .as_ref()
                    .filter(|_| inner.imported_context_persisted_at != inner.session_state_path)
                    .map(Arc::clone),
            )
        };
        if imported.is_some() {
            let inner = self.read_inner();
            state.imported_context_snapshot =
                inner.imported_context_reference.as_ref().map(|reference| {
                    reference.for_session(&imported_context_snapshot::session_for(&inner))
                });
        }
        maybe_wait_before_session_state_write(
            Arc::as_ptr(&self.session_state_persist_lock) as usize,
            path.as_deref(),
        );
        let mut native_goal_projection = None;
        if let Some(path) = path {
            match source {
                Some(source) => source.write_metadata(&path, || {
                    if let Some(snapshot) = &imported {
                        imported_context_snapshot::publish(
                            &path,
                            state
                                .imported_context_snapshot
                                .as_ref()
                                .expect("reference for captured context")
                                .session_id(),
                            snapshot,
                        )?;
                    }
                    let (bytes, projection) =
                        prepare_legacy_session_state_with_native_goal(&path, state.clone())?;
                    native_goal_projection = projection;
                    Ok(bytes)
                })?,
                None => write_session_state(&path, &state)?,
            }
            if imported.is_some() {
                self.write_inner().imported_context_persisted_at = Some(path);
            }
        }
        if let Some(projection) = native_goal_projection {
            let mut inner = self.write_inner();
            if let Some(goal) = inner.goal.as_mut()
                && goal.goal_id == projection.goal_id
                && goal.created_at_ms == projection.created_at_ms
            {
                *goal = projection;
            }
        }
        Ok(())
    }

    /// Start a genuinely independent chat while retaining the current cwd.
    ///
    /// In particular, this rotates the durable transcript path. Merely
    /// clearing `messages` would keep appending the new chat to a resumed
    /// session's JSONL file.
    pub fn start_new_session(&self) -> anyhow::Result<()> {
        let id = self.reserve_new_session_id()?;
        self.start_new_session_with_reserved_id(id);
        Ok(())
    }

    pub fn start_new_session_with_reserved_id(&self, id: ReservedSessionId) {
        let _ = self.start_new_session_with_reserved_id_and_lifecycle(id);
    }

    /// Return the original lifecycle created while holding the replacement lock.
    pub fn start_new_session_with_reserved_id_and_lifecycle(
        &self,
        id: ReservedSessionId,
    ) -> crate::AppStateLifecycleIdentity {
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        let session_id = id.0;
        let history_path = inner
            .history_path
            .as_ref()
            .and_then(|path| path.parent())
            .map(|dir| {
                dir.join(format!(
                    "{}.jsonl",
                    crate::artifact_id_path_component(&session_id)
                ))
            });

        if let Some(location) = inner.session_artifact_override.as_mut() {
            location.session_id = session_id.clone();
        }

        inner.session_id = session_id;
        inner.inherited_context_archive = None;
        inner.session_created_at_ms = now_millis();
        inner.session_updated_at_ms = inner.session_created_at_ms;
        inner.session_mode = SessionMode::Default;
        inner.studio_work_mode = Default::default();
        inner.studio_tool_selection = None;
        inner.agent_definition = None;
        inner.agent_configuration_revision = 0;
        inner.session_lifetime = Default::default();
        inner.channel_task_source = None;
        inner.workflow_definition_id = None;
        inner.model_selection_mode = Default::default();
        inner.selected_model = None;
        inner.conversation_started = false;
        inner.message_revision = crate::MessageRevision::default();
        inner.messages.clear();
        inner.message_history_ids.clear();
        inner.history_attempts = Default::default();
        inner.last_history_uuid = None;
        inner.last_assistant_message_timestamp_ms = None;
        inner.llm_request_history_override = None;
        inner.todos.clear();
        inner.tasks.clear();
        inner.plan_mode = None;
        inner.goal = None;
        inner.goal_history.clear();
        inner.session_memory = None;
        inner.imported_context_snapshot = None;
        inner.imported_context_reference = None;
        inner.imported_context_persisted_at = None;
        inner.imported_context_legacy_unobserved = false;
        inner.file_reads.clear();
        inner.full_file_reads.clear();
        inner.read_tool_call_keys.clear();
        inner.active_worktree = None;

        if let Some(path) = history_path {
            Self::install_history_path(&mut inner, path);
        } else {
            inner.history_flusher = None;
            inner.history_source = None;
            inner.history_write_fault = None;
            inner.history_path = None;
            inner.session_state_path = None;
        }
        let owner = crate::history_append_context::lifecycle_identity_locked(self, &inner);
        drop(inner);
        self.persist_latest_session_state_locked();
        owner
    }
    pub(super) fn install_history_path(inner: &mut AppStateInner, path: PathBuf) {
        if inner
            .history_path
            .as_deref()
            .is_some_and(|current| same_history_path(current, &path))
        {
            if let Some(fault) = inner
                .history_flusher
                .as_ref()
                .and_then(|flusher| flusher.queue.write_fault())
            {
                inner.history_write_fault = Some(fault);
            }
            return;
        }
        inner.history_write_fault = None;
        // Replacing the sender lets any old flusher drain and exit while future
        // entries go to the newly active session history file.
        let private_storage = inner
            .history_source
            .as_ref()
            .and_then(HistorySource::private_storage);
        inner.history_flusher = None;
        inner.history_source = None;
        inner.history_path = Some(path.clone());
        let artifact_session_id =
            session_id_from_history_path(&path).unwrap_or_else(|_| inner.session_id.clone());
        let session_state_path = path
            .parent()
            .map(|project_dir| session_state_path(project_dir, &artifact_session_id));
        inner.session_state_path = session_state_path.clone();
        inner.last_history_uuid = last_transcript_uuid(&path).unwrap_or(None);
        match HistorySource::bind(&path) {
            Ok(source) => {
                if let Some(storage) =
                    private_storage.filter(|storage| path.starts_with(storage.path()))
                {
                    source.retain_private_storage(storage);
                }
                inner.history_source = Some(source.clone());
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    inner.history_flusher = Some(start_history_flusher(handle, path, source));
                }
            }
            Err(error) => {
                inner.history_write_fault =
                    Some(format!("failed to bind history source: {error:#}"))
            }
        }
    }

    fn install_prepared_history_path(
        inner: &mut AppStateInner,
        path: PathBuf,
        last_history_uuid: Option<String>,
        source: HistorySource,
    ) {
        if let Some(storage) = inner
            .history_source
            .as_ref()
            .and_then(HistorySource::private_storage)
            .filter(|storage| path.starts_with(storage.path()))
        {
            source.retain_private_storage(storage);
        }
        inner.history_write_fault = None;
        inner.history_flusher = None;
        inner.history_source = Some(source.clone());
        inner.history_path = Some(path.clone());
        let artifact_session_id =
            session_id_from_history_path(&path).unwrap_or_else(|_| inner.session_id.clone());
        inner.session_state_path = path
            .parent()
            .map(|project_dir| session_state_path(project_dir, &artifact_session_id));
        inner.last_history_uuid = last_history_uuid;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            inner.history_flusher = Some(start_history_flusher(handle, path, source));
        }
    }

    /// Change the current working directory used by tools.
    pub fn set_cwd(&self, cwd: impl Into<PathBuf>) {
        let _persist = self.lock_session_state_persistence();
        {
            let mut inner = self.write_inner();
            inner.cwd = cwd.into();
        }
        self.persist_latest_session_state_locked();
    }

    /// Get the original working directory used to start the session.
    pub fn base_cwd(&self) -> PathBuf {
        self.read_inner().base_cwd.clone()
    }

    /// Mark that the session has entered a worktree.
    pub fn enter_worktree_session(
        &self,
        original_cwd: impl Into<PathBuf>,
        worktree_path: impl Into<PathBuf>,
        worktree_name: impl Into<String>,
        worktree_branch: Option<String>,
        original_head_commit: Option<String>,
        created_by_session: bool,
    ) -> WorktreeSessionState {
        let _persist = self.lock_session_state_persistence();
        let session = WorktreeSessionState {
            original_cwd: original_cwd.into(),
            worktree_path: worktree_path.into(),
            worktree_name: worktree_name.into(),
            worktree_branch,
            original_head_commit,
            created_by_session,
        };
        {
            let mut inner = self.write_inner();
            inner.cwd = session.worktree_path.clone();
            inner.active_worktree = Some(session.clone());
        }
        self.persist_latest_session_state_locked();
        session
    }

    /// Get the active worktree metadata for this session, if any.
    pub fn active_worktree(&self) -> Option<WorktreeSessionState> {
        self.read_inner().active_worktree.clone()
    }

    /// Restore the working directory to the pre-worktree directory when a
    /// session worktree is active; otherwise restore the original session root.
    pub fn exit_worktree(&self) -> Option<WorktreeSessionState> {
        let _persist = self.lock_session_state_persistence();
        let session = {
            let mut inner = self.write_inner();
            if let Some(session) = inner.active_worktree.take() {
                inner.cwd = session.original_cwd.clone();
                Some(session)
            } else {
                let base = inner.base_cwd.clone();
                inner.cwd = base;
                None
            }
        };
        self.persist_latest_session_state_locked();
        session
    }

    pub fn session_memory(&self) -> Option<SessionMemorySnapshot> {
        self.read_inner().session_memory.clone()
    }

    pub fn set_session_memory(&self, snapshot: SessionMemorySnapshot) {
        let _persist = self.lock_session_state_persistence();
        {
            let mut inner = self.write_inner();
            inner.session_memory = Some(snapshot);
        }
        self.persist_latest_session_state_locked();
    }

    pub fn clear_session_memory(&self) {
        let _persist = self.lock_session_state_persistence();
        {
            let mut inner = self.write_inner();
            inner.session_memory = None;
        }
        self.persist_latest_session_state_locked();
    }

    /// Replace the current conversation with messages loaded from a history file.
    ///
    /// The resumed history file becomes the live session. A resumed session
    /// keeps its durable session id, sidecar state, and append target instead of
    /// continuing under a fresh runtime id.
    pub fn resume_from_history(&self, path: &Path) -> anyhow::Result<usize> {
        self.apply_prepared_session_resume(prepare_session_resume(path)?)
    }

    /// Apply an already parsed recovery snapshot without rereading its source file.
    /// Commit the sidecar before replacing live memory so persistence failure leaves the current session unchanged.
    pub fn apply_prepared_session_resume(
        &self,
        prepared: PreparedSessionResume,
    ) -> anyhow::Result<usize> {
        self.apply_prepared_session_resume_with_lifecycle(prepared)
            .map(|(count, _)| count)
    }

    /// Return the lifecycle from the exact lock that installed this resume.
    pub fn apply_prepared_session_resume_with_lifecycle(
        &self,
        prepared: PreparedSessionResume,
    ) -> anyhow::Result<(usize, crate::AppStateLifecycleIdentity)> {
        let _persist = self.lock_session_state_persistence();
        let PreparedSessionResume {
            session_id: resumed_session_id,
            path,
            source_stamp,
            messages: history_messages,
            message_history_ids: history_ids,
            history_attempts,
            last_assistant_message_timestamp_ms,
            transcript_history: _,
            last_transcript_uuid,
            mut persisted_state,
        } = prepared;
        crate::migrations::sessions::upgrade_for_resume(&mut persisted_state, &path)?;
        let count = history_messages.len();
        let mut interrupted_outputs = Vec::new();
        // Do not restore former compacted_messages; rebuild compaction state from append-only JSONL boundary records.
        persisted_state.compacted_messages = None;
        let pending_background_ids: HashSet<String> = persisted_state
            .tasks
            .values()
            .flat_map(|task| &task.background_runs)
            .flat_map(|record| {
                record
                    .pending_result_message_id
                    .iter()
                    .chain(record.notification_message_id.iter())
            })
            .cloned()
            .collect();
        let mut committed_background_ids = HashSet::new();
        if !pending_background_ids.is_empty() {
            // The prepared source stamp below fences this observation. Check the raw
            // append-only log so rewind/compaction does not resurrect a delivered result.
            for line in std::io::BufReader::new(fs::File::open(&path)?).lines() {
                let line = line?;
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line)
                    && let Some(id) = value.get("uuid").and_then(serde_json::Value::as_str)
                    && pending_background_ids.contains(id)
                {
                    committed_background_ids.insert(id.to_owned());
                }
            }
        }
        let native_subagent_recovery = persisted_state
            .native_subagent_outbox
            .as_ref()
            .map(|outbox| outbox.recovery_scope());
        for task in persisted_state.tasks.values_mut() {
            for record in &mut task.background_runs {
                if record.delivered_message_id.is_none() {
                    record.delivered_message_id = record
                        .pending_result_message_id
                        .iter()
                        .chain(record.notification_message_id.iter())
                        .find(|id| committed_background_ids.contains(*id))
                        .cloned();
                }
                if record
                    .pending_result_message_id
                    .as_ref()
                    .is_some_and(|id| committed_background_ids.contains(id))
                {
                    record.followup_handled = true;
                }
                // A resumed runtime owns no live tool batch from the old process.
                // Missing tool results remain governed by normal interrupted-tool recovery.
                record.pending_result_message_id = None;
            }
            if task.has_delivery_queue_migration_conflict() {
                anyhow::bail!(
                    "sub-agent {} contains both legacy and reliable delivery queues; session resume refuses to guess FIFO order",
                    task.id
                );
            }
            task.recover_interrupted_deliveries(task.delivery_max_attempts);
            let native_run_unresolved = task.kind == TaskKind::Subagent
                && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
                && task.background_run.as_ref().is_some_and(|run| {
                    native_subagent_recovery.as_ref().is_some_and(|scope| {
                        scope.as_ref().map_or(true, |scope| scope.may_own_run(run))
                    })
                });
            if !native_run_unresolved
                && task.managed
                && matches!(task.kind, TaskKind::Generic | TaskKind::Subagent)
                && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
            {
                let interrupted = PROCESS_EXIT_TASK_INTERRUPTION.to_string();
                task.status = TaskStatus::Failed;
                task.output = Some(interrupted.clone());
                task.updated_at_ms = now_millis();
                if let Some(record) = task.background_run.as_ref().and_then(|key| {
                    task.background_runs
                        .iter_mut()
                        .find(|record| &record.key == key)
                }) && record.terminal.is_none()
                {
                    record.status = TaskStatus::Failed;
                    record.terminal = Some(kcoder_types::BackgroundEventIdentity::terminal(
                        record.key.clone(),
                    ));
                    record.output_snapshot = Some(interrupted.clone());
                    record.output_path = task.output_path.clone();
                }
                if let Some(path) = task.output_path.as_deref() {
                    interrupted_outputs.push((path.to_path_buf(), interrupted));
                }
            }
            crate::background_delivery::migrate_legacy_background_run(task, &resumed_session_id);
        }
        let state_path = path
            .parent()
            .map(|project_dir| session_state_path(project_dir, &resumed_session_id));
        if let Some(registry) = self.short_id_registry() {
            crate::short_id::retain_existing_short_id(&registry, &resumed_session_id)?;
        }
        let restored_imported_context = match (
            &persisted_state.imported_context_snapshot,
            state_path.as_deref(),
        ) {
            (Some(reference), Some(path)) => Some(imported_context_snapshot::load(
                path,
                &resumed_session_id,
                reference,
            )?),
            (None, _) => None,
            _ => anyhow::bail!("imported_context_snapshot_unavailable"),
        };
        // Keep preparation validation, sidecar commit, and replacement under the same
        // state lock so a newly accepted message cannot disappear between these steps.
        let mut inner = self.write_inner();
        if inner
            .history_path
            .as_deref()
            .is_some_and(|current| same_history_path(current, &path))
        {
            check_direct_history_fault(&inner)?;
            if let Some(fault) = inner
                .history_flusher
                .as_ref()
                .and_then(|flusher| flusher.queue.write_fault())
            {
                anyhow::bail!(
                    "cannot resume faulted current history; save an explicit snapshot to recover: {fault}"
                );
            }
            anyhow::ensure!(
                inner.last_history_uuid == last_transcript_uuid,
                "current history changed after resume preparation; flush and prepare it again"
            );
        }
        // Same-path recovery preserves the writer identity instead of silently adopting a new one.
        let source = if inner
            .history_path
            .as_deref()
            .is_some_and(|current| same_history_path(current, &path))
        {
            require_history_source(&inner)?.clone()
        } else {
            HistorySource::bind(&path)?
        };
        // Replay stays outside the short source lock; identity checking and metadata commit do not.
        if let Some(state_path) = state_path.as_deref() {
            source
                .write_prepared_metadata(&source_stamp, state_path, || {
                    prepare_session_state_write(state_path, &persisted_state)
                })
                .with_context(|| {
                    format!("failed to persist prepared session state {state_path:?}")
                })?;
        }

        // Task output is secondary diagnostic state and cannot be created before the authoritative sidecar commits.
        for (output_path, interrupted) in interrupted_outputs {
            if let Some(parent) = output_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(output_path, interrupted.as_bytes());
        }

        {
            inner.session_id = resumed_session_id;
            if inner.history_path.as_ref() != Some(&path) {
                inner.inherited_context_archive = None;
            }
            inner.session_created_at_ms = persisted_state.created_at_ms.unwrap_or_default();
            inner.session_updated_at_ms = persisted_state.updated_at_ms.unwrap_or_default();
            inner.conversation_started =
                persisted_state.conversation_started || !history_messages.is_empty();
            inner.message_revision = crate::MessageRevision::default();
            inner.messages = history_messages.into();
            // These are proofs about the replaced model context, not persistent file state.
            inner.file_reads.clear();
            inner.full_file_reads.clear();
            inner.read_tool_call_keys.clear();
            inner.message_history_ids = history_ids.into();
            inner.history_attempts = history_attempts;
            inner.last_assistant_message_timestamp_ms = last_assistant_message_timestamp_ms;
            inner.session_mode = persisted_state.session_mode;
            inner.studio_work_mode = persisted_state.studio_work_mode;
            inner.studio_tool_selection = persisted_state.studio_tool_selection.clone();
            inner.agent_definition = persisted_state.agent_definition.clone();
            inner.agent_configuration_revision = persisted_state.agent_configuration_revision;
            inner.session_lifetime = persisted_state.session_lifetime;
            inner.channel_task_source = persisted_state.channel_task_source.clone();
            inner.workflow_definition_id = persisted_state.workflow_definition_id;
            inner.model_selection_mode = persisted_state.model_selection_mode;
            inner.selected_model = persisted_state.selected_model;
            inner.goal = persisted_state.goal;
            inner.goal_history = persisted_state.goal_history;
            inner.session_memory = persisted_state.session_memory;
            inner.imported_context_legacy_unobserved = restored_imported_context.as_ref().map_or(inner.conversation_started, |value| value.source == kcoder_types::imported_context_snapshot::ImportedContextSnapshotSource::LegacyUnobserved);
            inner.imported_context_persisted_at =
                restored_imported_context.as_ref().and(state_path.clone());
            inner.imported_context_reference = persisted_state.imported_context_snapshot.clone();
            inner.imported_context_snapshot = restored_imported_context.map(Arc::new);
            inner.tasks = persisted_state.tasks;
            if let Some(base_cwd) = persisted_state.base_cwd {
                inner.base_cwd = base_cwd;
            }
            if let Some(cwd) = persisted_state.cwd {
                inner.cwd = cwd;
            }
            Self::install_prepared_history_path(&mut inner, path, last_transcript_uuid, source);
        }
        Ok((
            count,
            crate::history_append_context::lifecycle_identity_locked(self, &inner),
        ))
    }

    /// Build a serializable snapshot of the current session.
    pub fn snapshot(&self) -> SessionSnapshot {
        let inner = self.read_inner();
        SessionSnapshot {
            session_id: inner.session_id.clone(),
            cwd: inner.cwd.clone(),
            session_mode: inner.session_mode,
            studio_work_mode: inner.studio_work_mode,
            studio_tool_selection: inner.studio_tool_selection.clone(),
            agent_definition: inner.agent_definition.clone(),
            agent_configuration_revision: inner.agent_configuration_revision,
            session_lifetime: inner.session_lifetime,
            channel_task_source: inner.channel_task_source.clone(),
            workflow_definition_id: inner.workflow_definition_id.clone(),
            model_selection_mode: inner.model_selection_mode,
            selected_model: inner.selected_model.clone(),
            conversation_started: inner.conversation_started,
            messages: inner.messages.to_vec(),
            todos: inner.todos.clone(),
            tasks: inner.tasks.clone(),
            plan_mode: inner.plan_mode.clone(),
            goal: inner.goal.clone(),
            goal_history: inner.goal_history.clone(),
            session_memory: inner.session_memory.clone(),
            imported_context_snapshot: inner.imported_context_snapshot.as_deref().cloned(),
            last_assistant_message_timestamp_ms: inner.last_assistant_message_timestamp_ms,
        }
    }

    /// Export the current session snapshot to a JSON file.
    pub fn export_snapshot(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let snapshot = self.snapshot();
        let content = serde_json::to_string_pretty(&snapshot)?;
        fs::write(path, content)?;
        Ok(())
    }

    /// Replace the current session state from a JSON snapshot file.
    ///
    /// The current session id is preserved; the imported state becomes the live
    /// state of the current session.
    pub fn import_snapshot(&self, path: &Path) -> anyhow::Result<usize> {
        let content = fs::read_to_string(path)
            .with_context(|| format!("failed to read snapshot from {:?}", path))?;
        let snapshot: SessionSnapshot = serde_json::from_str(&content)
            .with_context(|| format!("failed to parse snapshot from {:?}", path))?;
        if let Some(context) = &snapshot.imported_context_snapshot {
            imported_context_snapshot::validate(context)?;
        }
        let count = snapshot.messages.len();
        if let Some(task) = snapshot
            .tasks
            .values()
            .find(|task| task.has_delivery_queue_migration_conflict())
        {
            anyhow::bail!(
                "sub-agent {} contains both legacy and reliable delivery queues; snapshot import refuses to guess FIFO order",
                task.id
            );
        }
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        anyhow::ensure!(
            !inner.tasks.values().any(|task| task.managed
                && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)),
            "cannot import a snapshot while managed tasks are running"
        );
        anyhow::ensure!(
            inner
                .imported_context_snapshot
                .as_ref()
                .is_none_or(|old| Some(old.as_ref()) == snapshot.imported_context_snapshot.as_ref()),
            "imported_context_snapshot_binding_changed"
        );
        anyhow::ensure!(
            inner
                .studio_tool_selection
                .as_ref()
                .is_none_or(|selection| {
                    snapshot.studio_tool_selection.as_ref() == Some(selection)
                }),
            "Studio tool selection is immutable for an existing session"
        );
        let mut imported_tasks: HashMap<String, Task> = snapshot
            .tasks
            .into_iter()
            .map(|(id, mut task)| {
                task.recover_interrupted_deliveries(task.delivery_max_attempts);
                crate::background_delivery::migrate_legacy_background_run(
                    &mut task,
                    &snapshot.session_id,
                );
                suppress_imported_background_task(&mut task);
                (id, task)
            })
            .collect();
        let mut imported_state = PersistedSessionState::from_inner(&inner);
        imported_state.session_mode = snapshot.session_mode;
        imported_state.studio_work_mode = snapshot.studio_work_mode;
        imported_state.studio_tool_selection = snapshot.studio_tool_selection.clone();
        imported_state.agent_definition = snapshot.agent_definition.clone();
        imported_state.agent_configuration_revision = snapshot.agent_configuration_revision;
        imported_state.session_lifetime = snapshot.session_lifetime;
        imported_state.channel_task_source = snapshot.channel_task_source.clone();
        imported_state.workflow_definition_id = snapshot.workflow_definition_id.clone();
        imported_state.model_selection_mode = snapshot.model_selection_mode;
        imported_state.selected_model = snapshot.selected_model.clone();
        imported_state.conversation_started =
            snapshot.conversation_started || !snapshot.messages.is_empty();
        imported_state.tasks = imported_tasks.clone();
        imported_state.goal = snapshot.goal.clone();
        imported_state.goal_history = snapshot.goal_history.clone();
        imported_state.session_memory = snapshot.session_memory.clone();
        imported_state.imported_context_snapshot =
            snapshot.imported_context_snapshot.as_ref().map(|value| {
                imported_context_snapshot::SnapshotReference::new(
                    value,
                    &imported_context_snapshot::session_for(&inner),
                )
            });
        if let Some(path) = inner.session_state_path.as_ref() {
            let source = inner
                .history_source
                .as_ref()
                .context("snapshot import has no bound history source")?;
            source.write_metadata(path, || {
                if let Some(context) = &snapshot.imported_context_snapshot {
                    imported_context_snapshot::publish(
                        path,
                        &imported_context_snapshot::session_for(&inner),
                        context,
                    )?;
                }
                let authority = load_session_state(path)?;
                anyhow::ensure!(
                    authority
                        .studio_tool_selection
                        .as_ref()
                        .is_none_or(|selection| {
                            imported_state.studio_tool_selection.as_ref() == Some(selection)
                        }),
                    "Studio tool selection is immutable for an existing session"
                );
                anyhow::ensure!(
                    authority
                        .imported_context_snapshot
                        .as_ref()
                        .is_none_or(|original| imported_state.imported_context_snapshot.as_ref()
                            == Some(original)),
                    "imported_context_snapshot_binding_changed"
                );
                anyhow::ensure!(
                    !authority.tasks.values().any(|task| task.managed
                        && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)),
                    "cannot import a snapshot while managed tasks are running"
                );
                imported_state.native_subagent_outbox = authority.native_subagent_outbox.clone();
                imported_state.background_tombstones = authority.background_tombstones;
                for (id, mut previous) in authority.tasks {
                    if let Some(imported) = imported_state.tasks.get_mut(&id) {
                        for record in previous.background_runs {
                            if let Some(target) = imported
                                .background_runs
                                .iter_mut()
                                .find(|target| target.key == record.key)
                            {
                                *target = record;
                            } else {
                                imported.background_runs.push(record);
                            }
                        }
                        suppress_imported_background_task(imported);
                    } else if !previous.background_runs.is_empty() {
                        suppress_imported_background_task(&mut previous);
                        for record in &mut previous.background_runs {
                            record.output_path = None;
                            record.output_snapshot = None;
                        }
                        imported_state
                            .background_tombstones
                            .insert(id, previous.background_runs);
                    }
                }
                imported_state
                    .tasks
                    .retain(|id, _| !imported_state.background_tombstones.contains_key(id));
                prepare_session_state_write(path, &imported_state)
            })?;
            imported_tasks = imported_state.tasks;
        }
        inner.conversation_started = imported_state.conversation_started;
        inner.message_revision = crate::MessageRevision::default();
        inner.messages = snapshot.messages.into();
        inner.file_reads.clear();
        inner.full_file_reads.clear();
        inner.read_tool_call_keys.clear();
        // Imported provider messages have no identity in this runtime's committed log.
        inner.message_history_ids = vec![None; inner.messages.len()].into();
        inner.history_attempts = Default::default();
        if inner.history_path.is_none() {
            inner.last_history_uuid = None;
        }
        inner.session_mode = snapshot.session_mode;
        inner.studio_work_mode = snapshot.studio_work_mode;
        inner.studio_tool_selection = snapshot.studio_tool_selection.clone();
        inner.agent_definition = snapshot.agent_definition.clone();
        inner.agent_configuration_revision = snapshot.agent_configuration_revision;
        inner.session_lifetime = snapshot.session_lifetime;
        inner.channel_task_source = snapshot.channel_task_source.clone();
        inner.workflow_definition_id = snapshot.workflow_definition_id;
        inner.model_selection_mode = snapshot.model_selection_mode;
        inner.selected_model = snapshot.selected_model;
        inner.todos = snapshot.todos;
        inner.tasks = imported_tasks;
        inner.plan_mode = snapshot.plan_mode;
        inner.goal = snapshot.goal;
        inner.goal_history = snapshot.goal_history;
        inner.session_memory = snapshot.session_memory;
        inner.imported_context_legacy_unobserved = snapshot.imported_context_snapshot.as_ref().map_or(inner.conversation_started, |value| value.source == kcoder_types::imported_context_snapshot::ImportedContextSnapshotSource::LegacyUnobserved);
        inner.imported_context_persisted_at = snapshot
            .imported_context_snapshot
            .as_ref()
            .and(inner.session_state_path.clone());
        inner.imported_context_reference = imported_state.imported_context_snapshot;
        inner.imported_context_snapshot = snapshot.imported_context_snapshot.map(Arc::new);
        inner.last_assistant_message_timestamp_ms = snapshot.last_assistant_message_timestamp_ms;

        Ok(count)
    }
}

fn suppress_imported_background_task(task: &mut Task) {
    for record in &mut task.background_runs {
        record.suppressed = true;
        record.imported_history = true;
        record.followup_handled = true;
        record.pending_result_message_id = None;
    }
    if !task.background_runs.is_empty() {
        task.accepting_subagent_messages = false;
        if matches!(
            task.status,
            TaskStatus::Pending | TaskStatus::Running | TaskStatus::Paused
        ) {
            task.status = TaskStatus::Failed;
            task.output =
                Some("imported task is historical; spawn a new agent to execute".to_owned());
        }
    }
}

pub(super) fn ensure_message_history_ids(inner: &mut AppStateInner) {
    if inner.message_history_ids.len() != inner.messages.len() {
        inner.message_history_ids = vec![None; inner.messages.len()].into();
    }
    if inner.message_history_ids.iter().any(Option::is_none) {
        for id in inner.message_history_ids.iter_mut() {
            if id.is_none() {
                *id = Some(generate_transcript_uuid());
            }
        }
    }
    inner.last_history_uuid = inner.message_history_ids.last().cloned().flatten();
}

pub(super) fn write_history_snapshot<'a>(
    source: &HistorySource,
    session_id: &str,
    messages: impl IntoIterator<Item = &'a Message>,
    message_ids: &[Option<String>],
    history_attempts: &crate::history_append_context::HistoryAppendMetadata,
    inherited: Option<&crate::context_archive::InheritedArchive>,
) -> anyhow::Result<()> {
    let mut encoded = Vec::new();
    let mut parent_uuid: Option<String> = None;
    for (index, msg) in messages.into_iter().enumerate() {
        let uuid = message_ids
            .get(index)
            .and_then(Clone::clone)
            .unwrap_or_else(generate_transcript_uuid);
        if index == 0
            && let Some(inherited) = inherited
        {
            inherited.write_header(&mut encoded, msg, &uuid)?;
        }
        let entry = HistoryEntry {
            web_sources: history_attempts.sources(&uuid),
            history_attempt: history_attempts
                .get(&uuid)
                .filter(|identity| identity.thread_id == session_id),
            session_id: session_id.to_string(),
            timestamp_ms: now_millis(),
            uuid: Some(uuid.clone()),
            parent_uuid: parent_uuid.clone(),
            message: msg.clone(),
        };
        if msg.origin() == kcoder_types::MessageOrigin::Compaction {
            let mut value = serde_json::to_value(&entry)?;
            value["isCompactSummary"] = serde_json::Value::Bool(true);
            serde_json::to_writer(&mut encoded, &value)?;
        } else {
            serde_json::to_writer(&mut encoded, &entry)?;
        }
        encoded.push(b'\n');
        parent_uuid = Some(uuid);
    }
    source.replace(&encoded)
}

pub(super) use crate::migrations::sessions::{
    RELIABLE_DELIVERY_FORMAT, SESSION_STATE_SCHEMA_VERSION,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct PersistedSessionState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) created_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) updated_at_ms: Option<u64>,
    #[serde(default = "legacy_session_state_schema_version")]
    pub(super) schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) delivery_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) base_cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "SessionMode::is_default")]
    pub(super) session_mode: SessionMode,
    #[serde(default)]
    pub(super) studio_work_mode: kcoder_types::StudioWorkMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) studio_tool_selection: Option<kcoder_types::StudioToolSelections>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) agent_definition: Option<kcoder_types::agent_definition::AgentTaskBinding>,
    #[serde(default)]
    pub(super) agent_configuration_revision: u64,
    #[serde(default)]
    pub(super) session_lifetime: kcoder_types::session_lifetime::SessionLifetimeSetting,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) channel_task_source: Option<kcoder_types::agent_definition::ChannelTaskSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) workflow_definition_id: Option<String>,
    #[serde(default)]
    pub(super) model_selection_mode: kcoder_types::ModelSelectionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) selected_model: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) conversation_started: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) goal: Option<Goal>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) goal_history: Vec<Goal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) compacted_messages: Option<Vec<Message>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) session_memory: Option<SessionMemorySnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) imported_context_snapshot: Option<imported_context_snapshot::SnapshotReference>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub(super) tasks: HashMap<String, Task>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub(super) background_tombstones: HashMap<String, Vec<crate::BackgroundRunRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) native_subagent_outbox:
        Option<crate::background_delivery::native_results::PrivateNativeOutbox>,
}

impl PersistedSessionState {
    pub(super) fn from_inner(inner: &AppStateInner) -> Self {
        Self {
            created_at_ms: Some(inner.session_created_at_ms),
            updated_at_ms: Some(inner.session_updated_at_ms),
            schema_version: SESSION_STATE_SCHEMA_VERSION,
            delivery_format: Some(RELIABLE_DELIVERY_FORMAT.to_string()),
            cwd: Some(inner.cwd.clone()),
            base_cwd: Some(inner.base_cwd.clone()),
            session_mode: inner.session_mode,
            studio_work_mode: inner.studio_work_mode,
            studio_tool_selection: inner.studio_tool_selection.clone(),
            agent_definition: inner.agent_definition.clone(),
            agent_configuration_revision: inner.agent_configuration_revision,
            session_lifetime: inner.session_lifetime,
            channel_task_source: inner.channel_task_source.clone(),
            workflow_definition_id: inner.workflow_definition_id.clone(),
            model_selection_mode: inner.model_selection_mode,
            selected_model: inner.selected_model.clone(),
            conversation_started: inner.conversation_started,
            goal: inner.goal.clone(),
            goal_history: inner.goal_history.clone(),
            // Recover model messages only from compact/rewind boundaries in append-only JSONL.
            compacted_messages: None,
            session_memory: inner.session_memory.clone(),
            imported_context_snapshot: if inner.session_state_path.is_some()
                && inner.imported_context_persisted_at == inner.session_state_path
            {
                inner.imported_context_reference.as_ref().map(|reference| {
                    reference.for_session(&imported_context_snapshot::session_for(inner))
                })
            } else {
                None
            },
            tasks: persistable_delegated_tasks(&inner.tasks),
            background_tombstones: HashMap::new(),
            native_subagent_outbox: None,
        }
    }
}

impl Default for PersistedSessionState {
    fn default() -> Self {
        Self {
            created_at_ms: None,
            updated_at_ms: None,
            schema_version: SESSION_STATE_SCHEMA_VERSION,
            delivery_format: Some(RELIABLE_DELIVERY_FORMAT.to_string()),
            cwd: None,
            base_cwd: None,
            session_mode: SessionMode::Default,
            studio_work_mode: Default::default(),
            studio_tool_selection: None,
            agent_definition: None,
            agent_configuration_revision: 0,
            session_lifetime: Default::default(),
            channel_task_source: None,
            workflow_definition_id: None,
            model_selection_mode: Default::default(),
            selected_model: None,
            conversation_started: false,
            goal: None,
            goal_history: Vec::new(),
            compacted_messages: None,
            session_memory: None,
            imported_context_snapshot: None,
            tasks: HashMap::new(),
            background_tombstones: HashMap::new(),
            native_subagent_outbox: None,
        }
    }
}

fn legacy_session_state_schema_version() -> u32 {
    1
}

pub(super) fn session_state_path_for_history(history_path: &Path) -> PathBuf {
    history_path.with_extension("state.json")
}

pub(super) fn exit_diagnostic_path_for_history(history_path: &Path) -> PathBuf {
    history_path.with_extension("exit.jsonl")
}

pub(super) fn is_exit_diagnostic_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    const SUFFIX: &str = ".exit.jsonl";
    let tail = name
        .as_bytes()
        .get(name.len().saturating_sub(SUFFIX.len())..);
    tail.is_some_and(|tail| {
        if cfg!(windows) {
            tail.eq_ignore_ascii_case(SUFFIX.as_bytes())
        } else {
            tail == SUFFIX.as_bytes()
        }
    })
}

pub(super) fn is_primary_session_history_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            if cfg!(windows) {
                extension.eq_ignore_ascii_case("jsonl")
            } else {
                extension == "jsonl"
            }
        })
        && !is_exit_diagnostic_path(path)
}

pub(super) fn session_id_from_history_path(history_path: &Path) -> anyhow::Result<String> {
    if is_exit_diagnostic_path(history_path) {
        anyhow::bail!(
            "history path {:?} is an exit diagnostic, not a session history",
            history_path
        );
    }
    history_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|session_id| !session_id.is_empty())
        .map(ToOwned::to_owned)
        .with_context(|| format!("history path {:?} has no valid session id", history_path))
}

fn same_history_path(left: &Path, right: &Path) -> bool {
    left == right
        || dunce::canonicalize(left)
            .ok()
            .zip(dunce::canonicalize(right).ok())
            .is_some_and(|(left, right)| left == right)
}

pub(super) fn write_bytes_atomic(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "state".into());
    let (tmp_path, mut file) = loop {
        let candidate = parent.join(format!(
            ".{file_name}.tmp-{}-{}",
            std::process::id(),
            TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => break (candidate, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    };
    let result = (|| -> anyhow::Result<()> {
        file.write_all(content)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        maybe_fail_before_atomic_replace(path)?;
        atomic_replace(&tmp_path, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    result
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    // Raw Win32 APIs require extended-length paths. Resolve parents only: neither
    // source nor destination leaf symlinks may redirect the entry being renamed.
    let canonical_file_path = |path: &Path| -> std::io::Result<std::path::PathBuf> {
        let parent = path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let name = path.file_name().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "file path has no file name",
            )
        })?;
        if name.encode_wide().any(|unit| unit == 0) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "file name contains NUL",
            ));
        }
        Ok(fs::canonicalize(parent)?.join(name))
    };
    let source = canonical_file_path(source)?;
    let destination = canonical_file_path(destination)?;

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both paths are NUL-terminated and valid for the call; flags only request replacement of an existing file with durable synchronization.
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(test))]
fn maybe_fail_before_atomic_replace(_destination: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(all(test, windows))]
mod windows_atomic_tests {
    use super::*;

    #[test]
    fn session_state_replaces_files_beyond_legacy_windows_path_limit() {
        let root = tempfile::tempdir().unwrap();
        let mut parent = root.path().to_path_buf();
        while parent.as_os_str().len() < 280 {
            parent.push("project-session-with-long-directory-name");
        }
        let destination = parent.join("session-state.json");
        write_bytes_atomic(&destination, b"first").unwrap();
        write_bytes_atomic(&destination, b"second").unwrap();
        assert_eq!(fs::read(destination).unwrap(), b"second");
    }
}

#[cfg(test)]
static ATOMIC_REPLACE_FAILPOINTS: std::sync::OnceLock<Mutex<HashMap<PathBuf, usize>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
pub(super) struct AtomicReplaceFailpointGuard {
    destination: PathBuf,
}

#[cfg(test)]
impl Drop for AtomicReplaceFailpointGuard {
    fn drop(&mut self) {
        if let Some(failpoints) = ATOMIC_REPLACE_FAILPOINTS.get() {
            let mut failpoints = failpoints
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if failpoints.get(&self.destination) == Some(&1) {
                failpoints.remove(&self.destination);
            } else if let Some(count) = failpoints.get_mut(&self.destination) {
                *count -= 1;
            }
        }
    }
}

#[cfg(test)]
pub(super) fn install_atomic_replace_failpoint(
    destination: PathBuf,
) -> AtomicReplaceFailpointGuard {
    ATOMIC_REPLACE_FAILPOINTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(destination.clone())
        .and_modify(|count| *count += 1)
        .or_insert(1);
    AtomicReplaceFailpointGuard { destination }
}

#[cfg(test)]
pub(super) fn maybe_fail_before_atomic_replace(destination: &Path) -> std::io::Result<()> {
    let should_fail = ATOMIC_REPLACE_FAILPOINTS.get().is_some_and(|failpoints| {
        failpoints
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(destination)
    });
    if should_fail {
        Err(std::io::Error::other("测试注入：原子替换前失败"))
    } else {
        Ok(())
    }
}

pub(super) fn write_session_state(
    path: &Path,
    state: &PersistedSessionState,
) -> anyhow::Result<()> {
    write_session_state_with_migration_backup(path, state)
}

/// Save metadata captured while the snapshot caller holds the inner and persistence locks.
pub(super) fn persist_snapshot_session_state(inner: &AppStateInner) -> anyhow::Result<()> {
    let Some(path) = inner.session_state_path.as_ref() else {
        return Ok(());
    };
    let mut state = PersistedSessionState::from_inner(inner);
    let source = require_history_source(inner)?;
    source.write_metadata(path, || {
        if let Some(snapshot) = &inner.imported_context_snapshot
            && inner.imported_context_persisted_at.as_ref() != Some(path)
        {
            state.imported_context_snapshot =
                inner.imported_context_reference.as_ref().map(|reference| {
                    reference.for_session(&imported_context_snapshot::session_for(inner))
                });
            imported_context_snapshot::publish(
                path,
                &imported_context_snapshot::session_for(inner),
                snapshot,
            )?;
        }
        prepare_legacy_session_state_write(path, state)
    })
}

fn write_session_state_with_migration_backup(
    path: &Path,
    state: &PersistedSessionState,
) -> anyhow::Result<()> {
    write_bytes_atomic(path, &prepare_session_state_write(path, state)?)
}

/// Old full snapshots do not own durable background delivery records.
fn preserve_background_authority(
    state: &mut PersistedSessionState,
    authority: &PersistedSessionState,
) {
    state.background_tombstones = authority.background_tombstones.clone();
    state.native_subagent_outbox = authority.native_subagent_outbox.clone();
    for (id, stored) in &authority.tasks {
        if !stored.status.is_known() {
            state.tasks.insert(id.clone(), stored.clone());
            continue;
        }
        if stored.background_runs.is_empty() {
            continue;
        }
        match state.tasks.get_mut(id) {
            Some(task) => {
                task.background_run = stored.background_run.clone();
                task.background_runs = stored.background_runs.clone();
            }
            None => {
                state.tasks.insert(id.clone(), stored.clone());
            }
        }
    }
    state
        .tasks
        .retain(|id, _| !state.background_tombstones.contains_key(id));
}

pub(super) fn prepare_legacy_session_state_write(
    path: &Path,
    state: PersistedSessionState,
) -> anyhow::Result<Vec<u8>> {
    prepare_legacy_session_state_with_native_goal(path, state).map(|(bytes, _)| bytes)
}

fn prepare_legacy_session_state_with_native_goal(
    path: &Path,
    mut state: PersistedSessionState,
) -> anyhow::Result<(Vec<u8>, Option<Goal>)> {
    let authority = load_session_state(path)?;
    // Stale metadata writers may not erase or replace a frozen session surface.
    if let Some(selection) = &authority.studio_tool_selection {
        anyhow::ensure!(
            state
                .studio_tool_selection
                .as_ref()
                .is_none_or(|value| value == selection),
            "Studio tool selection is immutable for an existing session"
        );
        state.studio_tool_selection = Some(selection.clone());
    }
    if let Some(reference) = &authority.imported_context_snapshot {
        anyhow::ensure!(
            state
                .imported_context_snapshot
                .as_ref()
                .is_none_or(|value| value == reference),
            "imported_context_snapshot_binding_changed"
        );
        state.imported_context_snapshot = Some(reference.clone());
    }
    preserve_background_authority(&mut state, &authority);
    crate::goal_remote_budget::preserve_native_goal_holds(&mut state.goal, &authority.goal)?;
    for stored in authority.goal_history.iter().chain(authority.goal.iter()) {
        if stored.native_task_budget_holds.is_empty()
            || state
                .goal
                .as_ref()
                .is_some_and(|goal| goal.goal_id == stored.goal_id)
        {
            continue;
        }
        if let Some(existing) = state
            .goal_history
            .iter_mut()
            .find(|goal| goal.goal_id == stored.goal_id)
        {
            let mut projection = Some(existing.clone());
            crate::goal_remote_budget::preserve_native_goal_holds(
                &mut projection,
                &Some(stored.clone()),
            )?;
            *existing = projection.expect("existing Goal projection");
        } else {
            state.goal_history.push(stored.clone());
        }
    }
    let projection = state
        .goal
        .as_ref()
        .filter(|goal| !goal.native_task_budget_holds.is_empty())
        .cloned();
    Ok((prepare_session_state_write(path, &state)?, projection))
}

pub(super) fn prepare_session_state_write(
    path: &Path,
    state: &PersistedSessionState,
) -> anyhow::Result<Vec<u8>> {
    crate::migrations::sessions::validate(state, path)?;
    let previous = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            anyhow::bail!("session state path must not be a symlink: {path:?}")
        }
        Ok(_) => Some(fs::read(path)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if let Some(previous) = previous {
        let previous_state = parse_session_state(path, std::str::from_utf8(&previous)?)?;
        anyhow::ensure!(
            state.schema_version >= previous_state.schema_version,
            "refusing to downgrade session state at {path:?}"
        );
        if previous_state.schema_version < SESSION_STATE_SCHEMA_VERSION {
            let backup = path.with_extension("pre-reliable-delivery.bak");
            match fs::symlink_metadata(&backup) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    anyhow::bail!("session migration backup must not be a symlink: {backup:?}")
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    write_bytes_atomic(&backup, &previous)?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(&backup, fs::Permissions::from_mode(0o600))?;
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(serde_json::to_vec_pretty(state)?)
}

#[cfg(not(test))]
fn maybe_wait_before_session_state_write(_lock_id: usize, _path: Option<&Path>) {}

#[cfg(not(test))]
pub(super) fn maybe_wait_before_session_state_lock(_lock_id: usize) {}

#[cfg(test)]
#[derive(Clone)]
struct SessionStateWriteBarrier {
    lock_id: usize,
    path: PathBuf,
    entered: Arc<std::sync::Barrier>,
    release: Arc<std::sync::Barrier>,
}

#[cfg(test)]
#[derive(Clone)]
struct SessionStateLockBarrier {
    lock_id: usize,
    entered: Arc<std::sync::Barrier>,
    release: Arc<std::sync::Barrier>,
}

#[cfg(test)]
static SESSION_STATE_WRITE_BARRIER: std::sync::OnceLock<Mutex<Option<SessionStateWriteBarrier>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
static SESSION_STATE_LOCK_BARRIER: std::sync::OnceLock<Mutex<Option<SessionStateLockBarrier>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
pub(super) fn install_session_state_write_barrier(
    state: &AppState,
    path: PathBuf,
    entered: Arc<std::sync::Barrier>,
    release: Arc<std::sync::Barrier>,
) {
    *SESSION_STATE_WRITE_BARRIER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(SessionStateWriteBarrier {
        lock_id: Arc::as_ptr(&state.session_state_persist_lock) as usize,
        path,
        entered,
        release,
    });
}

#[cfg(test)]
pub(super) fn install_session_state_lock_barrier(
    state: &AppState,
    entered: Arc<std::sync::Barrier>,
    release: Arc<std::sync::Barrier>,
) {
    *SESSION_STATE_LOCK_BARRIER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(SessionStateLockBarrier {
        lock_id: Arc::as_ptr(&state.session_state_persist_lock) as usize,
        entered,
        release,
    });
}

#[cfg(test)]
pub(super) fn clear_session_state_write_barrier() {
    if let Some(barrier) = SESSION_STATE_WRITE_BARRIER.get() {
        *barrier
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

#[cfg(test)]
pub(super) fn clear_session_state_lock_barrier() {
    if let Some(barrier) = SESSION_STATE_LOCK_BARRIER.get() {
        *barrier
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

#[cfg(test)]
pub(super) fn maybe_wait_before_session_state_lock(lock_id: usize) {
    let barrier = SESSION_STATE_LOCK_BARRIER.get().and_then(|slot| {
        let mut slot = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot
            .as_ref()
            .is_some_and(|barrier| barrier.lock_id == lock_id)
        {
            slot.take()
        } else {
            None
        }
    });
    if let Some(barrier) = barrier {
        barrier.entered.wait();
        barrier.release.wait();
    }
}

#[cfg(test)]
fn maybe_wait_before_session_state_write(lock_id: usize, path: Option<&Path>) {
    let barrier = SESSION_STATE_WRITE_BARRIER.get().and_then(|slot| {
        let mut slot = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.as_ref().is_some_and(|barrier| {
            barrier.lock_id == lock_id && Some(barrier.path.as_path()) == path
        }) {
            slot.take()
        } else {
            None
        }
    });
    if let Some(barrier) = barrier {
        barrier.entered.wait();
        barrier.release.wait();
    }
}

pub(super) struct SessionTaskPersistence {
    path: Option<PathBuf>,
    source: Option<HistorySource>,
}

impl SessionTaskPersistence {
    /// Capture the writer identity while the caller holds the same lock as its task snapshot.
    pub(super) fn from_inner(inner: &AppStateInner) -> Self {
        Self {
            path: inner.session_state_path.clone(),
            source: inner.history_source.clone(),
        }
    }
}

pub(super) fn persist_session_tasks(target: SessionTaskPersistence, tasks: HashMap<String, Task>) {
    if let Err(error) = persist_session_tasks_result(target, tasks) {
        warn!("failed to persist session tasks: {error:#}");
    }
}

/// Persist tasks and return write errors to callers that require transactional semantics.
///
/// The old task-update API remains a best-effort wrapper. Reliable message delivery
/// must use this function and may report enqueue, lease, or acknowledgement success
/// only after atomic sidecar replacement succeeds.
pub(super) fn persist_session_tasks_result(
    target: SessionTaskPersistence,
    tasks: HashMap<String, Task>,
) -> anyhow::Result<()> {
    let Some(path) = target.path else {
        return Ok(());
    };
    let source = target
        .source
        .context("refusing to persist session tasks without a bound history source")?;
    // Read-modify-write must share the source lock, including validation before parent creation.
    source.write_metadata(&path, || {
        let authority = load_session_state(&path)?;
        let mut state = authority.clone();
        state.tasks = tasks;
        preserve_background_authority(&mut state, &authority);
        state.schema_version = SESSION_STATE_SCHEMA_VERSION;
        state.delivery_format = Some(RELIABLE_DELIVERY_FORMAT.to_string());
        prepare_session_state_write(&path, &state)
    })
}

pub(super) fn load_session_state(path: &Path) -> anyhow::Result<PersistedSessionState> {
    let _span = tracing::debug_span!("history.session_state_read").entered();
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PersistedSessionState::default());
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to read session state from {path:?}"));
        }
    };
    parse_session_state(path, &content)
}

pub(super) fn parse_session_state(
    path: &Path,
    content: &str,
) -> anyhow::Result<PersistedSessionState> {
    let state: PersistedSessionState = serde_json::from_str(content).map_err(|error| {
        // Preserve the original sidecar and surface corruption to the owner.
        warn!(
            "session state at {:?} could not be parsed; original data is preserved: {}",
            path, error
        );
        anyhow::anyhow!("failed to parse session state from {:?}: {}", path, error)
    })?;
    crate::migrations::sessions::validate(&state, path)?;
    if let Some(reference) = &state.imported_context_snapshot {
        reference.validate()?;
    }
    Ok(state)
}

#[cfg(test)]
mod studio_work_mode_tests {
    use super::*;
    use kcoder_types::StudioWorkMode;

    #[test]
    fn studio_mode_survives_snapshot_and_legacy_defaults_without_unlocking_started_session() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        state
            .set_studio_work_mode_before_first_message(StudioWorkMode::Kworker)
            .unwrap();
        state.add_message(Message::user_text("organize documents"));
        assert!(
            state
                .set_studio_work_mode_before_first_message(StudioWorkMode::Kcoder)
                .is_err()
        );
        let path = root.path().join("snapshot.json");
        state.export_snapshot(&path).unwrap();
        let restored = AppState::new(root.path());
        restored.import_snapshot(&path).unwrap();
        assert_eq!(restored.studio_work_mode(), StudioWorkMode::Kworker);
        assert!(
            restored
                .set_studio_work_mode_before_first_message(StudioWorkMode::Kcoder)
                .is_err()
        );
        let mut legacy = serde_json::to_value(state.snapshot()).unwrap();
        legacy.as_object_mut().unwrap().remove("studio_work_mode");
        let snapshot: SessionSnapshot = serde_json::from_value(legacy).unwrap();
        assert_eq!(snapshot.studio_work_mode, StudioWorkMode::Kcoder);
        restored.start_new_session().unwrap();
        assert_eq!(restored.studio_work_mode(), StudioWorkMode::Kcoder);
    }
}

#[cfg(test)]
mod studio_tool_selection_tests {
    use super::*;
    use kcoder_types::StudioToolSelections;

    fn selection() -> StudioToolSelections {
        StudioToolSelections {
            kcoder: Some(vec!["Read".into(), "Shell".into()]),
            kworker: Some(vec![]),
        }
    }

    #[test]
    fn studio_tool_selection_persists_and_cold_restores() {
        let root = tempfile::tempdir().unwrap();
        let history = root.path().join("session.jsonl");
        let state = AppState::new(root.path());
        state.with_history_path(&history);
        state.bind_studio_tool_selection_once(selection()).unwrap();
        state.add_message(Message::user_text("session tools"));
        state.save_history().unwrap();
        let restored = AppState::new(root.path());
        restored.resume_from_history(&history).unwrap();
        assert_eq!(restored.studio_tool_selection(), Some(selection()));
        assert_eq!(restored.snapshot().studio_tool_selection, Some(selection()));
        restored.start_new_session().unwrap();
        assert_eq!(restored.studio_tool_selection(), None);
    }

    #[test]
    fn studio_tool_selection_binding_is_idempotent_and_rejects_replacement() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        state.with_history_path(root.path().join("session.jsonl"));
        state.bind_studio_tool_selection_once(selection()).unwrap();
        let sidecar = state.session_state_path().unwrap();
        let before = fs::read(&sidecar).unwrap();
        state.bind_studio_tool_selection_once(selection()).unwrap();
        assert_eq!(fs::read(&sidecar).unwrap(), before);
        assert!(
            state
                .bind_studio_tool_selection_once(StudioToolSelections::default())
                .is_err()
        );
        assert_eq!(state.studio_tool_selection(), Some(selection()));
        assert_eq!(fs::read(&sidecar).unwrap(), before);
    }

    #[test]
    fn studio_tool_selection_legacy_none_is_not_backfilled() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        let mut snapshot = serde_json::to_value(state.snapshot()).unwrap();
        snapshot
            .as_object_mut()
            .unwrap()
            .remove("studio_tool_selection");
        let legacy: SessionSnapshot = serde_json::from_value(snapshot).unwrap();
        assert_eq!(legacy.studio_tool_selection, None);
        let legacy_sidecar: PersistedSessionState = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy_sidecar.studio_tool_selection, None);
        let history = root.path().join("legacy.jsonl");
        state.with_history_path(&history);
        state.add_message(Message::user_text("legacy session"));
        state.save_history().unwrap();
        let restored = AppState::new(root.path());
        restored.resume_from_history(&history).unwrap();
        assert_eq!(restored.studio_tool_selection(), None);
        let sidecar: serde_json::Value =
            serde_json::from_slice(&fs::read(restored.session_state_path().unwrap()).unwrap())
                .unwrap();
        assert!(sidecar.get("studio_tool_selection").is_none());
    }

    #[test]
    fn studio_tool_selection_snapshot_roundtrip_preserves_empty_and_rejects_overwrite() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        state.bind_studio_tool_selection_once(selection()).unwrap();
        let export = root.path().join("snapshot.json");
        state.export_snapshot(&export).unwrap();
        let imported = AppState::new(root.path());
        imported.with_history_path(root.path().join("import.jsonl"));
        imported.import_snapshot(&export).unwrap();
        assert_eq!(imported.studio_tool_selection(), Some(selection()));
        let sidecar = imported.session_state_path().unwrap();
        assert_eq!(
            load_session_state(&sidecar).unwrap().studio_tool_selection,
            Some(selection())
        );
        let other = AppState::new(root.path());
        other.export_snapshot(&export).unwrap();
        assert!(imported.import_snapshot(&export).is_err());
        assert_eq!(imported.studio_tool_selection(), Some(selection()));
        assert_eq!(
            load_session_state(&sidecar).unwrap().studio_tool_selection,
            Some(selection())
        );
    }

    #[tokio::test]
    async fn studio_tool_selection_survives_rewind_and_cold_restore() {
        let root = tempfile::tempdir().unwrap();
        let history = root.path().join("rewind.jsonl");
        let state = AppState::new(root.path());
        state.with_history_path(&history);
        state.bind_studio_tool_selection_once(selection()).unwrap();
        state.add_message(Message::user_text("first turn"));
        state.add_message(Message::user_text("second turn"));
        state.save_history().unwrap();
        state.truncate_messages_for_rewind(1, 1).await.unwrap();
        assert_eq!(state.studio_tool_selection(), Some(selection()));
        let restored = AppState::new(root.path());
        restored.resume_from_history(&history).unwrap();
        assert_eq!(restored.studio_tool_selection(), Some(selection()));
        assert_eq!(restored.messages().len(), 1);
    }

    #[test]
    fn studio_tool_selection_stale_metadata_cannot_erase_or_replace_binding() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        state.with_history_path(root.path().join("session.jsonl"));
        let mut stale = PersistedSessionState::from_inner(&state.read_inner());
        state.bind_studio_tool_selection_once(selection()).unwrap();
        let sidecar = state.session_state_path().unwrap();
        let bytes = prepare_legacy_session_state_write(&sidecar, stale.clone()).unwrap();
        let merged: PersistedSessionState = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(merged.studio_tool_selection, Some(selection()));
        stale.studio_tool_selection = Some(StudioToolSelections::default());
        assert!(prepare_legacy_session_state_write(&sidecar, stale).is_err());
    }
}
