//! Opt-in lexical retrieval benchmark, never part of the default test suite.
use anyhow::Result;
use kcoder_knowledge::{IndexedDocument, KnowledgeCatalog, KnowledgeScope};
use std::time::Instant;
fn main() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut catalog = KnowledgeCatalog::open(&directory.path().join("benchmark.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("synthetic-benchmark", "local")?;
    let library = catalog.create(&scope, "create", "合成测试", "")?;
    let topics = [
        "数据库事务",
        "中文知识整理",
        "协议兼容",
        "性能优化",
        "故障排查",
        "版本迁移",
        "桌面交互",
        "图像处理",
        "并发安全",
        "索引重建",
    ];
    let mut inserted = 0;
    for size in [1_000, 10_000] {
        let setup = Instant::now();
        while inserted < size {
            let topic = topics[inserted % topics.len()];
            catalog.index_document(&scope, &library.id, &IndexedDocument {
                id: format!("page-{inserted:05}"), revision_id: "r1".into(),
                title: format!("{topic} 技术笔记 {inserted}"),
                body: format!("这是一篇用于确定性检索测试的合成知识页面。主题是{topic}。资料保留来源，明确适用版本，不依赖嵌入或者重排模型。编号{inserted}，项目project_{}，SQLite FTS5 支持中文关键词和英文标识符。", inserted % 100),
            })?;
            inserted += 1;
        }
        let queries = [
            "数据库事务",
            "中文知识",
            "协议兼容",
            "性能优化",
            "故障排查",
            "版本迁移",
            "桌面交互",
            "图像处理",
            "并发安全",
            "索引重建",
            "SQLite",
            "FTS5",
            "project_42",
            "来源",
            "版本",
            "完全不存在的词xxyy",
        ];
        for query in queries {
            let _ = catalog.search(&scope, &library.id, query, 10)?;
        }
        let mut durations = Vec::new();
        let mut hits = 0;
        for index in 0..320 {
            let start = Instant::now();
            hits += catalog
                .search(&scope, &library.id, queries[index % queries.len()], 10)?
                .len();
            durations.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        durations.sort_by(f64::total_cmp);
        println!(
            "{}",
            serde_json::json!({"indexed_pages":size,"samples":durations.len(),"queries":queries.len(),"top_k":10,"p50_ms":durations[159],"p95_ms":durations[303],"p99_ms":durations[316],"max_ms":durations[319],"total_hits":hits,"setup_and_benchmark_seconds":setup.elapsed().as_secs_f64(),"profile":"debug","cache":"warm, one process"})
        );
    }
    Ok(())
}
