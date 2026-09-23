use crate::matrix::{SummaryParser, SummaryPolicy};
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TestSummary {
    pub parser: &'static str,
    pub total: u64,
    pub passed: u64,
    pub failed: u64,
    pub skipped: u64,
}

pub fn verify_summary(
    policy: &SummaryPolicy,
    stdout: &Path,
    stderr: &Path,
    artifacts: Option<&Path>,
) -> Result<TestSummary> {
    let summary = match policy.parser {
        SummaryParser::Cargo => parse_cargo(&read_combined(stdout, stderr)?),
        SummaryParser::Node => parse_node(&read_combined(stdout, stderr)?),
        SummaryParser::VitestJson => parse_vitest_json(&read_combined(stdout, stderr)?),
        SummaryParser::AssertionsJson => parse_assertions_json(
            &fs::read_to_string(find_unique_artifact(
                artifacts.context("assertions summary 缺少 artifact 目录")?,
                "assertions.json",
            )?)
            .context("读取 assertions.json 失败")?,
        ),
        SummaryParser::ExitCode => Ok(TestSummary {
            parser: "exit-code",
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
        }),
    }?;

    anyhow::ensure!(
        summary.total == checked_total(summary.passed, summary.failed, summary.skipped)?,
        "测试 summary 计数不一致: {summary:?}"
    );
    anyhow::ensure!(
        summary.failed == 0,
        "测试 summary 报告失败 leaf: {summary:?}"
    );
    anyhow::ensure!(
        policy.allow_zero || summary.total > 0,
        "测试 summary 没有有效 leaf"
    );
    anyhow::ensure!(
        policy.expected_skips.accepts(summary.skipped),
        "测试 summary 出现 unexpected skip: 实际 {}，策略 {:?}",
        summary.skipped,
        policy.expected_skips
    );
    Ok(summary)
}

fn checked_total(passed: u64, failed: u64, skipped: u64) -> Result<u64> {
    passed
        .checked_add(failed)
        .and_then(|value| value.checked_add(skipped))
        .context("测试 summary 总计溢出")
}

fn find_unique_artifact(root: &Path, name: &str) -> Result<std::path::PathBuf> {
    let mut pending = vec![root.to_path_buf()];
    let mut matches = Vec::new();
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(&path)
            .with_context(|| format!("读取 artifact 目录失败: {}", path.display()))?
        {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() && entry.file_name() == name {
                matches.push(entry.path());
            }
        }
    }
    anyhow::ensure!(matches.len() == 1, "artifact 中必须恰有一个 {name}");
    Ok(matches.remove(0))
}

fn read_combined(stdout: &Path, stderr: &Path) -> Result<String> {
    let mut text = fs::read_to_string(stdout).context("读取 suite stdout summary 失败")?;
    text.push('\n');
    text.push_str(&fs::read_to_string(stderr).context("读取 suite stderr summary 失败")?);
    Ok(text)
}

fn parse_cargo(text: &str) -> Result<TestSummary> {
    // Concurrent libtest subprocesses can split headers across lines and append
    // several complete count groups to one line. Account for every header and
    // require one intact count group per header; never skip damaged summaries.
    let summaries = text.matches("test result:").count();
    anyhow::ensure!(summaries > 0, "Cargo 输出缺少 test result summary");
    for label in ["passed;", "failed;", "ignored;"] {
        anyhow::ensure!(
            text.matches(&format!(" {label}")).count() == summaries,
            "Cargo summary 标记与 {label} 计数组数量不一致"
        );
    }
    let mut passed = 0_u64;
    let mut failed = 0_u64;
    let mut skipped = 0_u64;
    for (index, marker) in text.match_indices(" passed;") {
        let count = text[..index]
            .split_whitespace()
            .next_back()
            .context("Cargo passed 计数字段缺少数值")?
            .parse::<u64>()
            .context("Cargo passed 不是安全整数")?;
        let (failed_field, rest) = text[index + marker.len()..]
            .trim_start()
            .split_once(';')
            .context("Cargo summary 缺少 failed 字段")?;
        let (ignored_field, _) = rest
            .trim_start()
            .split_once(';')
            .context("Cargo summary 缺少 ignored 字段")?;
        passed = passed.checked_add(count).context("Cargo passed 溢出")?;
        failed = failed
            .checked_add(cargo_count_field(failed_field, "failed")?)
            .context("Cargo failed 溢出")?;
        skipped = skipped
            .checked_add(cargo_count_field(ignored_field, "ignored")?)
            .context("Cargo ignored 溢出")?;
    }
    Ok(TestSummary {
        parser: "cargo",
        total: checked_total(passed, failed, skipped)?,
        passed,
        failed,
        skipped,
    })
}

