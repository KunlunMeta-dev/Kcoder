//! Associates existing Engine tasks with managed worktrees; selection has no Git side effects.
use super::*;
use kcoder_app_protocol::{self as p, TaskComparisonBinding as Binding};
use kcoder_workspace_resources::managed_worktrees::{
    safe_absolute_path, valid_comparison_text, valid_git_object_id, validate_address,
    validate_comparison_registry,
};

mod observations;
#[cfg(test)]
mod tests;

fn matching<'a>(
    state: &'a ClientWorktreeState,
    address: &p::TaskComparisonReadParams,
) -> Result<Vec<&'a ClientManagedWorktree>> {
    ensure!(
        safe_absolute_path(Path::new(&address.source_path)),
        "invalid comparison source path"
    );
    validate_address(
        &address.device_id,
        &address.comparison_id,
        &address.owner_thread_id,
    )?;
    let records: Vec<_> = state
        .records
        .values()
        .filter(|r| {
            r.comparison
                .as_ref()
                .is_some_and(|b| b.comparison_id == address.comparison_id)
        })
        .collect();
    ensure!(
        records.iter().all(|r| r
            .comparison
            .as_ref()
            .is_some_and(|b| b.owner_thread_id == address.owner_thread_id
                && b.device_id == address.device_id)),
        "comparison belongs to another owner or target"
    );
    Ok(records)
}

fn validate_task_link(record: &ClientManagedWorktree, binding: &Binding) -> Result<()> {
    ensure!(
        record
            .archived_conversations
            .iter()
            .any(|c| c.task_id == binding.task_id
                && c.thread_id == binding.thread_id
                && c.device_id == binding.device_id
                && c.workspace_path == record.path),
        "comparison requires an existing linked Engine task"
    );
    Ok(())
}

pub(super) struct ComparisonTaskStorage {
    pub(super) history_path: PathBuf,
    pub(super) artifact_root: PathBuf,
}

/// Call only after the workspace has been authorized by a managed-worktree record.
/// This locates persisted facts without restoring or leasing the addressed Engine.
pub(super) fn comparison_task_storage(
    engine: &QueryEngine,
    thread: &str,
    workspace: &Path,
) -> Result<ComparisonTaskStorage> {
    validate_thread_id(thread)?;
    let expected = dunce::canonicalize(workspace)?;
    let current_history = engine
        .state
        .history_path()
        .context("session history is disabled")?;
    let current_root = current_history
        .parent()
        .context("missing history directory")?;
    let project_roots = kcoder_config::Settings::project_data_dirs_for_read(&expected)?;
    let mut history_roots = vec![current_root.to_path_buf()];
    for root in &project_roots {
        if !history_roots.contains(root) {
            history_roots.push(root.clone());
        }
    }
    let mut selected = None;
    for root in &history_roots {
        let directory = match kcoder_config::PrivateDirectory::open_existing(root) {
            Ok(directory) => directory,
            Err(error) if error_is_not_found(&error) => continue,
            Err(error) => return Err(error),
        };
        let name = format!("{thread}.jsonl");
        match directory.open_single_link_regular_file(std::ffi::OsStr::new(&name)) {
            Ok(_) => {}
            Err(error) if error_is_not_found(&error) => continue,
            Err(error) => return Err(error),
        }
        let path = candidate_thread_history_path(root, thread)?;
        let metadata = kcoder_state::prepare_session_metadata(&path)?;
        let cwd = metadata
            .base_cwd()
            .context("comparison task workspace is unknown")?;
        ensure!(
            dunce::canonicalize(cwd)? == expected,
            "comparison task belongs to another workspace"
        );
        selected = Some((path, root.clone()));
        break;
    }
    let (history_path, history_root) =
        selected.context("comparison task history is unavailable")?;
    let artifact_root =
        if engine.durable_client_storage_root().is_none() && history_root == current_root {
            engine.session_storage_dir_for(thread)
        } else {
            let project_root = project_roots
                .iter()
                .find(|root| root.as_path() == history_root)
                .or_else(|| project_roots.first())
                .context("comparison artifact root is unknown")?;
            kcoder_state::session_dir_path(project_root.join("client-sessions"), thread)
        };
    Ok(ComparisonTaskStorage {
        history_path,
        artifact_root,
    })
}

fn validate_thread_workspace(
    engine: &QueryEngine,
    thread: &str,
    workspace: &Path,
) -> Result<PathBuf> {
    Ok(comparison_task_storage(engine, thread, workspace)?.history_path)
}

async fn authorize(engine: &QueryEngine, record: &ClientManagedWorktree) -> Result<()> {
    let root = dunce::canonicalize(engine.state.cwd())?;
    let source = record
        .source_path
        .as_deref()
        .context("comparison source is unknown")?;
    let source = authorized_worktree_source(engine, &root, Path::new(source)).await?;
    ensure!(
        source == dunce::canonicalize(&root)?,
        "comparison must be read from its source workspace"
    );
    Ok(())
}

