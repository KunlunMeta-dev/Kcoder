use super::*;
use kcoder_state::{
    ArtifactBaseline, ArtifactBaselineState, ArtifactRequirement, ArtifactValidationEntry,
    ArtifactValidationReport, ArtifactValidationRun, ArtifactValidationStatus,
};

pub(super) struct ValidationInput {
    pub(super) cwd: PathBuf,
    pub(super) allowed_write_paths: Vec<String>,
    pub(super) runtime_write_paths: Vec<String>,
    pub(super) sandbox: Arc<kcoder_tools::Sandbox>,
    pub(super) permissions: PermissionEngine,
    pub(super) read_enabled: bool,
    pub(super) requirements: Vec<ArtifactRequirement>,
    pub(super) run: ArtifactValidationRun,
    pub(super) stop: CancellationToken,
    pub(super) baseline: Option<ArtifactBaseline>,
    pub(super) capture_baseline: bool,
}

pub(super) const FILE_LIMIT: u64 = 16 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 64 * 1024 * 1024;
static WORKERS: std::sync::LazyLock<Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(4)));

pub(super) async fn begin(
    parent: &QueryEngine,
    child: &QueryEngine,
    agent_id: &str,
    delivery: Option<&AgentDeliveryContext>,
    completed_replay: bool,
) -> anyhow::Result<Option<ArtifactValidationRun>> {
    let Some(task) = parent.state.task(agent_id) else {
        return Ok(None);
    };
    if task.artifact_requirements.is_empty() {
        return Ok(None);
    }
    let delivery_key = delivery
        .map(|delivery| {
            let anchor = task
                .message_queue
                .iter()
                .find(|queued| queued.message_id == delivery.message_id)
                .and_then(|queued| queued.transcript_anchor.as_ref())
                .ok_or_else(|| anyhow::anyhow!("artifact delivery anchor missing"))?;
            Ok::<_, anyhow::Error>(format!(
                "{}:{:x}",
                delivery.message_id,
                Sha256::digest(serde_json::to_vec(anchor)?)
            ))
        })
        .transpose()?;
    let (run, created) = parent
        .state
        .begin_artifact_validation_with_origin(agent_id, &task.artifact_requirements, delivery_key)
        .map_err(|_| {
            anyhow::anyhow!("failed to prepare artifact validation; acceptance is unavailable")
        })?;
    if created && !completed_replay && task.artifact_requirements.iter().any(|r| r.require_changed)
    {
        let error =
            || anyhow::anyhow!("failed to persist artifact baseline; acceptance is unavailable");
        if parent
            .state
            .prepare_artifact_baseline(agent_id, &run)
            .map_err(|_| error())?
        {
            let report = inspect_bounded(validation_input(child, &task, run.clone(), true)).await;
            parent
                .state
                .publish_artifact_baseline(
                    agent_id,
                    ArtifactBaseline {
                        run: run.clone(),
                        state: ArtifactBaselineState::Ready,
                        entries: report.entries,
                    },
                )
                .map_err(|_| error())?;
        } else {
            return Err(error());
        }
    }
    Ok(Some(run))
}

pub(super) fn validation_input(
    child: &QueryEngine,
    task: &kcoder_state::Task,
    run: ArtifactValidationRun,
    capture_baseline: bool,
) -> ValidationInput {
    ValidationInput {
        cwd: child.cwd.clone(),
        allowed_write_paths: task.allowed_write_paths.clone(),
        runtime_write_paths: crate::recover_read_lock(
            &child.allowed_write_paths,
            "allowed_write_paths",
        )
        .clone(),
        sandbox: child.sandbox.clone(),
        permissions: crate::recover_read_lock(&child.permissions, "permissions").clone(),
        read_enabled: child.active_tool_registry().get("read").is_some(),
        requirements: task.artifact_requirements.clone(),
        run,
        stop: child.cancel_token.child_token(),
        baseline: task.artifact_baseline.clone(),
        capture_baseline,
    }
}

