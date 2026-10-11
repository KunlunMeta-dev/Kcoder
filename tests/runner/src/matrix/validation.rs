use super::dependency_graph::ensure_acyclic;
use super::schema::{ExpectedSkips, PlatformExpectedSkips, SummaryParser, TestMatrix};
use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::path::{Component, Path};

impl TestMatrix {
    pub(super) fn validate(&self) -> Result<()> {
        anyhow::ensure!(self.schema_version == 2, "不支持的 matrix schema");
        let mut ids = std::collections::BTreeSet::new();
        for suite in &self.suite {
            anyhow::ensure!(!suite.id.trim().is_empty(), "suite id 不能为空");
            anyhow::ensure!(ids.insert(&suite.id), "重复的 suite id: {}", suite.id);
            anyhow::ensure!(!suite.tiers.is_empty(), "suite {} 没有 tier", suite.id);
            anyhow::ensure!(!suite.command.is_empty(), "suite {} 没有 argv", suite.id);
            if let Some(summary) = &suite.summary {
                anyhow::ensure!(
                    !matches!(summary.expected_skips, ExpectedSkips::Any(ref value) if value != "any"),
                    "suite {} 的 expected_skips 字符串只允许 any",
                    suite.id
                );
                if let ExpectedSkips::Platform(expected) = &summary.expected_skips {
                    anyhow::ensure!(
                        !expected.is_empty()
                            && expected.keys().all(|platform| matches!(
                                platform.as_str(),
                                "linux" | "macos" | "windows"
                            )),
                        "suite {} 的 expected_skips 平台键只允许 linux/macos/windows",
                        suite.id
                    );
                    anyhow::ensure!(
                        expected.values().all(|value| {
                            !matches!(value, PlatformExpectedSkips::Any(wildcard) if wildcard != "any")
                        }),
                        "suite {} 的平台 expected_skips 字符串只允许 any",
                        suite.id
                    );
                }
                anyhow::ensure!(
                    !matches!(summary.parser, SummaryParser::ExitCode) || summary.allow_zero,
                    "suite {} 的 exit-code summary 必须显式 allow_zero",
                    suite.id
                );
            }
            anyhow::ensure!(
                suite.command.iter().all(|part| !part.is_empty()),
                "suite {} 包含空 argv",
                suite.id
            );
            anyhow::ensure!(
                suite.command[0] != "{artifact_dir}",
                "suite {} 不能用 artifact placeholder 作为 executable",
                suite.id
            );
            anyhow::ensure!(
                suite.command.iter().all(|part| {
                    (!part.contains('{') && !part.contains('}')) || part == "{artifact_dir}"
                }),
                "suite {} 包含未知 argv placeholder",
                suite.id
            );
            anyhow::ensure!(
                suite.timeout_seconds > 0,
                "suite {} timeout 必须大于 0",
                suite.id
            );
            let protected_tiers = suite
                .tiers
                .iter()
                .filter(|tier| {
                    matches!(
                        tier.as_str(),
                        "platform" | "external-provider" | "real-model"
                    )
                })
                .collect::<Vec<_>>();
            anyhow::ensure!(
                protected_tiers.len() <= 1,
                "suite {} 不能同时属于多个受保护 tier",
                suite.id
            );
            if let Some(tier) = protected_tiers.first() {
                if suite.setup {
                    anyhow::ensure!(
                        suite.consent.is_none() && suite.consent_env.is_none(),
                        "setup suite {} 不应声明 consent",
                        suite.id
                    );
                } else {
                    if tier.as_str() == "platform" {
                        anyhow::ensure!(
                            suite
                                .consent
                                .as_ref()
                                .is_some_and(|value| !value.trim().is_empty()),
                            "platform suite {} 必须声明非空 consent gate",
                            suite.id
                        );
                    } else {
                        anyhow::ensure!(
                            suite.consent.as_deref() == Some(tier.as_str()),
                            "suite {} 的 consent 必须匹配受保护 tier {}",
                            suite.id,
                            tier
                        );
                    }
                    let consent_env = suite
                        .consent_env
                        .as_ref()
                        .context("受保护 suite 缺少 consent_env")?;
                    anyhow::ensure!(
                        suite.pass_env.contains(consent_env),
                        "suite {} 的 consent_env 必须显式列入 pass_env",
                        suite.id
                    );
                    anyhow::ensure!(
                        !suite
                            .tiers
                            .iter()
                            .any(|tier| tier == "pr" || tier == "full"),
                        "suite {} 的受保护 tier 不能进入 pr/full",
                        suite.id
                    );
                }
            } else {
                anyhow::ensure!(
                    suite.consent.is_none() && suite.consent_env.is_none(),
                    "suite {} 非受保护 tier 不应声明 consent",
                    suite.id
                );
            }
            if let Some(cwd) = &suite.cwd {
                validate_relative(cwd, &suite.id)?;
            }
            for path in &suite.requires_files {
                validate_relative(path, &suite.id)?;
            }
            for path in &suite.required_artifacts {
                validate_relative(path, &suite.id)?;
                anyhow::ensure!(
                    !path.as_os_str().is_empty(),
                    "suite {} 的 artifact contract 不能为空",
                    suite.id
                );
            }
            anyhow::ensure!(
                suite.required_artifacts.is_empty()
                    || suite.command.iter().any(|part| part == "{artifact_dir}"),
                "suite {} 声明 artifact contract 时必须传递 artifact placeholder",
                suite.id
            );
            for name in suite
                .env
                .keys()
                .chain(suite.pass_env.iter())
                .chain(suite.requires_env.iter())
                .chain(
                    suite
                        .requires_executables
                        .iter()
                        .map(|requirement| &requirement.env),
                )
                .chain(suite.requires_any_env.iter().flatten())
                .chain(suite.secret_env.iter())
                .chain(suite.secret_env_selectors.iter())
            {
                anyhow::ensure!(
                    valid_env_name(name),
                    "suite {} 环境变量名无效: {name}",
                    suite.id
                );
            }
            for name in &suite.requires_env {
                anyhow::ensure!(
                    suite.pass_env.contains(name),
                    "suite {} 的 required env 必须显式列入 pass_env: {name}",
                    suite.id
                );
            }
            for requirement in &suite.requires_executables {
                anyhow::ensure!(
                    suite.pass_env.contains(&requirement.env),
                    "suite {} 的 executable env 必须显式列入 pass_env: {}",
                    suite.id,
                    requirement.env
                );
            }
            anyhow::ensure!(
                suite
                    .requires_executables
                    .iter()
                    .map(|requirement| requirement.env.as_str())
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    == suite.requires_executables.len(),
                "suite {} 的 requires_executables 不能包含重复 env",
                suite.id
            );
            for alternatives in &suite.requires_any_env {
                anyhow::ensure!(
                    alternatives.len() >= 2,
                    "suite {} 的 requires_any_env 每组至少需要两个候选项",
                    suite.id
                );
                for name in alternatives {
                    anyhow::ensure!(
                        suite.pass_env.contains(name),
                        "suite {} 的可选 required env 必须显式列入 pass_env: {name}",
                        suite.id
                    );
                }
                anyhow::ensure!(
                    alternatives
                        .iter()
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        == alternatives.len(),
                    "suite {} 的 requires_any_env 不能包含重复候选项",
                    suite.id
                );
            }
            for name in &suite.secret_env {
                anyhow::ensure!(
                    suite.pass_env.contains(name),
                    "suite {} 的 secret_env 必须显式列入 pass_env: {name}",
                    suite.id
                );
            }
            for name in &suite.secret_env_selectors {
                anyhow::ensure!(
                    suite.pass_env.contains(name),
                    "suite {} 的 secret selector 必须显式列入 pass_env: {name}",
                    suite.id
                );
            }
            for name in suite.env.keys() {
                anyhow::ensure!(
                    !sensitive_env_name(name),
                    "suite {} 不能在 matrix 内写入敏感环境变量: {name}",
                    suite.id
                );
            }
        }
        let suites = self
            .suite
            .iter()
            .map(|suite| (suite.id.as_str(), suite))
            .collect::<BTreeMap<_, _>>();
        for suite in &self.suite {
            for dependency_id in &suite.depends_on {
                anyhow::ensure!(
                    dependency_id != &suite.id,
                    "suite {} 不能依赖自身",
                    suite.id
                );
                let dependency = suites.get(dependency_id.as_str()).with_context(|| {
                    format!("suite {} 依赖未知 suite: {dependency_id}", suite.id)
                })?;
                let missing_tiers = suite
                    .tiers
                    .iter()
                    .filter(|tier| !dependency.tiers.contains(tier))
                    .cloned()
                    .collect::<Vec<_>>();
                anyhow::ensure!(
                    missing_tiers.is_empty(),
                    "suite {} 的依赖 {} 未覆盖 tier: {}",
                    suite.id,
                    dependency_id,
                    missing_tiers.join(", ")
                );
            }
        }
        let depended_on = self
            .suite
            .iter()
            .flat_map(|suite| suite.depends_on.iter())
            .collect::<std::collections::BTreeSet<_>>();
        for suite in self.suite.iter().filter(|suite| suite.setup) {
            anyhow::ensure!(
                depended_on.contains(&suite.id),
                "setup suite {} 必须至少被一个 suite 依赖",
                suite.id
            );
        }
        ensure_acyclic(&suites)?;
        Ok(())
    }
}

fn validate_relative(path: &Path, suite: &str) -> Result<()> {
    anyhow::ensure!(!path.is_absolute(), "suite {suite} 路径不能是绝对路径");
    anyhow::ensure!(
        !path
            .components()
            .any(|part| matches!(part, Component::ParentDir)),
        "suite {suite} 路径不能包含 .."
    );
    Ok(())
}

fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
}

fn sensitive_env_name(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"]
        .iter()
        .any(|fragment| name.contains(fragment))
}
