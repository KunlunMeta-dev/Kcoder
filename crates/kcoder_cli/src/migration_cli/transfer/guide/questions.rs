//! Human choices are numbered public summaries; opaque grants are never inferred from categories.
use super::*;
use kcoder_types::migration::MigrationSourceKind;
use serde_json::json;
#[path = "questions/memory.rs"]
pub(super) mod memory;

#[derive(Clone)]
pub(super) struct Target {
    pub id: String,
    pub label: String,
    pub scope: String,
    pub principal: Option<String>,
}
pub(super) async fn targets(client: &http::Client) -> Result<Vec<Target>> {
    let value = client.servers().await?;
    let rows = value["servers"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("migration_transfer_scope_unavailable"))?;
    ensure!(
        rows.len() <= 1024,
        "migration_transfer_response_budget_exceeded"
    );
    rows.iter()
        .map(|row| {
            let string = |key: &str, max: usize| {
                row[key]
                    .as_str()
                    .filter(|value| {
                        !value.is_empty()
                            && value.len() <= max
                            && !value.chars().any(char::is_control)
                    })
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow::anyhow!("migration_transfer_scope_unavailable"))
            };
            let principal = if row.get("accountIdentity").is_some() {
                Some(
                    row["accountIdentity"]["principalId"]
                        .as_str()
                        .filter(|v| {
                            !v.is_empty() && v.len() <= 256 && !v.chars().any(char::is_control)
                        })
                        .ok_or_else(|| anyhow::anyhow!("migration_transfer_scope_unavailable"))?
                        .to_owned(),
                )
            } else {
                None
            };
            Ok(Target {
                id: string("id", 64)?,
                label: string("label", 320)?,
                scope: string("observationTargetIdentity", 256)?,
                principal,
            })
        })
        .collect()
}
pub(super) fn target(
    io: &GuideIo,
    rows: &[Target],
    selected: Option<&str>,
    source: bool,
) -> Result<Target> {
    if let Some(id) = selected {
        return rows
            .iter()
            .find(|row| row.id == id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("migration_transfer_target_unavailable"));
    }
    ensure!(!rows.is_empty(), "migration_transfer_target_unavailable");
    let mut page = 0;
    loop {
        let visible = rows
            .iter()
            .skip(page * 10)
            .take(10)
            .enumerate()
            .map(|(i, row)| json!({"number":i+1,"title":row.label,"targetId":row.id}))
            .collect::<Vec<_>>();
        let answer = io.ask(
            if source {
                "transfer_source_target"
            } else {
                "transfer_destination"
            },
            if source {
                "明确选择来源目标：输入当前页编号；next/prev 翻页；quit 退出。"
            } else {
                "明确选择接收目标：输入当前页编号；next/prev 翻页；quit 退出。"
            },
            json!({"page":page,"pages":rows.len().div_ceil(10),"items":visible}),
            None,
        )?;
        match answer.as_str() {
            "next" if (page + 1) * 10 < rows.len() => page += 1,
            "prev" if page > 0 => page -= 1,
            "quit" => anyhow::bail!("migration_transfer_guide_stopped"),
            _ => {
                if let Some(row) = answer
                    .parse::<usize>()
                    .ok()
                    .filter(|n| (1..=10).contains(n))
                    .and_then(|n| rows.get(page * 10 + n - 1))
                {
                    return Ok(row.clone());
                }
                io.notice(
                    "migration_transfer_invalid_selection",
                    "请选择当前页的目标编号。",
                )?;
            }
        }
    }
}

