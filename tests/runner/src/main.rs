mod command;
mod consent;
mod matrix;
mod report;
mod retention;
mod secrets;
mod selection;
mod suite_manifest;
mod summary;

use anyhow::{Context, Result, bail};
use clap::Parser;
use command::run_suite;
use consent::Consent;
use kcoder_test_harness::{
    ModelPolicy, RunContext, RunMetadata, RunStatus, TestTier, workspace_root,
};
use matrix::TestMatrix;
use report::{AggregateReport, SuiteOutcome};
use retention::prune_project_runs;
use secrets::register_passed_secrets;
use selection::Selection;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use suite_manifest::persist_suite_manifest;

#[derive(Debug, Parser)]
#[command(about = "KCoder project-level test matrix runner")]
struct Args {
    #[arg(long)]
    list: bool,
    #[arg(long, conflicts_with = "list")]
    list_all: bool,
    #[arg(long, default_value = "pr")]
    tier: String,
    #[arg(long = "suite")]
    suites: Vec<String>,
    #[arg(long)]
    keep_going: bool,
    #[arg(long)]
    real_model: bool,
    #[arg(long)]
    external_provider: bool,
    #[arg(long)]
    windows_vm: bool,
    #[arg(long = "consent", value_name = "GATE")]
    consent: Vec<String>,
    #[arg(long, default_value = "tests/matrix.toml")]
    matrix: PathBuf,
    #[arg(long, default_value = "target/test-runs/project")]
    artifacts: PathBuf,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let root = workspace_root()?;
    let matrix_path = resolve_existing_under(&root, &args.matrix)?;
    let matrix = TestMatrix::load(&matrix_path)?;
    if args.list || args.list_all {
        let suites = if args.list_all && args.suites.is_empty() {
            matrix.suite.iter().collect::<Vec<_>>()
        } else {
            Selection::new(&args.tier, &args.suites).select(&matrix)?
        };
        for suite in suites {
            println!(
                "{}\t{}\t{}",
                suite.id,
                suite.tiers.join(","),
                suite.command.join(" ")
            );
        }
        return Ok(());
    }

    let selection = Selection::new(&args.tier, &args.suites);
    let suites = selection.select(&matrix)?;

    let consent = Consent {
        real_model: args.real_model,
        external_provider: args.external_provider,
        windows_vm: args.windows_vm,
        gates: args.consent.into_iter().collect(),
    };
    let artifacts = resolve_output_under(&root, &args.artifacts)?;
    let removed_before_run = prune_project_runs(&artifacts)?;
    if removed_before_run > 0 {
        eprintln!("已清理 {removed_before_run} 个过期项目测试运行");
    }
    let (tier, model_policy) = manifest_policy(&args.tier);
    let mut metadata = RunMetadata::new("project-test-runner", tier, model_policy);
    metadata.case = Some(args.tier.clone());
    metadata.git_commit = git_commit(&root);
    metadata.seed = Some(run_seed());
    metadata.argv = std::env::args().collect();
    metadata.cwd = Some(root.to_string_lossy().into_owned());
    let mut context = RunContext::create(&artifacts, metadata)?;
    let selected = suites
        .iter()
        .map(|suite| suite.id.clone())
        .collect::<Vec<_>>();
    let run_result = (|| -> Result<bool> {
        register_passed_secrets(&mut context, &suites).context("注册敏感 credential 失败")?;
        let mut report = AggregateReport::new(args.tier.clone(), selected);
        let mut passed_suites = BTreeSet::new();
        let mut stopped_by = None;
        for suite in suites {
            let outcome = if let Some(failed_suite) = &stopped_by {
                SuiteOutcome::NotRun {
                    id: suite.id.clone(),
                    reason: format!("keep-going=false；前序 suite {failed_suite} 未通过"),
                }
            } else {
                let blocked_dependencies = suite
                    .depends_on
                    .iter()
                    .filter(|dependency| !passed_suites.contains(dependency.as_str()))
                    .cloned()
                    .collect::<Vec<_>>();
                if blocked_dependencies.is_empty() {
                    match run_suite(&root, &context, suite, &consent) {
                        Ok(outcome) => outcome,
                        Err(error) => SuiteOutcome::RunnerError {
                            id: suite.id.clone(),
                            error: context.redact_text(&format!("{:#}", error.source)),
                            started_at_ms: error.started_at_ms,
                            duration_ms: error.duration_ms,
                            stage: error.stage.to_string(),
                            executed: error.executed,
                            cleanup: error.cleanup,
                        },
                    }
                } else {
                    SuiteOutcome::UnmetPrerequisite {
                        id: suite.id.clone(),
                        reasons: vec![format!(
                            "依赖 suite 未通过: {}",
                            blocked_dependencies.join(", ")
                        )],
                    }
                }
            };
            if matches!(outcome, SuiteOutcome::Passed { .. }) {
                passed_suites.insert(suite.id.as_str());
            }
            let failed = !matches!(outcome, SuiteOutcome::Passed { .. });
            let execution_manifest = persist_suite_manifest(&context, &root, suite, &outcome)?;
            report.execution_manifests.push(execution_manifest);
            report.outcomes.push(outcome);
            if failed && !args.keep_going && stopped_by.is_none() {
                stopped_by = Some(suite.id.clone());
            }
        }

        let passed = report.is_success();
        context.write_artifact_json("aggregate.json", &report)?;
        Ok(passed)
    })();
    let passed = match run_result {
        Ok(passed) => passed,
        Err(error) => {
            let message = context.redact_text(&format!("runner 收尾前失败: {error:#}"));
            if let Err(finalize_error) = context.finish(RunStatus::Failed, Some(&message)) {
                return Err(anyhow::anyhow!(
                    "{error:#}; root manifest 失败收尾也失败: {finalize_error:#}"
                ));
            }
            return Err(error);
        }
    };
    context.finish(
        if passed {
            RunStatus::Passed
        } else {
            RunStatus::Failed
        },
        (!passed).then_some("一个或多个测试 suite 失败"),
    )?;
    let evidence_root = context.root().to_path_buf();
    let removed_after_run = prune_project_runs(&artifacts)?;
    if removed_after_run > 0 {
        eprintln!("测试结束后清理了 {removed_after_run} 个过期项目测试运行");
    }
    if !passed {
        bail!("测试矩阵存在失败；证据目录: {}", evidence_root.display());
    }
    println!("测试矩阵通过；证据目录: {}", evidence_root.display());
    Ok(())
}