pub(super) async fn finish(
    parent: &QueryEngine,
    child: &QueryEngine,
    agent_id: &str,
    run: Option<ArtifactValidationRun>,
) -> anyhow::Result<()> {
    let Some(run) = run else { return Ok(()) };
    if child.cancel_token.is_cancelled() {
        return Err(anyhow::Error::new(ForkedAgentAborted {
            reason: "artifact observation cancelled".into(),
            cancelled: true,
        }));
    }
    let task = parent
        .state
        .task(agent_id)
        .ok_or_else(|| anyhow::anyhow!("artifact validation task missing"))?;
    if task.artifact_validation_run.as_ref() != Some(&run)
        || kcoder_state::artifact_declarations_sha256(&task.artifact_requirements)
            != run.declarations_sha256
    {
        anyhow::bail!("artifact validation run changed");
    }
    if task
        .artifact_validation_report
        .as_ref()
        .is_some_and(|report| report.run == run)
    {
        let input = validation_input(child, &task, run.clone(), false);
        if task
            .artifact_validation_report
            .as_ref()
            .is_some_and(|report| {
                report.entries.iter().any(|entry| {
                    task.artifact_requirements
                        .get(entry.index)
                        .is_some_and(|r| r.require_changed)
                        && entry.status == ArtifactValidationStatus::Passed
                        && freshness_status(&input, entry) != ArtifactValidationStatus::Passed
                })
            })
        {
            anyhow::bail!("artifact baseline unavailable; acceptance is unavailable");
        }
        return Ok(());
    }
    let input = validation_input(child, &task, run, false);
    let report = inspect_bounded(input).await;
    if child.cancel_token.is_cancelled() {
        return Err(anyhow::Error::new(ForkedAgentAborted {
            reason: "artifact observation cancelled".into(),
            cancelled: true,
        }));
    }
    parent
        .state
        .publish_artifact_validation(agent_id, report)
        .map_err(|_| {
            anyhow::anyhow!(
                "failed to persist artifact validation report; acceptance is unavailable"
            )
        })?;
    Ok(())
}

pub(super) fn unavailable(input: &ValidationInput) -> ArtifactValidationReport {
    ArtifactValidationReport {
        run: input.run.clone(),
        observed_at_ms: chrono::Utc::now().timestamp_millis().max(0) as u64,
        entries: input
            .requirements
            .iter()
            .enumerate()
            .map(|(index, requirement)| ArtifactValidationEntry {
                index,
                path: requirement.path.clone(),
                status: ArtifactValidationStatus::Unavailable,
                size_bytes: None,
                sha256: None,
            })
            .collect(),
    }
}

async fn inspect_bounded(input: ValidationInput) -> ArtifactValidationReport {
    let mut fallback = unavailable(&input);
    let result = run_bounded_worker(
        input.stop.clone(),
        WORKERS.clone(),
        std::time::Duration::from_secs(5),
        move || inspect(input),
    )
    .await;
    match result {
        Some(report) => report,
        _ => {
            fallback.observed_at_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
            fallback
        }
    }
}

pub(super) async fn run_bounded_worker<T: Send + 'static>(
    stop: CancellationToken,
    workers: Arc<tokio::sync::Semaphore>,
    timeout: std::time::Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let _cancel_on_drop = stop.clone().drop_guard();
    if stop.is_cancelled() {
        return None;
    }
    let result = tokio::select! {
        biased;
        _ = stop.cancelled() => return None,
        result = tokio::time::timeout(timeout, async move {
        let permit = workers.acquire_owned().await.ok()?;
        tokio::task::spawn_blocking(move || {
            // The worker owns capacity even after its async waiter times out.
            let _permit = permit;
            work()
        }).await.ok()
        }) => result,
    };
    result.ok().flatten()
}

