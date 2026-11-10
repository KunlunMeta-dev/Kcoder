//! Explicit note selection never treats opaque source labels as destination authority.
use super::*;
use kcoder_migration::{batch::BatchSource, discovery::SourceRegistry};
use kcoder_types::{imported_memory::ImportedMemoryMapping, migration::MigrationSourceKind};
use serde_json::json;
use std::collections::BTreeSet;
#[path = "memory/records.rs"]
mod records;
pub(super) use records::run as records;

pub(super) fn mapping(guide: &Guide<'_>) -> Result<ImportedMemoryMapping> {
    match guide.io.ask("memory_mapping", "来源记忆只是未验证笔记，迁入保持停用。明确映射到用户范围或当前受信任工作目录；不根据来源标签推断路径。", json!([
        {"value":"global","label":"用户范围（仍需另行确认启用）"},
        {"value":"current_workspace","label":"当前受信任工作目录"}
    ]), None)?.as_str() {
        "global" => Ok(ImportedMemoryMapping::Global),
        "current_workspace" => {
            let context = guide.fresh()?;
            kcoder_config::imported_context::ImportedContextStore::open(&context.profile)?
                .capture_memory_workspace(&kcoder_config::imported_context::ImportedContextScope::Project { root:context.cwd })?;
            Ok(ImportedMemoryMapping::CurrentWorkspace)
        }
        _ => anyhow::bail!("migration_memory_scope_required"),
    }
}

pub(super) fn choose(
    guide: &Guide<'_>,
    registry: &mut SourceRegistry,
    source: MigrationSourceKind,
    other_sources: usize,
) -> Result<Vec<BatchSource>> {
    let mut check = |_| !guide.cancelled.load(Ordering::Acquire);
    let mut page = registry.discover_memories(source, &mut check)?;
    let catalog = page.catalog_id.clone();
    let mut cursors = vec![None];
    let mut page_index = 0usize;
    let mut selected = BTreeSet::<String>::new();
    loop {
        guide.fresh()?;
        let rows = page.items.iter().enumerate().map(|(at,item)| json!({
            "number":at+1,"selected":selected.contains(&item.source_id),"source":item.source,
            "layout":item.layout,"sourceGroup":item.source_group,"files":item.files,
            "bytes":item.bytes,"blockedItems":item.blocked_items
        })).collect::<Vec<_>>();
        let answer = guide.io.ask("memory_selection", "每页10个静态来源；toggle N 选择/取消，next/prev 翻页，done 固定选择，skip 跳过。原目录标签不是目标路径；笔记不代表已验证事实或系统指令。", json!({"page":page_index,"items":rows,"selected":selected.len(),"hasNextPage":page.next_cursor.is_some(),"problems":page.problems,"unobserved":page.unobserved}), None)?;
        let mut words = answer.split_whitespace();
        match words.next().unwrap_or("") {
            "skip" => return Ok(Vec::new()),
            "done" => {
                return selected
                    .iter()
                    .map(|id| registry.selected_asset(id).map(BatchSource::Assets))
                    .collect();
            }
            "next" if page.next_cursor.is_some() => {
                cursors.truncate(page_index + 1);
                cursors.push(page.next_cursor.clone());
                page_index += 1;
                page =
                    registry.memory_page(&catalog, cursors[page_index].as_deref(), &mut check)?;
            }
            "prev" if page_index > 0 => {
                page_index -= 1;
                page =
                    registry.memory_page(&catalog, cursors[page_index].as_deref(), &mut check)?;
            }
            "toggle" => {
                let item = words
                    .next()
                    .and_then(|v| v.parse::<usize>().ok())
                    .and_then(|v| v.checked_sub(1))
                    .and_then(|at| page.items.get(at));
                if let Some(item) = item {
                    if selected.remove(&item.source_id) {
                        continue;
                    }
                    if item.blocked_items > 0 {
                        guide.io.notice(
                            "migration_memory_source_blocked",
                            "此来源有阻断项，未选择；不会执行或绕过来源校验。",
                        )?;
                    } else if other_sources + selected.len() < 64 {
                        selected.insert(item.source_id.clone());
                    } else {
                        guide.io.notice(
                            "migration_batch_budget_exceeded",
                            "本批来源合计最多64项，请明确减少选择。",
                        )?;
                    }
                } else {
                    guide
                        .io
                        .notice("migration_guide_invalid_selection", "请选择本页编号。")?;
                }
            }
            _ => guide.io.notice(
                "migration_guide_invalid_selection",
                "请选择有效操作；未创建或启用记忆。",
            )?,
        }
    }
}