fn validate_relative(path: &Path) -> Result<()> {
    anyhow::ensure!(
        !path.is_absolute(),
        "runner 路径必须相对工作区: {}",
        path.display()
    );
    anyhow::ensure!(
        !path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir)),
        "runner 路径不能包含 ..: {}",
        path.display()
    );
    Ok(())
}

fn resolve_existing_under(root: &Path, path: &Path) -> Result<PathBuf> {
    validate_relative(path)?;
    let resolved = root
        .join(path)
        .canonicalize()
        .with_context(|| format!("解析 runner 输入路径失败: {}", path.display()))?;
    anyhow::ensure!(
        resolved.starts_with(root),
        "runner 输入路径通过符号链接逃逸工作区"
    );
    Ok(resolved)
}

fn resolve_output_under(root: &Path, path: &Path) -> Result<PathBuf> {
    validate_relative(path)?;
    let target = root.join(path);
    let mut ancestor = target.as_path();
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .context("runner 输出路径没有已存在的父目录")?;
    }
    let resolved_ancestor = ancestor
        .canonicalize()
        .with_context(|| format!("解析 runner 输出父目录失败: {}", ancestor.display()))?;
    anyhow::ensure!(
        resolved_ancestor.starts_with(root),
        "runner 输出路径通过符号链接逃逸工作区"
    );
    Ok(target)
}

fn manifest_policy(tier: &str) -> (TestTier, ModelPolicy) {
    match tier {
        "full" => (TestTier::Full, ModelPolicy::Forbidden),
        "platform" => (TestTier::Platform, ModelPolicy::Forbidden),
        "external-provider" => (TestTier::ExternalProvider, ModelPolicy::Optional),
        "real-model" => (TestTier::RealModel, ModelPolicy::Required),
        _ => (TestTier::Pr, ModelPolicy::Forbidden),
    }
}

fn git_commit(root: &Path) -> Option<String> {
    std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn run_seed() -> u64 {
    std::env::var("KCODER_TEST_SEED")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as u64
                ^ u64::from(std::process::id())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_paths_reject_absolute_and_parent_components() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();

        assert!(resolve_existing_under(&root, Path::new("../outside")).is_err());
        assert!(resolve_output_under(&root, Path::new("/absolute")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn runner_paths_reject_symlinks_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        symlink(outside.path(), root.join("outside-link")).unwrap();

        assert!(resolve_existing_under(&root, Path::new("outside-link")).is_err());
        assert!(resolve_output_under(&root, Path::new("outside-link/artifacts")).is_err());
    }
}