#[derive(Clone)]
pub(super) struct SourceRow {
    pub title: String,
    pub scope: String,
    pub selection: MigrationSourceSelectionV1,
}
async fn query<P: serde::Serialize, R: serde::de::DeserializeOwned>(
    client: &http::Client,
    session: &MigrationSourceSessionParams,
    kind: &str,
    params: &P,
) -> Result<R> {
    let wire: MigrationSourceSessionQueryParams =
        serde_json::from_value(json!({"session":session,"query":{"kind":kind,"params":params}}))
            .map_err(|_| anyhow::anyhow!("migration_transfer_invalid_query"))?;
    client.post("source-session", "query", &wire).await
}
pub(super) async fn choose_history(
    io: &GuideIo,
    client: &http::Client,
    session: &MigrationSourceSessionParams,
    kind: MigrationSourceKind,
    other: usize,
) -> Result<Vec<MigrationSourceSelectionV1>> {
    let first: MigrationHistorySourcesResult = query(
        client,
        session,
        "history",
        &MigrationHistoryDiscoverParams { source: kind },
    )
    .await?;
    let mut catalog = first.catalog_id.clone();
    let mut families = false;
    let mut page = first;
    let mut cursors = vec![None];
    let mut index = 0usize;
    let mut selected = std::collections::BTreeSet::<String>::new();
    loop {
        ensure!(
            page.catalog_id == catalog && page.items.len() <= 10,
            "migration_transfer_invalid_response"
        );
        let rows=page.items.iter().enumerate().map(|(i,row)|json!({"number":i+1,"selected":selected.contains(&row.source_handle),"title":row.title,"sourceSessionId":row.source_session_id,"bytes":row.bytes,"importIssues":row.import_issues,"parentSessionId":row.parent_session_id,"agentId":row.agent_id,"archived":row.archived,"compressed":row.compressed})).collect::<Vec<_>>();
        let answer=io.ask("history_selection","每页最多10项，toggle N 明确选择/取消；Codex可families查看完整物理家族目录，basic回基础视图；next/prev翻页，done固定，skip跳过。不猜未知父关系、不运行旧工具或模型。",json!({"page":index,"familyIndex":families,"selected":selected.len(),"totalItems":page.total_items,"discoveryComplete":page.discovery_complete,"hasNextPage":page.next_cursor.is_some(),"problems":page.problems,"items":rows}),None)?;
        let mut words = answer.split_whitespace();
        match words.next().unwrap_or("") {
            "skip" => return Ok(Vec::new()),
            view @ ("families" | "basic") if kind == MigrationSourceKind::Codex => {
                if !selected.is_empty() && !io.yes("transfer_history_view_confirm", "切换历史目录会清除本轮尚未固定的选择，确认后重新逐项选择；原requestId不变。")? {continue;}
                let result: MigrationHistorySourcesResult = query(
                    client,
                    session,
                    if view == "families" {
                        "history_families"
                    } else {
                        "history"
                    },
                    &MigrationHistoryDiscoverParams { source: kind },
                )
                .await?;
                ensure!(
                    result.items.len() <= 10,
                    "migration_transfer_invalid_response"
                );
                catalog = result.catalog_id.clone();
                page = result;
                families = view == "families";
                index = 0;
                cursors = vec![None];
                selected.clear();
            }
            "done" => {
                if !page.discovery_complete
                    && !io.yes(
                        "history_partial_consent",
                        "发现不完整。是否只接纳已明确选择的已发现文件？未发现项不会被当作已迁入。",
                    )?
                {
                    continue;
                }
                return Ok(selected
                    .into_iter()
                    .map(|source_handle| MigrationSourceSelectionV1::History {
                        catalog_id: catalog.clone(),
                        source_handle,
                    })
                    .collect());
            }
            "next" if page.next_cursor.is_some() => {
                cursors.truncate(index + 1);
                cursors.push(page.next_cursor.clone());
                index += 1;
                ensure!(
                    cursors
                        .iter()
                        .filter_map(|c| c.as_ref())
                        .map(String::len)
                        .sum::<usize>()
                        <= 2 * 1024 * 1024,
                    "migration_transfer_cursor_budget_exceeded"
                );
                page = query(
                    client,
                    session,
                    "history_page",
                    &MigrationHistorySourcesParams {
                        catalog_id: catalog.clone(),
                        cursor: cursors[index].clone(),
                    },
                )
                .await?;
            }
            "prev" if index > 0 => {
                index -= 1;
                page = query(
                    client,
                    session,
                    "history_page",
                    &MigrationHistorySourcesParams {
                        catalog_id: catalog.clone(),
                        cursor: cursors[index].clone(),
                    },
                )
                .await?;
            }
            "toggle" => {
                if let Some(row) = words
                    .next()
                    .and_then(|n| n.parse::<usize>().ok())
                    .filter(|n| (1..=10).contains(n))
                    .and_then(|n| page.items.get(n - 1))
                {
                    if !selected.remove(&row.source_handle) {
                        if !row.import_issues.is_empty() {
                            io.notice(
                                "migration_history_source_blocked",
                                "该文件有已知阻断项，未选择；不会绕过来源或大小校验。",
                            )?;
                        } else if other + selected.len() < 64 {
                            selected.insert(row.source_handle.clone());
                        } else {
                            io.notice(
                                "migration_batch_budget_exceeded",
                                "配置与历史来源合计最多64项，请明确减少选择。",
                            )?;
                        }
                    }
                } else {
                    io.notice(
                        "migration_transfer_invalid_selection",
                        "请选择当前页内的历史编号。",
                    )?;
                }
            }
            _ => io.notice(
                "migration_transfer_invalid_selection",
                "请选择有效操作；未启动历史作业。",
            )?,
        }
    }
}