pub(super) async fn task_comparison_request(
    engine: &QueryEngine,
    method: &str,
    params: &Value,
) -> Result<Value> {
    let store = client_worktree_store(engine);
    let _guard = store.lock()?;
    let mut state = store.load()?;
    match method {
        p::TASK_COMPARISON_BIND => {
            let request: p::TaskComparisonBindParams = serde_json::from_value(params.clone())?;
            let address = p::TaskComparisonReadParams {
                source_path: request.source_path.clone(),
                device_id: request.device_id.clone(),
                comparison_id: request.comparison_id.clone(),
                owner_thread_id: request.owner_thread_id.clone(),
            };
            ensure!(
                dunce::canonicalize(&address.source_path)?
                    == dunce::canonicalize(engine.state.cwd())?,
                "comparison source routing mismatch"
            );
            let existing = matching(&state, &address)?;
            ensure!(
                existing.len() < p::MAX_TASK_COMPARISON_CANDIDATES,
                "comparison capacity reached"
            );
            ensure!(
                valid_comparison_text(&request.requirement, 4096)
                    && valid_comparison_text(&request.label, 128)
                    && valid_comparison_text(&request.task_id, 512),
                "invalid comparison description"
            );
            validate_thread_workspace(
                engine,
                &request.owner_thread_id,
                engine.state.cwd().as_path(),
            )?;
            let record = state
                .records
                .get(&request.path)
                .context("managed worktree was not found")?;
            authorize(engine, record).await?;
            ensure!(
                record.revision == request.expected_revision,
                "managed worktree changed; refresh the comparison"
            );
            ensure!(
                record.comparison.is_none(),
                "managed worktree already belongs to a comparison"
            );
            ensure!(
                request.thread_id != request.owner_thread_id,
                "alternative must have an independent task"
            );
            // A running task may write between observations. Association binds its
            // verified repository/task identities, never a content-stability claim.
            let observed = observations::git_identity(&store, record).await?;
            let binding = Binding {
                comparison_id: request.comparison_id,
                owner_thread_id: request.owner_thread_id,
                device_id: request.device_id,
                requirement: request.requirement,
                label: request.label,
                task_id: request.task_id,
                thread_id: request.thread_id,
                branch: observed
                    .branch
                    .context("comparison alternatives require a named branch")?,
                base_commit: record
                    .base_commit
                    .clone()
                    .context("comparison baseline is unknown")?,
                selection: None,
            };
            validate_task_link(record, &binding)?;
            validate_thread_workspace(engine, &binding.thread_id, Path::new(&record.path))?;
            let record = state.records.get_mut(&request.path).unwrap();
            record.comparison = Some(binding);
            record.revision = record.revision.saturating_add(1);
            record.updated_at = app_server_now_ms();
            state.version = 3;
            validate_comparison_registry(&state)?;
            store.save(&state)?;
            serde_json::to_value(read(engine, &store, &state, &address).await?).map_err(Into::into)
        }
        p::TASK_COMPARISON_READ => {
            let request: p::TaskComparisonReadParams = serde_json::from_value(params.clone())?;
            ensure!(
                dunce::canonicalize(&request.source_path)?
                    == dunce::canonicalize(engine.state.cwd())?,
                "comparison source routing mismatch"
            );
            validate_thread_workspace(
                engine,
                &request.owner_thread_id,
                engine.state.cwd().as_path(),
            )?;
            serde_json::to_value(read(engine, &store, &state, &request).await?).map_err(Into::into)
        }
        p::TASK_COMPARISON_SELECT => {
            let request: p::TaskComparisonSelectParams = serde_json::from_value(params.clone())?;
            let address = p::TaskComparisonReadParams {
                source_path: request.source_path.clone(),
                device_id: request.device_id,
                comparison_id: request.comparison_id,
                owner_thread_id: request.owner_thread_id,
            };
            validate_thread_workspace(
                engine,
                &address.owner_thread_id,
                engine.state.cwd().as_path(),
            )?;
            ensure!(
                dunce::canonicalize(&address.source_path)?
                    == dunce::canonicalize(engine.state.cwd())?,
                "comparison source routing mismatch"
            );
            let records = matching(&state, &address)?;
            ensure!(
                records.len() >= 2,
                "comparison requires at least two independent tasks"
            );
            let record = records
                .iter()
                .find(|r| {
                    r.comparison
                        .as_ref()
                        .is_some_and(|b| b.thread_id == request.thread_id)
                })
                .context("comparison alternative was not found")?;
            authorize(engine, record).await?;
            let binding = record.comparison.as_ref().unwrap();
            validate_task_link(record, binding)?;
            validate_thread_workspace(engine, &binding.thread_id, Path::new(&record.path))?;
            let observed = observations::git(&store, record).await?;
            ensure!(
                record.revision == request.expected_revision
                    && observed.head_commit == request.expected_head_commit
                    && observed.content_token == request.expected_content_token
                    && observed.branch.as_deref() == Some(&binding.branch),
                "comparison alternative changed; refresh before selecting"
            );
            let selected_path = record.path.clone();
            let selection = p::TaskComparisonSelection {
                head_commit: observed.head_commit,
                content_token: observed.content_token,
                selected_at_ms: app_server_now_ms(),
            };
            for record in state.records.values_mut().filter(|r| {
                r.comparison
                    .as_ref()
                    .is_some_and(|b| b.comparison_id == address.comparison_id)
            }) {
                record.comparison.as_mut().unwrap().selection =
                    (record.path == selected_path).then(|| selection.clone());
                record.revision = record.revision.saturating_add(1);
                record.updated_at = app_server_now_ms();
            }
            validate_comparison_registry(&state)?;
            store.save(&state)?;
            serde_json::to_value(read(engine, &store, &state, &address).await?).map_err(Into::into)
        }
        _ => anyhow::bail!("unsupported task comparison method"),
    }
}