pub(super) fn inspect(input: ValidationInput) -> ArtifactValidationReport {
    let mut report = unavailable(&input);
    if kcoder_state::validate_artifact_requirements(&input.requirements).is_err() {
        return report;
    }
    let mut read_bytes = 0;
    for (requirement, entry) in input.requirements.iter().zip(&mut report.entries) {
        if input.stop.is_cancelled() {
            break;
        }
        if input.capture_baseline {
            if !requirement.require_changed {
                continue;
            }
            let mut declaration = requirement.clone();
            declaration.min_bytes = 0;
            declaration.forbidden_literals.clear();
            declaration.unique_content = false;
            entry.status = inspect_file(&input, &declaration, entry, &mut read_bytes);
        } else {
            entry.status = inspect_file(&input, requirement, entry, &mut read_bytes);
            if requirement.require_changed && entry.status == ArtifactValidationStatus::Passed {
                entry.status = freshness_status(&input, entry);
            }
        }
    }
    if input.capture_baseline {
        return report;
    }
    let hashes: Vec<_> = report
        .entries
        .iter()
        .map(|entry| entry.sha256.clone())
        .collect();
    for (index, (requirement, entry)) in input
        .requirements
        .iter()
        .zip(&mut report.entries)
        .enumerate()
    {
        if requirement.unique_content
            && entry.status == ArtifactValidationStatus::Passed
            && let Some(hash) = &hashes[index]
            && hashes
                .iter()
                .enumerate()
                .any(|(other, candidate)| other != index && candidate.as_ref() == Some(hash))
        {
            entry.status = ArtifactValidationStatus::Duplicate;
        }
    }
    report.observed_at_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
    report
}

fn freshness_status(
    input: &ValidationInput,
    entry: &ArtifactValidationEntry,
) -> ArtifactValidationStatus {
    use ArtifactValidationStatus::*;
    if !valid_observation_hash(entry) {
        return Unavailable;
    }
    let baseline = input
        .baseline
        .as_ref()
        .filter(|baseline| {
            baseline.run == input.run && baseline.state == ArtifactBaselineState::Ready
        })
        .and_then(|baseline| baseline.entries.get(entry.index))
        .filter(|previous| previous.index == entry.index && previous.path == entry.path);
    match baseline {
        Some(previous) if matches!(previous.status, Missing | SkippedMissing) => Passed,
        Some(previous)
            if previous.status == Passed
                && valid_observation_hash(previous)
                && valid_observation_hash(entry) =>
        {
            match (&previous.sha256, &entry.sha256) {
                (Some(before), Some(after)) if before.eq_ignore_ascii_case(after) => Unchanged,
                (Some(_), Some(_)) => Passed,
                _ => Unavailable,
            }
        }
        _ => Unavailable,
    }
}

pub(super) fn valid_observation_hash(entry: &ArtifactValidationEntry) -> bool {
    entry.size_bytes.is_some()
        && entry
            .sha256
            .as_ref()
            .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Streaming KMP keeps at most one bounded prefix table per explicit literal.
struct LiteralMatcher<'a> {
    bytes: &'a [u8],
    prefixes: Vec<usize>,
    matched: usize,
}

impl<'a> LiteralMatcher<'a> {
    fn new(literal: &'a str) -> Self {
        let bytes = literal.as_bytes();
        let mut prefixes = vec![0; bytes.len()];
        let mut matched = 0;
        for index in 1..bytes.len() {
            while matched > 0 && bytes[index] != bytes[matched] {
                matched = prefixes[matched - 1];
            }
            if bytes[index] == bytes[matched] {
                matched += 1;
            }
            prefixes[index] = matched;
        }
        Self {
            bytes,
            prefixes,
            matched: 0,
        }
    }

    fn scan(&mut self, chunk: &[u8]) -> bool {
        // Empty literals are rejected at declaration boundaries.
        if self.bytes.is_empty() {
            return false;
        }
        for &byte in chunk {
            while self.matched > 0 && byte != self.bytes[self.matched] {
                self.matched = self.prefixes[self.matched - 1];
            }
            if byte == self.bytes[self.matched] {
                self.matched += 1;
            }
            if self.matched == self.bytes.len() {
                self.matched = self.prefixes[self.matched - 1];
                return true;
            }
        }
        false
    }
}