fn cargo_count_field(field: &str, label: &str) -> Result<u64> {
    let tokens = field.split_whitespace().collect::<Vec<_>>();
    anyhow::ensure!(
        tokens.len() == 2 && tokens[1] == label,
        "Cargo summary {label} 字段格式无效"
    );
    tokens[0]
        .parse::<u64>()
        .with_context(|| format!("summary {label} 不是安全整数"))
}

fn parse_node(text: &str) -> Result<TestSummary> {
    let field = |name: &str| -> Result<u64> {
        let spec_prefix = format!("ℹ {name} ");
        let tap_prefix = format!("# {name} ");
        let values = text
            .lines()
            .map(str::trim)
            .filter_map(|line| {
                line.strip_prefix(&spec_prefix)
                    .or_else(|| line.strip_prefix(&tap_prefix))
            })
            .map(str::parse::<u64>)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        anyhow::ensure!(values.len() == 1, "Node summary 必须恰有一个 {name} 字段");
        Ok(values[0])
    };
    let total = field("tests")?;
    let passed = field("pass")?;
    let failed = field("fail")?
        .checked_add(field("cancelled")?)
        .context("Node failed 计数溢出")?;
    let skipped = field("skipped")?
        .checked_add(field("todo")?)
        .context("Node skip 计数溢出")?;
    Ok(TestSummary {
        parser: "node",
        total,
        passed,
        failed,
        skipped,
    })
}

fn parse_vitest_json(source: &str) -> Result<TestSummary> {
    let values = source
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.get("numTotalTests").is_some())
        .collect::<Vec<_>>();
    anyhow::ensure!(values.len() == 1, "Vitest 输出必须恰有一个 JSON summary");
    let value = &values[0];
    let total = json_count(value, "numTotalTests")?;
    let passed = json_count(value, "numPassedTests")?;
    let failed = json_count(value, "numFailedTests")?;
    let skipped = json_count(value, "numPendingTests")?
        .checked_add(json_count(value, "numTodoTests")?)
        .context("Vitest skip 计数溢出")?;
    Ok(TestSummary {
        parser: "vitest-json",
        total,
        passed,
        failed,
        skipped,
    })
}

fn parse_assertions_json(source: &str) -> Result<TestSummary> {
    let value: Value = serde_json::from_str(source).context("解析 assertions.json 失败")?;
    let checks = value["checks"]
        .as_array()
        .context("assertions.json 缺少 checks 数组")?;
    let passed = checks.iter().filter(|check| check["ok"] == true).count() as u64;
    let failed = checks.len() as u64 - passed;
    anyhow::ensure!(
        value["ok"].as_bool() == Some(failed == 0),
        "assertions ok 与 checks 不一致"
    );
    Ok(TestSummary {
        parser: "assertions-json",
        total: checks.len() as u64,
        passed,
        failed,
        skipped: 0,
    })
}

