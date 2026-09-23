use crate::{RunManifest, RunStatus};
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub struct RetentionPolicy {
    pub max_age: Duration,
    pub keep_latest: usize,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct RetentionReport {
    pub removed: Vec<PathBuf>,
    pub retained: Vec<PathBuf>,
    pub ignored: Vec<PathBuf>,
}

pub fn prune_runs(root: &Path, policy: RetentionPolicy, now_ms: u64) -> Result<RetentionReport> {
    let mut report = RetentionReport::default();
    if !root.exists() {
        return Ok(report);
    }
    anyhow::ensure!(
        !fs::symlink_metadata(root)?.file_type().is_symlink(),
        "测试运行根不能是符号链接"
    );
    anyhow::ensure!(root.is_dir(), "测试运行根不是目录: {}", root.display());

    let mut candidates = Vec::new();
    for entry in
        fs::read_dir(root).with_context(|| format!("读取测试运行根失败: {}", root.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if !file_type.is_dir() || file_type.is_symlink() {
            report.ignored.push(path);
            continue;
        }
        let manifest_path = path.join("manifest.json");
        let Ok(manifest) = RunManifest::read(&manifest_path) else {
            report.ignored.push(path);
            continue;
        };
        if manifest.status == RunStatus::Running || !manifest.status.is_terminal() {
            report.retained.push(path);
            continue;
        }
        let Some(finished_at_ms) = manifest.finished_at_ms else {
            report.ignored.push(path);
            continue;
        };
        candidates.push((finished_at_ms, path));
    }

    candidates.sort_by_key(|(finished_at_ms, _)| std::cmp::Reverse(*finished_at_ms));
    let max_age_ms = u64::try_from(policy.max_age.as_millis()).unwrap_or(u64::MAX);
    for (index, (finished_at_ms, path)) in candidates.into_iter().enumerate() {
        let too_old = now_ms.saturating_sub(finished_at_ms) > max_age_ms;
        if index < policy.keep_latest || !too_old {
            report.retained.push(path);
            continue;
        }
        let parent = path.parent().context("测试运行目录没有父目录")?;
        anyhow::ensure!(parent == root, "拒绝删除测试运行根之外的目录");
        fs::remove_dir_all(&path)
            .with_context(|| format!("删除过期测试运行失败: {}", path.display()))?;
        report.removed.push(path);
    }
    Ok(report)
}