fn inspect_file(
    input: &ValidationInput,
    requirement: &ArtifactRequirement,
    entry: &mut ArtifactValidationEntry,
    total: &mut u64,
) -> ArtifactValidationStatus {
    use ArtifactValidationStatus::*;
    if input.stop.is_cancelled() {
        return Unavailable;
    }
    let declared = Path::new(&requirement.path);
    if requirement.path.starts_with('~')
        || declared
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return InvalidPath;
    }
    let path = if declared.is_absolute() {
        declared.to_path_buf()
    } else {
        input.cwd.join(declared)
    };
    let scope = if input.allowed_write_paths.is_empty() {
        vec![input.cwd.to_string_lossy().into_owned()]
    } else {
        input.allowed_write_paths.clone()
    };
    if !input.read_enabled
        || kcoder_tools::check_allowed_write_path(&input.cwd, &scope, &path).is_err()
        || kcoder_tools::check_allowed_write_path(&input.cwd, &input.runtime_write_paths, &path)
            .is_err()
        || input.sandbox.check_path(&path, false).is_err()
        || !matches!(
            input.permissions.decide(
                &kcoder_tools::FileReadTool,
                &serde_json::json!({"file_path":path})
            ),
            kcoder_permissions::PermissionDecision::Allow
        )
    {
        return Denied;
    }
    let Some(parent) = path.parent() else {
        return InvalidPath;
    };
    let Some(name) = path.file_name() else {
        return InvalidPath;
    };
    let opened = kcoder_config::PrivateDirectory::open_existing(parent)
        .and_then(|directory| directory.open_regular_file(name));
    let mut file = match opened {
        Ok(file) => file,
        Err(error) => {
            let kind = error.chain().find_map(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .map(std::io::Error::kind)
            });
            return match kind {
                Some(std::io::ErrorKind::NotFound) if !requirement.required => SkippedMissing,
                Some(std::io::ErrorKind::NotFound) => Missing,
                Some(std::io::ErrorKind::PermissionDenied) => Denied,
                _ => Unavailable,
            };
        }
    };
    let Ok(metadata) = file.metadata() else {
        return Unavailable;
    };
    if !metadata.is_file() {
        return NotRegular;
    }
    entry.size_bytes = Some(metadata.len());
    if metadata.len() > FILE_LIMIT {
        return TooLarge;
    }
    if metadata.len() > TOTAL_LIMIT.saturating_sub(*total) {
        return ReadLimit;
    }
    let mut hash = Sha256::new();
    let mut matchers: Vec<_> = requirement
        .forbidden_literals
        .iter()
        .map(|literal| LiteralMatcher::new(literal))
        .collect();
    let mut forbidden = false;
    let mut size = 0u64;
    let mut buffer = [0u8; 16 * 1024];
    loop {
        if input.stop.is_cancelled() {
            return Unavailable;
        }
        // Never issue a read exceeding either budget, even for a growing file.
        let available = (FILE_LIMIT - size).min(TOTAL_LIMIT - *total);
        if available == 0 {
            // Metadata and consumed bytes must agree at an exact budget boundary.
            if file.metadata().ok().is_none_or(|meta| meta.len() != size) {
                return ReadLimit;
            }
            break;
        }
        let capacity = buffer.len().min(available as usize);
        let count = match file.read(&mut buffer[..capacity]) {
            Ok(count) => count,
            Err(_) => return Unavailable,
        };
        if count == 0 {
            break;
        }
        size += count as u64;
        *total += count as u64;
        hash.update(&buffer[..count]);
        if !forbidden && !matchers.is_empty() {
            forbidden = matchers
                .iter_mut()
                .any(|matcher| matcher.scan(&buffer[..count]));
        }
    }
    if file.metadata().ok().is_none_or(|after| {
        after.len() != size || after.modified().ok() != metadata.modified().ok()
    }) {
        return Unavailable;
    }
    entry.size_bytes = Some(size);
    entry.sha256 = Some(format!("{:x}", hash.finalize()));
    if size < requirement.min_bytes {
        TooSmall
    } else if forbidden {
        ForbiddenContent
    } else {
        Passed
    }
}