fn json_count(value: &Value, field: &str) -> Result<u64> {
    value[field]
        .as_u64()
        .with_context(|| format!("JSON summary 缺少非负安全整数 {field}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matrix::ExpectedSkips;

    fn policy(parser: SummaryParser) -> SummaryPolicy {
        SummaryPolicy {
            parser,
            allow_zero: false,
            expected_skips: ExpectedSkips::Exact(0),
        }
    }

    #[test]
    fn cargo_summary_recovers_interleaved_process_output_without_dropping_leaves() {
        let source = "test process_worker ... ok\n\
            test result: okok\ntest result: \n\
            ok. 1 passed; 0 failed; 0 ignored; 0 measured; 6 filtered out. 1 passed; 0 failed; 0 ignored; 0 measured; 6 filtered out; finished in 0.01s\n\
            ; finished in 0.01stest result: \n\
            ok. 1 passed; 0 failed; 0 ignored; 0 measured; 6 filtered out; finished in 0.01s\n";
        let summary = parse_cargo(source).unwrap();
        assert_eq!(summary.passed, 3);
        assert_eq!(summary.total, 3);
        assert_eq!(summary.failed, 0);
        let failed_source = source.replacen("1 passed; 0 failed", "0 passed; 1 failed", 1);
        let failed_summary = parse_cargo(&failed_source).unwrap();
        assert_eq!(failed_summary.passed, 2);
        assert_eq!(failed_summary.failed, 1);
        assert_eq!(failed_summary.total, 3);
    }

    #[test]
    fn cargo_summary_rejects_incomplete_or_ambiguous_interleaving() {
        for source in [
            "test result: ok. 1 passed; 0 ignored;",
            "test result: ok. 1 passed; 0 failed;",
            "test result: ok. nope passed; 0 failed; 0 ignored;",
            "test result: ok. 18446744073709551616 passed; 0 failed; 0 ignored;",
            "test result: ok. 1 passed; 0 failed; 0 ignored;\ntest result: ",
            "test result: ok. 1 passed; 0 failed; 0 ignored; 1 passed; 0 failed; 0 ignored;",
            "test result: ok. 1 passed; 0 failed; 0 failed; 0 ignored;",
            "test result: ok. 1 passed; 0 failed; 0 ignored;\ntest result: ok. 18446744073709551615 passed; 0 failed; 0 ignored;",
        ] {
            assert!(parse_cargo(source).is_err(), "{source}");
        }
    }

    #[test]
    fn cargo_contract_rejects_zero_failed_and_unexpected_ignored() {
        let aggregate = parse_cargo(
            "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n\
             test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
        )
        .unwrap();
        assert_eq!(
            aggregate.total, 2,
            "空 doc-test summary 不得覆盖 suite 的有效 leaf"
        );
        let summary = parse_cargo(
            "test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out",
        )
        .unwrap();
        assert!(
            !policy(SummaryParser::Cargo)
                .expected_skips
                .accepts(summary.skipped)
        );
        assert!(parse_cargo("noise only").is_err());
    }

    #[test]
    fn node_and_vitest_contracts_require_consistent_framework_counts() {
        for prefix in ["ℹ", "#"] {
            let node = parse_node(&format!(
                "{prefix} tests 2\n{prefix} pass 2\n{prefix} fail 0\n{prefix} cancelled 0\n{prefix} skipped 0\n{prefix} todo 0\n"
            ))
            .unwrap();
            assert_eq!(node.total, 2);
        }
        let vitest = parse_vitest_json(r#"{"numTotalTests":2,"numPassedTests":2,"numFailedTests":0,"numPendingTests":0,"numTodoTests":0}"#).unwrap();
        assert_eq!(
            vitest,
            TestSummary {
                parser: "vitest-json",
                total: 2,
                passed: 2,
                failed: 0,
                skipped: 0
            }
        );
    }

    #[test]
    fn assertions_contract_rejects_mismatched_top_level_status() {
        assert!(parse_assertions_json(r#"{"ok":true,"checks":[{"ok":true}]}"#).is_ok());
        assert!(parse_assertions_json(r#"{"ok":true,"checks":[{"ok":false}]}"#).is_err());
    }

    #[test]
    fn verifier_rejects_zero_failed_unexpected_skip_and_inconsistent_totals() {
        let temporary = tempfile::tempdir().unwrap();
        let stdout = temporary.path().join("stdout.log");
        let stderr = temporary.path().join("stderr.log");
        fs::write(&stderr, "").unwrap();
        for (source, expected) in [
            (
                "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
                "没有有效 leaf",
            ),
            (
                "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out",
                "失败 leaf",
            ),
            (
                "test result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out",
                "unexpected skip",
            ),
        ] {
            fs::write(&stdout, source).unwrap();
            let error =
                verify_summary(&policy(SummaryParser::Cargo), &stdout, &stderr, None).unwrap_err();
            assert!(format!("{error:#}").contains(expected));
        }

        fs::write(
            &stdout,
            "ℹ tests 3\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n",
        )
        .unwrap();
        let error =
            verify_summary(&policy(SummaryParser::Node), &stdout, &stderr, None).unwrap_err();
        assert!(format!("{error:#}").contains("计数不一致"));
    }
}
