//! The first project declaration keeps only explicitly selected inherited names.
use super::*;
use kcoder_app_protocol::{MigrationBatchChoice, MigrationProjectMcpInheritanceSelection};
use kcoder_migration::mcp::McpTarget;
use serde_json::json;
use std::collections::BTreeSet;

pub(super) fn choose<'a>(
    guide: &Guide<'_>,
    job: &MigrationJob,
    choices: impl Iterator<Item = &'a MigrationBatchChoice>,
) -> Result<Option<MigrationProjectMcpInheritanceSelection>> {
    if !choices
        .into_iter()
        .any(|choice| matches!(choice, MigrationBatchChoice::Mcp { .. }))
    {
        return Ok(None);
    }
    let Some(project) = job.project_target() else {
        return Ok(None);
    };
    let context = guide.fresh()?;
    super::super::settings_targets::verify(&context, job)?;
    let catalog = match McpTarget::preview_project_mcp_catalog(&context.profile, project) {
        Ok(catalog) => catalog,
        Err(error) if error.to_string() == "migration_project_mcp_catalog_already_declared" => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    if catalog.names.is_empty() {
        return Ok(None);
    }
    let mut selected = BTreeSet::new();
    let mut page = 0usize;
    loop {
        let rows = catalog.names.iter().skip(page * 10).take(10).enumerate()
            .map(|(index, name)| json!({"number":index+1,"name":name,"selected":selected.contains(name)})).collect::<Vec<_>>();
        let command = guide.io.ask("project_mcp_inheritance", "首次声明项目 MCP 配置：toggle N 选择保留的继承服务器；next/prev 每页10项；confirm 明确确认（空名单表示全部不保留）；quit 取消。只保存名称，继承凭据仍留在原配置。", json!({"page":page,"total":catalog.names.len(),"selected":selected.len(),"items":rows}), None)?;
        let mut words = command.split_whitespace();
        match words.next().unwrap_or("") {
            "confirm" => {
                return Ok(Some(MigrationProjectMcpInheritanceSelection {
                    names: selected.into_iter().collect(),
                    expected_revision: catalog.revision,
                }));
            }
            "quit" => anyhow::bail!("migration_guide_cancelled_read_original_job"),
            "next" if (page + 1) * 10 < catalog.names.len() => page += 1,
            "prev" if page > 0 => page -= 1,
            "toggle" => {
                let name = words
                    .next()
                    .and_then(|number| number.parse::<usize>().ok())
                    .filter(|number| (1..=10).contains(number))
                    .and_then(|number| catalog.names.get(page * 10 + number - 1));
                if let Some(name) = name {
                    if !selected.remove(name) {
                        selected.insert(name.clone());
                    }
                } else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "请选择当前页内的服务器编号。",
                    )?;
                }
            }
            _ => guide.io.notice(
                "migration_guide_invalid_selection",
                "未识别的选择；目标没有变更。",
            )?,
        }
    }
}
