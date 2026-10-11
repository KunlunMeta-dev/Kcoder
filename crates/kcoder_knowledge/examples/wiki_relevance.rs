//! Fixed real repository corpus and hand-labelled lexical relevance evaluation.
//! Run once before and after a retrieval change; JSON includes every ranking.
use anyhow::{Result, ensure};
use kcoder_knowledge::{IndexedDocument, KnowledgeCatalog, KnowledgeScope};
use serde_json::json;
use std::{process::Command, time::Instant};
const REVISION: &str = "64b8a3ed0973bb9da04fe414f10b06c4e1c597d7";
const FILES: &[&str] = &[
    "docs/kcoder-wiki-validation-2026-09-29.md",
    "docs/kcoder-visual-workflows-2026-09-24.md",
    "docs/kcoder-workflow-enrichment-2026-09-24.md",
    "docs/kcoder-image-input-limits-2026-09-29.md",
    "docs/studio-extra-request-body.md",
    "docs/kcoder-computer-use-result-limit-fix-2026-09-29.md",
    "README.md",
    "docs/plugin-marketplace-presets-qa.md",
    "docs/provider-model-catalog.md",
    "docs/background-agent-notification-repair-plan.md",
];
// Relevant section labels fixed before changing search. Not model judgements.
const QUERIES: &[(&str, &str, &str)] = &[
    (
        "知识库索引重建",
        "docs/kcoder-wiki-validation-2026-09-29.md",
        "范围与发现",
    ),
    (
        "来源生命周期",
        "docs/kcoder-wiki-validation-2026-09-29.md",
        "来源生命周期增补",
    ),
    (
        "持久调用预算",
        "docs/kcoder-wiki-validation-2026-09-29.md",
        "持久调用预算领域验证",
    ),
    (
        "Markdown 外部编辑",
        "docs/kcoder-wiki-validation-2026-09-29.md",
        "可读 Markdown 外部编辑领域验证",
    ),
    (
        "页面导航首次概览",
        "docs/kcoder-wiki-validation-2026-09-29.md",
        "页面导航与首次概览闭环",
    ),
    (
        "llm_wiki 固定基线",
        "docs/kcoder-wiki-validation-2026-09-29.md",
        "llm_wiki 固定基线复核",
    ),
    (
        "PDF 第 17 页",
        "docs/kcoder-wiki-validation-2026-09-29.md",
        "范围与发现",
    ),
    (
        "schema v13",
        "docs/kcoder-wiki-validation-2026-09-29.md",
        "持久调用预算领域验证",
    ),
    (
        "近似检索 warm P95",
        "docs/kcoder-wiki-validation-2026-09-29.md",
        "一次性检索性能测试",
    ),
    (
        "来源更新 expected revision",
        "docs/kcoder-wiki-validation-2026-09-29.md",
        "来源生命周期增补",
    ),
    // No such identifier in the fixed revision; it must not alias wiki_projection.
    ("knowledge_projection", "", ""),
    (
        "可视化 Workflow",
        "docs/kcoder-visual-workflows-2026-09-24.md",
        "可视化 Workflow：实施与验收",
    ),
    (
        "工作流原生桌面",
        "docs/kcoder-visual-workflows-2026-09-24.md",
        "原生桌面",
    ),
    (
        "真实浏览器完整链路",
        "docs/kcoder-visual-workflows-2026-09-24.md",
        "真实浏览器完整链路",
    ),
    (
        "产品与数据边界",
        "docs/kcoder-visual-workflows-2026-09-24.md",
        "产品与数据边界",
    ),
    (
        "QA矩阵",
        "docs/kcoder-visual-workflows-2026-09-24.md",
        "QA矩阵（所有运行使用隔离profile/workspace）",
    ),
    (
        "工作流会话式设计",
        "docs/kcoder-workflow-enrichment-2026-09-24.md",
        "工作流增强与会话式设计（2026-09-24）",
    ),
    (
        "条件合并 any all",
        "docs/kcoder-workflow-enrichment-2026-09-24.md",
        "已实现的源码范围",
    ),
    (
        "workflowGraphV2",
        "docs/kcoder-workflow-enrichment-2026-09-24.md",
        "已实现的源码范围",
    ),
    (
        "Step-Code",
        "docs/kcoder-workflow-enrichment-2026-09-24.md",
        "参考项目取舍",
    ),
    (
        "递归条件 schema",
        "docs/kcoder-workflow-enrichment-2026-09-24.md",
        "故障与验收边界",
    ),
    (
        "workflowDefinitionId",
        "docs/kcoder-workflow-enrichment-2026-09-24.md",
        "已实现的源码范围",
    ),
    (
        "结构化输出修复",
        "docs/kcoder-workflow-enrichment-2026-09-24.md",
        "已实现的源码范围",
    ),
    (
        "图片尺寸原生视觉",
        "docs/kcoder-image-input-limits-2026-09-29.md",
        "图片尺寸与原生视觉",
    ),
    (
        "图片 8192 16777216",
        "docs/kcoder-image-input-limits-2026-09-29.md",
        "图片尺寸与原生视觉",
    ),
    (
        "MCP base64",
        "docs/kcoder-image-input-limits-2026-09-29.md",
        "图片尺寸与原生视觉",
    ),
    (
        "MiniMax 双协议",
        "docs/studio-extra-request-body.md",
        "MiniMax 双协议真实验收（2026-09-20）",
    ),
    (
        "TUI 最终结果",
        "docs/studio-extra-request-body.md",
        "TUI 最终结果",
    ),
    (
        "Studio 额外请求体",
        "docs/studio-extra-request-body.md",
        "Studio 额外请求体",
    ),
    (
        "result_too_large",
        "docs/kcoder-computer-use-result-limit-fix-2026-09-29.md",
        "修改",
    ),
    (
        "Type clear=true",
        "docs/kcoder-computer-use-result-limit-fix-2026-09-29.md",
        "修改",
    ),
    (
        "原生回复超过 2 MiB",
        "docs/kcoder-computer-use-result-limit-fix-2026-09-29.md",
        "实机证据与边界",
    ),
    ("量子退火知识库配置", "", ""),
    ("火星轨道租约续订", "", ""),
    ("海豚语音翻译插件", "", ""),
    ("鸵鸟数据库迁移", "", ""),
    ("KCoder 怎么报销差旅费", "", ""),
    ("知识库黄金期货交易", "", ""),
    ("workflowGraphV999", "", ""),
    ("学校学籍账户如何注销", "", ""),
];
fn main() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut catalog = KnowledgeCatalog::open(&directory.path().join("relevance.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("real-repository-relevance", "local")?;
    let library = catalog.create(&scope, "create", "Repository documentation", "")?;
    let mut documents = Vec::new();
    for file in FILES {
        let output = Command::new("git")
            .args(["show", &format!("{REVISION}:{file}")])
            .output()?;
        ensure!(output.status.success(), "fixed corpus unavailable: {file}");
        let text = String::from_utf8(output.stdout)?;
        let lines: Vec<_> = text.lines().collect();
        let mut starts = Vec::new();
        let mut fenced = false;
        for (line, value) in lines.iter().enumerate() {
            if value.trim_start().starts_with("```") {
                fenced = !fenced;
            }
            if !fenced && value.starts_with('#') && value.trim_start_matches('#').starts_with(' ') {
                starts.push(line);
            }
        }
        for (number, &start) in starts.iter().enumerate() {
            let end = starts.get(number + 1).copied().unwrap_or(lines.len());
            let title = lines[start].trim_start_matches('#').trim();
            let body = lines[start..end].join("\n");
            let id = format!("doc-{}", documents.len());
            catalog.index_document(
                &scope,
                &library.id,
                &IndexedDocument {
                    id: id.clone(),
                    revision_id: REVISION.into(),
                    title: title.into(),
                    body,
                },
            )?;
            documents
                .push(json!({"id":id,"file":file,"heading":title,"line":start+1,"endLine":end}));
        }
    }
    // Both revisions: identical corpus/labels, one warm-up pass, one measured pass.
    for (query, _, _) in QUERIES {
        catalog.search(&scope, &library.id, query, 5)?;
    }
    let mut output = Vec::new();
    let mut recalls = 0.;
    let mut precision = 0.;
    let mut reciprocal_ranks = 0.;
    let mut returned_precision = 0.;
    let mut false_positives = 0;
    let mut answerable = 0;
    let mut durations = Vec::new();
    for (query, file, heading) in QUERIES {
        let expected: Vec<_> = documents
            .iter()
            .filter(|d| d["file"] == *file && d["heading"] == *heading)
            .map(|d| d["id"].as_str().unwrap().to_string())
            .collect();
        ensure!(
            file.is_empty() || !expected.is_empty(),
            "missing gold section for {query}"
        );
        let start = Instant::now();
        let hits = catalog.search(&scope, &library.id, query, 5)?;
        let milliseconds = start.elapsed().as_secs_f64() * 1000.;
        durations.push(milliseconds);
        let relevant = hits
            .iter()
            .filter(|hit| expected.contains(&hit.document_id))
            .count();
        if file.is_empty() {
            false_positives += usize::from(!hits.is_empty());
        } else {
            answerable += 1;
            recalls += relevant as f64 / expected.len() as f64;
            precision += relevant as f64 / 5.;
            reciprocal_ranks += hits
                .iter()
                .position(|hit| expected.contains(&hit.document_id))
                .map_or(0., |rank| 1. / (rank + 1) as f64);
            returned_precision += if hits.is_empty() {
                0.
            } else {
                relevant as f64 / hits.len() as f64
            };
        }
        output.push(
            json!({"query":query,"expectedIds":expected,"hits":hits,"milliseconds":milliseconds}),
        );
    }
    durations.sort_by(f64::total_cmp);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "corpusRevision":REVISION,"extraction":"original Markdown sections at headings outside fenced code, heading included, no paraphrase or generated text",
            "documents":documents,"queries":output,"labelPolicy":"hand-labelled exact section relevance; binary judgement, not blinded external human review",
            "metrics":{"recallAt5":recalls/answerable as f64,"precisionAt5":precision/answerable as f64,"mrrAt5":reciprocal_ranks/answerable as f64,"meanReturnedPrecisionAt5":returned_precision/answerable as f64,"answerable":answerable,"noAnswer":QUERIES.len()-answerable,"noAnswerFalsePositives":false_positives},
            "timing":{"cache":"warm single-process after one pass; OS cache uncontrolled","profile":"debug","samples":QUERIES.len(),"p50Ms":durations[19],"p95Ms":durations[37],"maxMs":durations[39]},
            "environment":{"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"storage":"isolated tempfile, automatically removed"}
        }))?
    );
    Ok(())
}
