//! Reviewed Agent choices remain data until the ordinary Native plan and disabled publication.
use super::guide::GuideIo;
use anyhow::{Result, ensure};
use kcoder_types::migration_agent::{
    ImportedAgentExecution, ImportedAgentModel, MigrationAgentAdaptation,
    MigrationAgentCompatibility,
};
use serde_json::json;
use std::collections::BTreeSet;

pub(super) fn requested(io: &GuideIo) -> Result<bool> {
    io.yes("agent_adapt", "是否检查并明确适配此静态 Agent？默认只保存待处理定义。适配仍保持停用，不执行来源工具、Hook 或模型，不提升审批/目录权限。")
}

pub(super) fn inspect(io: &GuideIo, value: &MigrationAgentCompatibility) -> Result<bool> {
    validate(value)?;
    io.state("agent_compatibility", value)?;
    if !value.can_adapt {
        io.notice("migration_agent_pending_only", "原定义包含未支持语义，不能编译为原生 Agent；仍可另行确认只保存待处理原件，不把它当作可执行迁移。")?;
    }
    Ok(value.can_adapt)
}

fn validate(value: &MigrationAgentCompatibility) -> Result<()> {
    let tools = value.available_tools.iter().collect::<BTreeSet<_>>();
    ensure!(
        value.source_sha256.len() == 64
            && value
                .source_sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            && value.available_tools.len() <= 64
            && tools.len() == value.available_tools.len()
            && tools.iter().all(|name| known_tool(name))
            && (!value.can_adapt || value.problem.is_none()),
        "migration_agent_invalid_preview"
    );
    Ok(())
}

fn known_tool(name: &str) -> bool {
    // A remote target may use another OS; its reported subset is still authoritative.
    matches!(
        name,
        "read"
            | "write"
            | "edit"
            | "glob"
            | "grep"
            | "WebSearch"
            | "WebFetch"
            | "TodoWrite"
            | "bash"
            | "PowerShell"
    )
}

pub(super) fn choose(
    io: &GuideIo,
    value: &MigrationAgentCompatibility,
) -> Result<MigrationAgentAdaptation> {
    validate(value)?;
    ensure!(value.can_adapt, "migration_agent_pending_only");
    io.notice("migration_agent_model_boundary", "来源 model 只是未解析的别名。明确选择继承当前会话模型，或填写目标已配置 Provider/模型的精确 ID；启动时仍由原生重新验证，不选择目录第一项或替代模型。")?;
    let model = loop {
        match io
            .ask(
                "agent_model_kind",
                "选择 inherit 或 target；back 放弃适配。",
                json!([
                    {"value":"inherit","label":"明确继承运行时会话模型"},
                    {"value":"target","label":"明确指定目标 Provider/模型"}
                ]),
                None,
            )?
            .as_str()
        {
            "inherit" => break ImportedAgentModel::Inherit,
            "target" => {
                let model = ImportedAgentModel::Target {
                    provider: io.text(
                        "agent_provider",
                        "目标 Provider 精确 ID（保留大小写，不输入密钥）",
                        None,
                    )?,
                    model: io.text("agent_model", "目标模型精确 ID（不从来源别名推断）", None)?,
                };
                ensure!(
                    ImportedAgentExecution {
                        adapter_revision: "static-agent/v1".into(),
                        source_sha256: value.source_sha256.clone(),
                        model: model.clone()
                    }
                    .is_supported(),
                    "migration_agent_invalid_model_mapping"
                );
                break model;
            }
            "back" => anyhow::bail!("migration_agent_not_selected"),
            _ => io.notice(
                "migration_agent_invalid_selection",
                "请选择 inherit 或 target；未改变原计划。",
            )?,
        }
    };
    let tools = tools(io, &value.available_tools)?;
    ensure!(
        io.text(
            "agent_reviewed_sha256",
            "输入报告中的原件 SHA256，确认已检查此原定义、模型映射及所选工具；迁入仍停用。",
            None
        )? == value.source_sha256,
        "migration_agent_review_changed"
    );
    Ok(MigrationAgentAdaptation {
        reviewed_source_sha256: value.source_sha256.clone(),
        model,
        tools,
    })
}

fn tools(io: &GuideIo, available: &[String]) -> Result<Vec<String>> {
    let mut selected = BTreeSet::<String>::new();
    let mut page = 0;
    loop {
        let rows = available
            .iter()
            .skip(page * 10)
            .take(10)
            .enumerate()
            .map(|(at, name)| json!({"number":at+1,"tool":name,"selected":selected.contains(name)}))
            .collect::<Vec<_>>();
        let answer = io.ask("agent_tools", "仅选择原定义允许且目标报告的 canonical 工具。默认空；toggle N 选择/取消，next/prev 翻页，done 确认（可保持无工具），back 放弃。不会添加 MCP/动态工具或放宽原生审批。", json!({"page":page,"items":rows,"selected":selected.len(),"hasNextPage":(page+1)*10<available.len()}), None)?;
        let mut words = answer.split_whitespace();
        match words.next().unwrap_or("") {
            "done" => return Ok(selected.into_iter().collect()),
            "back" => anyhow::bail!("migration_agent_not_selected"),
            "next" if (page + 1) * 10 < available.len() => page += 1,
            "prev" if page > 0 => page -= 1,
            "toggle" => {
                if let Some(name) = words
                    .next()
                    .and_then(|n| n.parse::<usize>().ok())
                    .filter(|n| (1..=10).contains(n))
                    .and_then(|n| available.get(page * 10 + n - 1))
                {
                    if !selected.remove(name) {
                        selected.insert(name.clone());
                    }
                } else {
                    io.notice(
                        "migration_agent_invalid_selection",
                        "请选择当前页内报告的工具编号；不能输入自造工具名。",
                    )?;
                }
            }
            _ => io.notice(
                "migration_agent_invalid_selection",
                "请选择列表操作；不会默认选中任何工具。",
            )?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_guard_binds_a_complete_hash_unique_known_target_tools_and_compatible_semantics() {
        let mut value = MigrationAgentCompatibility {
            source_sha256: "a".repeat(64),
            can_adapt: true,
            available_tools: vec!["PowerShell".into(), "read".into()],
            source_model_reference: true,
            problem: None,
        };
        validate(&value).unwrap();
        value.available_tools.push("read".into());
        assert!(validate(&value).is_err());
        value.available_tools = vec!["mcp_unreviewed_server".into()];
        assert!(validate(&value).is_err());
        value.available_tools.clear();
        value.source_sha256 = "a".repeat(63);
        assert!(validate(&value).is_err());
        value.source_sha256 = "a".repeat(64);
        value.problem =
            Some(kcoder_types::migration_agent::MigrationAgentProblem::UnsupportedSemantics);
        assert!(validate(&value).is_err());
        value.can_adapt = false;
        validate(&value).unwrap();
    }
}
