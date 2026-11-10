//! Notes use the same owned source child and opaque grants as other static assets.
use super::*;

pub(in crate::migration_cli::transfer::guide) async fn choose(
    io: &GuideIo,
    client: &http::Client,
    session: &MigrationSourceSessionParams,
    source: MigrationSourceKind,
    other: usize,
) -> Result<Vec<MigrationSourceSelectionV1>> {
    let mut page: MigrationMemorySourcesResult = query(
        client,
        session,
        "memory",
        &MigrationMemoryDiscoverParams { source },
    )
    .await?;
    let catalog = page.catalog_id.clone();
    let mut cursors = vec![None];
    let mut at = 0;
    let mut selected = std::collections::BTreeSet::<String>::new();
    loop {
        ensure!(
            page.catalog_id == catalog && page.items.len() <= 10,
            "source_transfer_invalid_response"
        );
        let rows=page.items.iter().enumerate().map(|(i,row)|json!({"number":i+1,"sourceGroup":row.source_group,"layout":row.layout,"files":row.files,"bytes":row.bytes,"blockedItems":row.blocked_items,"selected":selected.contains(&row.source_id)})).collect::<Vec<_>>();
        let answer=io.ask("transfer_memory_sources","未验证的模型笔记：每页10个来源。toggle N 选择/取消；next/prev 翻页；done 固定；skip 跳过。接收后仍须明确目标映射，默认停用。",json!({"page":at,"items":rows,"selected":selected.len(),"hasNextPage":page.next_cursor.is_some(),"problems":page.problems,"unobserved":page.unobserved}),None)?;
        let mut words = answer.split_whitespace();
        match words.next().unwrap_or("") {
            "skip" => return Ok(Vec::new()),
            "done" => {
                return Ok(selected
                    .into_iter()
                    .map(|source_id| MigrationSourceSelectionV1::Assets { source_id })
                    .collect());
            }
            "next" if page.next_cursor.is_some() => {
                cursors.truncate(at + 1);
                cursors.push(page.next_cursor.clone());
                at += 1;
                page = query(
                    client,
                    session,
                    "memory_page",
                    &MigrationMemorySourcesParams {
                        catalog_id: catalog.clone(),
                        cursor: cursors[at].clone(),
                    },
                )
                .await?;
            }
            "prev" if at > 0 => {
                at -= 1;
                page = query(
                    client,
                    session,
                    "memory_page",
                    &MigrationMemorySourcesParams {
                        catalog_id: catalog.clone(),
                        cursor: cursors[at].clone(),
                    },
                )
                .await?;
            }
            "toggle" => {
                if let Some(row) = words
                    .next()
                    .and_then(|v| v.parse::<usize>().ok())
                    .filter(|n| (1..=10).contains(n))
                    .and_then(|n| page.items.get(n - 1))
                {
                    if selected.remove(&row.source_id) {
                        continue;
                    }
                    if row.blocked_items > 0 {
                        io.notice(
                            "migration_memory_source_blocked",
                            "该静态来源有阻断项，未选择。",
                        )?;
                    } else if other + selected.len() < 64 {
                        selected.insert(row.source_id.clone());
                    } else {
                        io.notice(
                            "migration_batch_budget_exceeded",
                            "全部明确选择的来源最多64项。",
                        )?;
                    }
                } else {
                    io.notice("migration_transfer_invalid_selection", "请选择当前页编号。")?;
                }
            }
            _ => io.notice(
                "migration_transfer_invalid_selection",
                "请选择有效操作；未传输或启用内容。",
            )?,
        }
    }
}
