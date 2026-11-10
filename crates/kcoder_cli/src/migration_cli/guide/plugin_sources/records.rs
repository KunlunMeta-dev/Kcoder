//! Reopening a copy uses its original operation; a batch claim routes mutation to its parent.
use super::*;
pub(in crate::migration_cli::guide) enum RecordSelection {
    Ready(Box<BatchSource>),
    Batch(String),
}
pub(in crate::migration_cli::guide) fn records(
    guide: &Guide<'_>,
) -> Result<Option<RecordSelection>> {
    let context = guide.fresh()?;
    let Some(store) = PluginMigrationStore::open_existing(&context.profile)? else {
        guide
            .io
            .notice("plugin_migration_no_records", "当前目标没有插件复制记录。")?;
        return Ok(None);
    };
    let cancel = token(guide);
    let mut cursor = None;
    let mut cursors = vec![None];
    let mut index = 0usize;
    loop {
        guide.fresh()?;
        let (items, next) = store.list(cursor.as_deref())?;
        let rows = items
            .iter()
            .enumerate()
            .map(|(at, item)| Ok(json!({"number":at+1,"job":plugin::observed(&store,item)?})))
            .collect::<Result<Vec<_>>>()?;
        let answer = guide.io.ask(
            "plugin_records",
            "每页最多10条原生插件记录。编号打开，next/prev 翻页，back 返回；读取不复制或发布。",
            json!({"page":index,"items":rows,"hasNextPage":next.is_some()}),
            None,
        )?;
        match answer.as_str() {
            "back" => return Ok(None),
            "next" if next.is_some() => {
                cursors.truncate(index + 1);
                cursors.push(next.clone());
                index += 1;
                cursor = next;
            }
            "prev" if index > 0 => {
                index -= 1;
                cursor = cursors[index].clone();
            }
            _ => {
                if let Some(item) = answer
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|n| items.get(n))
                {
                    if let Some(result) = record(guide, &store, &item.operation_id, &cancel)? {
                        return Ok(Some(result));
                    }
                } else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "请选择当前页编号或有效翻页。",
                    )?;
                }
            }
        }
    }
}
fn record(
    guide: &Guide<'_>,
    store: &PluginMigrationStore,
    id: &str,
    cancel: &PluginCancellationToken,
) -> Result<Option<RecordSelection>> {
    loop {
        guide.fresh()?;
        let current = store.read(id, cancel)?;
        show(guide, &current)?;
        let mut actions = vec![
            json!({"value":"read","label":"回读原记录"}),
            json!({"value":"back","label":"返回记录列表"}),
        ];
        if current.batch_job_id.is_some() {
            actions.push(json!({"value":"batch","label":"打开已绑定的统一批次"}));
        } else {
            if current.stage == PluginMigrationStage::Ready {
                actions.push(json!({"value":"use","label":"将该原副本纳入新的统一清单"}));
            }
            if !current.imported {
                actions.extend([
                    json!({"value":"capture","label":"明确继续复制"}),
                    json!({"value":"resume","label":"确认原取消水位后恢复控制"}),
                    json!({"value":"cancel","label":"取消此原操作"}),
                ]);
            } else if current.stage != PluginMigrationStage::Undone {
                actions.push(json!({"value":"undo","label":"明确撤销这个独立操作的原输出"}));
            }
        }
        let answer=guide.io.ask("plugin_record_menu","核对当前 operationId、sequence、状态和就绪条件。批次已认领的记录只允许打开原批次，不能以独立操作越过归属。",json!(actions),None)?;
        let result = match answer.as_str() {
            "back" => return Ok(None),
            "read" => continue,
            "batch" => {
                return Ok(Some(RecordSelection::Batch(
                    current
                        .batch_job_id
                        .ok_or_else(|| anyhow::anyhow!("plugin_migration_no_parent"))?,
                )));
            }
            "use" => {
                return plugin::binding(
                    &guide.fresh()?,
                    &MigrationPluginBinding {
                        operation_id: id.into(),
                        sequence: current.sequence,
                    },
                )
                .map(|source| Some(RecordSelection::Ready(Box::new(source))));
            }
            "capture" => {
                if !guide.io.yes("plugin_capture_consent","是否明确继续同 operationId 的已固定复制？不会更换来源、版本或参数，也不发布安装。")? {continue;}
                guide.fresh()?;
                store.capture(id, current.sequence, cancel)
            }
            "resume" => {
                guide.fresh()?;
                store.resume(id, current.sequence)
            }
            "cancel" => {
                guide.fresh()?;
                store.cancel(id, current.sequence)
            }
            "undo" => {
                if guide.io.text(
                    "plugin_undo_confirm",
                    "输入 UNDO 才撤销该独立操作拥有且未编辑的包；批次记录必须走原批次。",
                    None,
                )? != "UNDO"
                {
                    continue;
                }
                guide.fresh()?;
                store.undo(id, current.sequence, cancel)
            }
            _ => {
                guide.io.notice(
                    "migration_guide_invalid_selection",
                    "请选择当前记录允许的操作。",
                )?;
                continue;
            }
        };
        match result {
            Ok(view) => show(guide, &view)?,
            Err(error) => {
                guide.io.notice(
                    &safe_error(&error),
                    "未将操作当作成功，继续回读同一 operationId。",
                )?;
                guide.io.active()?;
            }
        }
    }
}
