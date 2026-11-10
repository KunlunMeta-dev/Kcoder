//! Candidate selection creates owned package records; publication belongs to the fixed batch.
use super::super::plugin;
use super::*;
use crate::cli_args::MigrationPluginBinding;
use kcoder_migration::{
    batch::BatchSource,
    discovery::SourceRegistry,
    plugin_migration::{PluginMigrationStage, PluginMigrationStore},
};
use kcoder_plugins::PluginCancellationToken;
use kcoder_types::migration::MigrationSourceKind;
use serde_json::json;
use std::collections::BTreeMap;
#[path = "plugin_sources/records.rs"]
mod records;
pub(super) use records::{RecordSelection, records};

fn token(guide: &Guide<'_>) -> PluginCancellationToken {
    let stopped = guide.cancelled.clone();
    PluginCancellationToken::default().with_probe(move || stopped.load(Ordering::Acquire))
}
fn show(
    guide: &Guide<'_>,
    value: &kcoder_migration::plugin_migration::PluginMigrationView,
) -> Result<()> {
    let store = plugin::existing(&guide.fresh()?)?;
    guide
        .io
        .state("plugin_job", &plugin::observed(&store, value)?)
}
fn captured(
    guide: &Guide<'_>,
    registry: &SourceRegistry,
    id: &str,
    saved: &mut BTreeMap<String, MigrationPluginBinding>,
    cancel: &PluginCancellationToken,
) -> Result<Option<BatchSource>> {
    let context = guide.fresh()?;
    plugin::private_profile(&context)?;
    let selected = if let Some(previous) = saved.get(id) {
        previous.clone()
    } else {
        let candidate = registry.selected_plugin(id)?;
        guide
            .io
            .state("plugin_candidate", &plugin::candidate(&candidate))?;
        ensure!(
            candidate.scope == "user" && candidate.pending.is_empty(),
            "plugin_migration_pending_resolution_required"
        );
        let request = guide.io.text("plugin_request_id", "保存本次 operationId。中断或丢回执后用 plugin read/records 核对同一记录，不生成替代身份。", Some(&uuid::Uuid::new_v4().to_string()))?;
        ensure!(
            uuid::Uuid::parse_str(&request).is_ok_and(|id| id.to_string() == request),
            "plugin_migration_invalid_operation"
        );
        if !guide.io.yes("plugin_capture_consent", "是否明确复制这个已选择的本地插件包？不运行命令、Hook、MCP。Ready 只表示静态捕获完成；首次 IMPORT 仍检查原来源未变，请保留原插件目录到提交完成。目标默认停用。")? { return Ok(None); }
        guide.fresh()?;
        guide.io.state(
            "operation",
            &json!({"operationId":request,"step":"plugin_prepare_intent","publication":false}),
        )?;
        let store = PluginMigrationStore::open(&context.profile)?;
        guide.fresh()?;
        let prepared = store.prepare(&request, &candidate)?;
        show(guide, &prepared)?;
        let result = store.capture(&request, prepared.sequence, cancel);
        let ready = match result {
            Ok(value) => value,
            Err(error) => {
                if let Ok(view) = store.read(&request, &PluginCancellationToken::default()) {
                    show(guide, &view)?;
                }
                return Err(error);
            }
        };
        show(guide, &ready)?;
        ensure!(
            ready.stage == PluginMigrationStage::Ready,
            "plugin_migration_plan_not_ready"
        );
        let selected = MigrationPluginBinding {
            operation_id: request,
            sequence: ready.sequence,
        };
        saved.insert(id.into(), selected.clone());
        selected
    };
    let store = plugin::existing(&guide.fresh()?)?;
    show(guide, &store.read(&selected.operation_id, cancel)?)?;
    if !guide.io.yes("plugin_use_consent", "审查 capabilities、pending 和 readiness 后，是否将这份 Ready 静态副本加入统一清单？首次 IMPORT 仍检查原来源。Readiness 待配置不表示复制失败或运行已就绪；迁入默认停用。")? {return Ok(None);}
    plugin::binding(&guide.fresh()?, &selected).map(Some)
}
pub(super) fn choose(
    guide: &Guide<'_>,
    registry: &mut SourceRegistry,
    kind: MigrationSourceKind,
    other_sources: usize,
) -> Result<Vec<BatchSource>> {
    let cancel = token(guide);
    let mut page = registry.discover_plugins(&[kind], None, &cancel)?;
    let mut cursors = vec![None];
    let mut index = 0usize;
    let mut selected = BTreeMap::<String, BatchSource>::new();
    let mut saved = BTreeMap::<String, MigrationPluginBinding>::new();
    let mut unresolved = false;
    loop {
        guide.fresh()?;
        let rows = page.candidates.iter().enumerate().map(|(at,item)|json!({"number":at+1,"selected":selected.contains_key(&item.candidate_id),"candidate":plugin::candidate(&item.candidate)})).collect::<Vec<_>>();
        let answer = guide.io.ask("plugin_selection", "每页最多10个已安装插件。select N 审查并明确复制/取消选择，details N 阅读，next/prev 翻页，done 固定所选，skip 不选。复制中可 /migrate stop；记录会保留。",json!({"page":index,"selected":selected.len(),"hasNextPage":page.next_cursor.is_some(),"items":rows,"problems":page.problems.iter().map(|p|json!({"code":p.code,"scope":p.scope})).collect::<Vec<_>>()}),None)?;
        let mut words = answer.split_whitespace();
        match words.next().unwrap_or("") {
            "skip" => return Ok(Vec::new()),
            "done" => {
                if (unresolved || !page.problems.is_empty()) && !guide.io.yes("plugin_partial_consent", "存在未纳入的兼容/发现问题或未就绪记录。是否只将明确选中的 Ready 副本继续到本批？其他记录不计作迁入成功，可在 plugin-records 回读。")? {continue;}
                return Ok(selected.into_values().collect());
            }
            "next" if page.next_cursor.is_some() => {
                cursors.truncate(index + 1);
                cursors.push(page.next_cursor.clone());
                index += 1;
                page = registry.discover_plugins(&[kind], cursors[index].as_deref(), &cancel)?;
            }
            "prev" if index > 0 => {
                index -= 1;
                page = registry.discover_plugins(&[kind], cursors[index].as_deref(), &cancel)?;
            }
            action @ ("select" | "details") => {
                let item = words
                    .next()
                    .and_then(|v| v.parse::<usize>().ok())
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|n| page.candidates.get(n));
                let Some(item) = item else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "请选择当前页的插件编号。",
                    )?;
                    continue;
                };
                if action == "details" {
                    guide
                        .io
                        .state("plugin_candidate", &plugin::candidate(&item.candidate))?;
                    continue;
                }
                if selected.remove(&item.candidate_id).is_some() {
                    continue;
                }
                if other_sources.saturating_add(selected.len()) >= 64 {
                    guide.io.notice(
                        "migration_batch_budget_exceeded",
                        "全部来源合计最多64项，未复制该包。",
                    )?;
                    continue;
                }
                match captured(guide, registry, &item.candidate_id, &mut saved, &cancel) {
                    Ok(Some(source)) => {
                        selected.insert(item.candidate_id.clone(), source);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        unresolved = true;
                        guide.io.notice(&safe_error(&error),"该插件未被当作成功纳入；已创建的原 operationId 记录可回读与明确恢复，不更换身份重试。")?;
                        guide.io.active()?;
                    }
                }
            }
            _ => guide.io.notice(
                "migration_guide_invalid_selection",
                "请选择当前页内插件或有效操作；未发布插件。",
            )?,
        }
    }
}
