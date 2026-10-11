use crate::matrix::Suite;
use crate::report::SuiteOutcome;
use anyhow::Result;
use kcoder_test_harness::RunContext;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
struct SuiteExecutionManifest<'a> {
    schema_version: u32,
    suite: &'a str,
    argv: Vec<String>,
    cwd: String,
    git_commit: &'a Option<String>,
    seed: Option<u64>,
    platform: &'a str,
    platform_arch: &'a str,
    runner_version: &'a str,
    started_at_ms: u64,
    finished_at_ms: u64,
    terminal: bool,
    executed: bool,
    status: &'static str,
    nested_artifacts: Vec<String>,
    cleanup: Vec<String>,
    outcome: &'a SuiteOutcome,
}

pub fn persist_suite_manifest(
    context: &RunContext,
    root: &Path,
    suite: &Suite,
    outcome: &SuiteOutcome,
) -> Result<String> {
    let metadata = &context.manifest().metadata;
    let finished_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let duration_ms = outcome
        .duration_ms()
        .unwrap_or_default()
        .min(u128::from(u64::MAX)) as u64;
    let artifact_dir = context.case_path(&suite.id, "artifacts")?;
    let argv = suite
        .command
        .iter()
        .map(|part| {
            if part == "{artifact_dir}" {
                artifact_dir.to_string_lossy().into_owned()
            } else {
                part.clone()
            }
        })
        .collect();
    let cwd = suite
        .cwd
        .as_ref()
        .map_or_else(|| root.to_path_buf(), |path| root.join(path));
    let nested_artifacts = outcome
        .domain_artifacts()
        .map(|path| vec![path.to_string()])
        .unwrap_or_default();
    let (started_at_ms, cleanup) = match outcome {
        SuiteOutcome::RunnerError {
            started_at_ms,
            cleanup,
            ..
        } => (*started_at_ms, cleanup.clone()),
        _ if outcome.executed() => (
            finished_at_ms.saturating_sub(duration_ms),
            vec!["process-tree-reaped".into(), "log-streams-finalized".into()],
        ),
        _ => (finished_at_ms, Vec::new()),
    };
    let manifest = SuiteExecutionManifest {
        schema_version: 1,
        suite: &suite.id,
        argv,
        cwd: cwd.to_string_lossy().into_owned(),
        git_commit: &metadata.git_commit,
        seed: metadata.seed,
        platform: &metadata.platform,
        platform_arch: &metadata.platform_arch,
        runner_version: &metadata.runner_version,
        started_at_ms,
        finished_at_ms,
        terminal: true,
        executed: outcome.executed(),
        status: outcome.status(),
        nested_artifacts,
        cleanup,
        outcome,
    };
    let path = context.write_case_json(&suite.id, "execution.json", &manifest)?;
    Ok(path
        .strip_prefix(context.root())
        .unwrap_or(&path)
        .to_string_lossy()
        .replace('\\', "/"))
}
