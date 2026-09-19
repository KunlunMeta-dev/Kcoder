use anyhow::{Context, Result};
use kcoder_test_harness::{RetentionPolicy, prune_runs};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PROJECT_RUN_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
const PROJECT_RUN_KEEP_LATEST: usize = 20;

pub fn prune_project_runs(root: &Path) -> Result<usize> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    let report = prune_runs(
        root,
        RetentionPolicy {
            max_age: PROJECT_RUN_MAX_AGE,
            keep_latest: PROJECT_RUN_KEEP_LATEST,
        },
        now_ms,
    )
    .with_context(|| format!("清理项目测试历史运行失败: {}", root.display()))?;
    Ok(report.removed.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_test_harness::{ModelPolicy, RunContext, RunMetadata, RunStatus, TestTier};

    #[test]
    fn project_retention_ignores_missing_root() {
        let temporary = tempfile::tempdir().unwrap();
        let missing = temporary.path().join("missing");

        assert_eq!(prune_project_runs(&missing).unwrap(), 0);
        assert!(!missing.exists());
    }

    #[test]
    fn project_retention_keeps_current_terminal_run() {
        let temporary = tempfile::tempdir().unwrap();
        let mut context = RunContext::create(
            temporary.path(),
            RunMetadata::new("project-test-runner", TestTier::Pr, ModelPolicy::Forbidden),
        )
        .unwrap();
        let run_root = context.root().to_path_buf();
        context.finish(RunStatus::Passed, None).unwrap();

        assert_eq!(prune_project_runs(temporary.path()).unwrap(), 0);
        assert!(run_root.join("manifest.json").is_file());
    }
}
