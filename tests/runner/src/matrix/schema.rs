use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestMatrix {
    pub schema_version: u32,
    #[serde(default)]
    pub suite: Vec<Suite>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Suite {
    pub id: String,
    pub tiers: Vec<String>,
    pub command: Vec<String>,
    #[serde(default)]
    pub summary: Option<SummaryPolicy>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub setup: bool,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub requires_commands: Vec<String>,
    #[serde(default)]
    pub requires_files: Vec<PathBuf>,
    #[serde(default)]
    pub required_artifacts: Vec<PathBuf>,
    #[serde(default)]
    pub requires_env: Vec<String>,
    #[serde(default)]
    pub requires_executables: Vec<RequiredExecutable>,
    #[serde(default)]
    pub requires_any_env: Vec<Vec<String>>,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub consent: Option<String>,
    #[serde(default)]
    pub consent_env: Option<String>,
    #[serde(default)]
    pub pass_env: Vec<String>,
    #[serde(default)]
    pub secret_env: Vec<String>,
    #[serde(default)]
    pub secret_env_selectors: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SummaryPolicy {
    pub parser: SummaryParser,
    #[serde(default)]
    pub allow_zero: bool,
    #[serde(default)]
    pub expected_skips: ExpectedSkips,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SummaryParser {
    Cargo,
    Node,
    VitestJson,
    AssertionsJson,
    ExitCode,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ExpectedSkips {
    Exact(u64),
    Any(String),
    Platform(BTreeMap<String, PlatformExpectedSkips>),
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum PlatformExpectedSkips {
    Exact(u64),
    Any(String),
}

impl Default for ExpectedSkips {
    fn default() -> Self {
        Self::Exact(0)
    }
}

impl ExpectedSkips {
    pub fn accepts(&self, actual: u64) -> bool {
        match self {
            Self::Exact(expected) => *expected == actual,
            Self::Any(value) => value == "any",
            Self::Platform(expected) => expected.get(std::env::consts::OS).is_some_and(|value| {
                matches!(value, PlatformExpectedSkips::Exact(count) if *count == actual)
                    || matches!(value, PlatformExpectedSkips::Any(wildcard) if wildcard == "any")
            }),
        }
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RequiredExecutable {
    pub env: String,
    #[serde(default)]
    pub allow_external: bool,
}

fn default_timeout() -> u64 {
    600
}

impl TestMatrix {
    pub fn load(path: &Path) -> Result<Self> {
        let source = fs::read_to_string(path)
            .with_context(|| format!("读取测试矩阵失败: {}", path.display()))?;
        let matrix: Self = toml::from_str(&source)
            .with_context(|| format!("解析测试矩阵失败: {}", path.display()))?;
        matrix.validate()?;
        anyhow::ensure!(
            matrix.suite.iter().all(|suite| suite.summary.is_some()),
            "项目 matrix 的每个 suite 都必须声明 summary 合同"
        );
        Ok(matrix)
    }
}