async fn read(
    engine: &QueryEngine,
    store: &ClientWorktreeStore,
    state: &ClientWorktreeState,
    address: &p::TaskComparisonReadParams,
) -> Result<p::TaskComparisonReadResult> {
    let records = matching(state, address)?;
    let mut candidates = Vec::new();
    for record in &records {
        authorize(engine, record).await?;
        candidates.push(observations::candidate(engine, store, record).await);
    }
    Ok(p::TaskComparisonReadResult {
        source_path: address.source_path.clone(),
        device_id: address.device_id.clone(),
        comparison_id: address.comparison_id.clone(),
        owner_thread_id: address.owner_thread_id.clone(),
        requirement: records
            .first()
            .map(|r| r.comparison.as_ref().unwrap().requirement.clone()),
        selected_thread_id: records.iter().find_map(|r| {
            r.comparison
                .as_ref()
                .filter(|b| b.selection.is_some())
                .map(|b| b.thread_id.clone())
        }),
        candidates,
    })
}

/// The delivery handler resolves this source again; the browser cannot substitute a path.
pub(super) struct SelectedComparisonSource {
    pub(super) device_id: String,
    pub(super) history_path: PathBuf,
    pub(super) artifact_root: PathBuf,
    pub(super) comparison_id: String,
    pub(super) task_id: String,
    pub(super) thread_id: String,
    pub(super) worktree_id: String,
    pub(super) workspace_root: PathBuf,
    pub(super) branch: String,
    pub(super) base_commit: String,
    pub(super) head_commit: String,
}

pub(super) async fn selected_comparison_source(
    engine: &QueryEngine,
    comparison_id: &str,
    owner_thread_id: &str,
    device_id: &str,
) -> Result<Option<SelectedComparisonSource>> {
    let store = client_worktree_store(engine);
    let _guard = store.lock()?;
    let state = store.load()?;
    let address = p::TaskComparisonReadParams {
        source_path: engine.state.cwd().to_string_lossy().into_owned(),
        device_id: device_id.into(),
        comparison_id: comparison_id.into(),
        owner_thread_id: owner_thread_id.into(),
    };
    validate_thread_workspace(engine, owner_thread_id, engine.state.cwd().as_path())?;
    let records = matching(&state, &address)?;
    let Some(record) = records
        .into_iter()
        .find(|r| r.comparison.as_ref().is_some_and(|b| b.selection.is_some()))
    else {
        return Ok(None);
    };
    authorize(engine, record).await?;
    let binding = record.comparison.as_ref().unwrap();
    validate_task_link(record, binding)?;
    let storage = comparison_task_storage(engine, &binding.thread_id, Path::new(&record.path))?;
    let git = observations::git(&store, record).await?;
    let selection = binding.selection.as_ref().unwrap();
    ensure!(
        git.head_commit == selection.head_commit
            && git.content_token == selection.content_token
            && git.branch.as_deref() == Some(&binding.branch),
        "selected alternative changed; review and select it again"
    );
    Ok(Some(SelectedComparisonSource {
        history_path: storage.history_path,
        artifact_root: storage.artifact_root,
        device_id: device_id.into(),
        comparison_id: comparison_id.into(),
        task_id: binding.task_id.clone(),
        thread_id: binding.thread_id.clone(),
        worktree_id: record.worktree_id.clone(),
        workspace_root: PathBuf::from(&record.path),
        branch: binding.branch.clone(),
        base_commit: binding.base_commit.clone(),
        head_commit: git.head_commit,
    }))
}

/// Delivery reuses the same bounded native observations at the selected B root.
pub(super) fn selected_source_review_evidence(
    _owner: &QueryEngine,
    source: &SelectedComparisonSource,
) -> Result<HashMap<String, p::TurnReviewEvidence>> {
    observations::load_task_reviews(&source.artifact_root, &source.thread_id)
}
