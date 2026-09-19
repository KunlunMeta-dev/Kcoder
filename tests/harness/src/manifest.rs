use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TestTier {
    Unit,
    Contract,
    Pr,
    Full,
    Platform,
    ExternalProvider,
    RealModel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelPolicy {
    Forbidden,
    Optional,
    Required,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunMetadata {
    pub suite: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case: Option<String>,
    pub tier: TestTier,
    pub model_policy: ModelPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    pub platform: String,
    #[serde(default)]
    pub platform_arch: String,
    #[serde(default)]
    pub runner_version: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

impl RunMetadata {
    pub fn new(suite: impl Into<String>, tier: TestTier, model_policy: ModelPolicy) -> Self {
        Self {
            suite: suite.into(),
            case: None,
            tier,
            model_policy,
            git_commit: None,
            seed: None,
            platform: std::env::consts::OS.to_string(),
            platform_arch: std::env::consts::ARCH.to_string(),
            runner_version: env!("CARGO_PKG_VERSION").to_string(),
            argv: Vec::new(),
            cwd: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Passed,
    Failed,
    Skipped,
    UnmetPrerequisite,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunManifest {
    pub schema_version: u32,
    pub run_id: String,
    pub metadata: RunMetadata,
    pub status: RunStatus,
    pub started_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unmet_prerequisites: Vec<crate::PrerequisiteResult>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl RunManifest {
    pub fn running(run_id: String, metadata: RunMetadata, started_at_ms: u64) -> Self {
        Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            run_id,
            metadata,
            status: RunStatus::Running,
            started_at_ms,
            finished_at_ms: None,
            unmet_prerequisites: Vec::new(),
            artifacts: Vec::new(),
            message: None,
        }
    }

    pub fn read(path: &Path) -> Result<Self> {
        let bytes = fs::read(path)
            .with_context(|| format!("读取测试 manifest 失败: {}", path.display()))?;
        let manifest: Self = serde_json::from_slice(&bytes)
            .with_context(|| format!("解析测试 manifest 失败: {}", path.display()))?;
        anyhow::ensure!(
            manifest.schema_version == MANIFEST_SCHEMA_VERSION,
            "不支持的测试 manifest schema: {}",
            manifest.schema_version
        );
        Ok(manifest)
    }
}
