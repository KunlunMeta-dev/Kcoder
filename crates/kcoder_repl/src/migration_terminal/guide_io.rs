//! The live owner and one pending prompt authorize an answer, not visible notice text.
use super::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};

pub(super) struct GuideInput {
    pub profile: PathBuf,
    pub cwd: PathBuf,
    session_id: String,
    pub pending: Arc<Mutex<Option<PendingPrompt>>>,
    pub sender: mpsc::Sender<String>,
}
pub(super) struct PendingPrompt {
    id: String,
    alias: String,
}
static USED_IDENTITIES: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
fn pending_prompt(id: &str) -> Result<PendingPrompt> {
    let mut used = USED_IDENTITIES.lock().unwrap_or_else(|e| e.into_inner());
    ensure!(used.insert(id.to_owned()), "migration_prompt_duplicate");
    let compact = id.replace('-', "");
    for width in [12, 16, 20, 24, 28, 32] {
        let alias = compact
            .get(..width)
            .context("migration_invalid_output")?
            .to_owned();
        if used.insert(alias.clone()) {
            return Ok(PendingPrompt {
                id: id.into(),
                alias,
            });
        }
    }
    anyhow::bail!("migration_prompt_duplicate")
}
impl GuideInput {
    pub fn invalidate(&self) {
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    pub fn matches(&self, engine: &QueryEngine) -> bool {
        engine
            .settings_persistence_path()
            .and_then(|p| p.parent().map(ToOwned::to_owned))
            .as_ref()
            == Some(&self.profile)
            && engine.state.cwd() == self.cwd
            && engine.state.artifact_session_id() == self.session_id
    }
    pub fn answer(&self, id: &str, value: &str) -> Result<()> {
        ensure!(value.len() <= 8192, "migration_answer_too_large");
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let current = pending.as_ref().context("migration_answer_stale_prompt")?;
        ensure!(
            current.id == id || current.alias == id,
            "migration_answer_stale_prompt"
        );
        let encoded = serde_json::to_string(&json!({"id":current.id,"value":value}))?;
        ensure!(encoded.len() < 8192, "migration_answer_too_large");
        self.sender
            .try_send(encoded)
            .map_err(|_| anyhow::anyhow!("migration_answer_unavailable"))?;
        *pending = None;
        Ok(())
    }
}
fn question_label(code: &str) -> &'static str {
    match code {
        "entry" => "开始或恢复迁移",
        "records" => "选择迁移记录",
        "instruction_request_id" => "核对指令捕获请求",
        "instruction_revalidate" => "重新授权原指令捕获",
        "instruction_format" => "核对原指令解释版本",
        "instruction_static_subset" => "确认静态指令解释子集",
        "instruction_source" => "选择指令来源格式",
        "instruction_root" => "授权指令来源根",
        "instruction_cwd" => "选择来源启动目录",
        "instruction_source_consent" => "确认只读指令来源",
        "instruction_descendants" => "选择子目录指令范围",
        "instruction_selection" => "选择指令与目标映射",
        "instruction_target_scope" => "映射目标指令目录",
        "instruction_incomplete_chain" => "确认保留不完整指令链",
        "instruction_capture_confirm" => "确认封存指令快照",
        "instruction_saved" => "查看封存指令原文",
        "instruction_next_body" => "读取指令下一段",
        "creation_request_id" => "打开原捕获请求",
        "creation_control" => "核对原捕获水位",
        "creation_control_id" => "核对捕获控制身份",
        "creation_confirm" => "确认原捕获恢复",
        "definition_selection" => "选择待处理Agent/Hook来源",
        "definition_saved" => "选择待处理定义",
        "definition_page" => "查看定义字段报告",
        "definition_save_consent" => "确认只保存待处理定义",
        "definition_next_body" => "读取定义下一段",
        "agent_adapt" => "明确选择静态Agent适配",
        "agent_original_body" => "检查原Agent定义",
        "agent_model_kind" => "选择Agent模型策略",
        "agent_provider" => "指定Agent目标Provider",
        "agent_model" => "指定Agent目标模型",
        "agent_tools" => "选择原定义允许的工具",
        "agent_reviewed_sha256" => "确认所审查原件SHA256",
        "memory_selection" | "transfer_memory_sources" => "选择未验证记忆来源",
        "memory_mapping" => "选择记忆目标范围",
        "memory_records" => "管理未验证记忆",
        "memory_control_consent" => "确认记忆上下文变更",
        "memory_request_id" => "核对记忆操作身份",
        "memory_receipt" => "核对原记忆回执",
        "memory_next_text" => "读取下一页记忆正文",
        "memory_undo_original" => "检查原迁移撤销",
        "history_selection" => "选择历史文件",
        "history_partial_consent" => "确认部分历史发现",
        "plugin_selection" => "选择插件包",
        "plugin_records" => "选择插件复制记录",
        "plugin_record_menu" => "处理原插件记录",
        "plugin_request_id" => "核对插件操作身份",
        "plugin_capture_consent" => "确认插件静态复制",
        "plugin_use_consent" => "确认纳入插件副本",
        "plugin_partial_consent" => "确认插件选择范围",
        "plugin_undo_confirm" => "确认独立插件撤销",
        "plugin_target_name" => "设置插件安装标识名",
        "menu" => "选择操作",
        "selection" => "选择迁移项目",
        "target_name" => "设置目标名称",
        "endpoint" => "设置连接地址",
        "model" => "设置模型",
        "context_window_tokens" => "设置上下文窗口",
        "output_headroom_tokens" => "设置输出预留",
        "max_output_tokens" => "设置最大输出",
        "credential_consent" => "授权已有连接密钥",
        "credential_source" => "选择已声明密钥来源",
        "mcp_cwd" => "设置 MCP 工作目录",
        "mcp_private_consent" => "授权所选私有字段",
        "enable_mcp" => "确认 MCP 启用",
        "enable_asset" => "确认资产启用",
        "template_dependency" => "确认模板连接依赖",
        "reuse" => "确认已有结果复用",
        "request_id" => "核对操作身份",
        "confirm_operation" => "确认目标变更",
        "results_page" => "浏览迁移结果",
        "source" => "选择来源产品",
        "source_home" => "选择来源目录",
        "project_source_directory" => "授权项目清单产品目录",
        "project_source_consent" => "确认只读项目清单",
        "project_sources" => "选择原项目清单",
        "project_source_roots" => "核对项目原根出处",
        "project_partial_consent" => "确认保留不完整项目清单",
        "project_target" => "明确选择Native目标工作区",
        "project_target_root" => "逐根关联实际可信目录",
        "project_register_name" => "登记目标工作区名称",
        "project_register_path" => "登记目标实际目录",
        "project_register_confirm" => "确认保留式工作区登记",
        "project_saved" => "查看原项目记录",
        "project_report" => "查看项目原出处与保存映射",
        "target_settings_scope" => "选择设置写入范围",
        "configuration_sources" => "选择静态设置来源",
        "configuration_layers_page" => "查看设置层次",
        "saved_configuration_layers" => "选择封存设置来源",
        "transfer_source_target" => "选择来源目标",
        "transfer_destination" => "选择接收目标",
        "transfer_sources" => "选择传输资料",
        "transfer_source_directory" => "选择来源主机目录",
        "transfer_source_directory_path" => "输入来源主机产品根",
        "transfer_source_directory_confirm" => "授权所选来源目录",
        "transfer_source_reset_confirm" => "确认重新选择来源",
        "transfer_instruction_root" => "授权来源指令根",
        "transfer_instruction_cwd" => "核对来源工作目录",
        "transfer_instruction_descendants" => "授权子目录指令扫描",
        "transfer_instruction_static" => "确认静态指令子集",
        "transfer_instruction_preview" => "预览来源指令",
        "transfer_instruction_select" => "确认传输指令快照",
        "transfer_instruction_workspace" => "确认目标工作区映射",
        "transfer_instruction_mapping" => "逐项映射指令目录",
        "transfer_instruction_scope" => "选择目标相对目录",
        "transfer_instruction_archive" => "保留不完整链待处理",
        "transfer_instruction_mapping_confirm" => "确认逐项指令映射",
        "transfer_instruction_saved" => "预览原批次指令快照",
        "transfer_resource_bytes" => "选择总字节上限",
        "transfer_resource_files" => "选择文件数上限",
        "transfer_resource_confirm" => "确认提高迁移预算",
        "transfer_resource_retry" => "核对原预算提高请求",
        "transfer_history_view_confirm" => "确认切换历史来源目录",
        "transfer_private_menu" => "处理原私密传输记录",
        "transfer_private_sources" => "选择原作业私密来源",
        "transfer_private_candidates" => "选择已映射私密字段",
        "transfer_private_selector" => "确认已声明凭据槽位",
        "transfer_private_fields" => "逐项选择MCP私有字段",
        "transfer_private_api_consent" => "确认传输已选API key",
        "transfer_private_mcp_consent" => "确认传输已选MCP私值",
        "transfer_private_continue" => "核对原私密接收",
        "transfer_private_cancel" => "取消原私密传输侧",
        "transfer_private_resume" => "恢复原私密控制水位",
        "transfer_private_release" => "释放原传输key",
        "transfer_private_prepare" => "确认原完整私密bundle",
        "transfer_private_restore" => "恢复原Native准备意图",
        "transfer_menu" => "处理跨目标迁移",
        "transfer_copy_confirm" => "确认资料传输",
        "transfer_cancel_confirm" => "确认取消传输",
        "transfer_resume_confirm" => "确认恢复传输",
        "transfer_reconnect" => "确认重新连接原目标",
        "transfer_target_finish" => "确认目标完成接收",
        "transfer_target_cancel" => "确认取消目标接收",
        "transfer_target_resume" => "确认恢复目标接收",
        "transfer_received_selection" => "选择接纳资料",
        "transfer_project_mapping" => "确认项目映射",
        "transfer_project_mcp_inheritance" => "选择保留的继承MCP名称",
        "transfer_adoption_confirm" => "确认接纳预览",
        "transfer_adoption_retry" => "核对原接纳请求",
        "transfer_adoption_resume" => "确认恢复接纳",
        "transfer_adoption_cancel" => "确认取消接纳",
        "transfer_batch_job" => "选择接纳批次",
        "transfer_batch_menu" => "处理远端批次",
        "transfer_batch_selection" => "选择远端迁入项目",
        "transfer_batch_confirm" => "确认远端目标变更",
        "transfer_batch_cancel" => "确认取消批次",
        "transfer_release_confirm" => "确认释放迁移连接",
        _ => "本地选择",
    }
}
fn item_label(value: &Value) -> &'static str {
    match value.as_str().unwrap_or("") {
        "template" => "会话模板",
        "provider" => "模型连接",
        "mcp" => "MCP",
        "agent" => "待处理Agent定义",
        "hook" => "待处理Hook定义",
        "skill" => "技能",
        "command" => "命令",
        "instructions" => "指令",
        "workflow" => "工作流",
        "history" => "历史",
        "plugin" => "插件配置",
        "project" => "项目关联",
        _ => "资产",
    }
}
fn question_choices(frame: &Value) -> Result<String> {
    if matches!(
        frame["code"].as_str(),
        Some("project_sources" | "project_target" | "project_target_root" | "project_saved")
    ) {
        let choices = &frame["choices"];
        let rows = choices["items"]
            .as_array()
            .context("migration_invalid_output")?;
        ensure!(rows.len() <= 10, "migration_invalid_output");
        let mut lines = vec![format!(
            "项目第 {} 页 · 已选 {} 项 · 出处路径不授权目标目录",
            choices["page"].as_u64().unwrap_or(0) + 1,
            choices["selected"].as_u64().unwrap_or(0)
        )];
        for row in rows {
            let number = row["number"]
                .as_u64()
                .filter(|n| (1..=10).contains(n))
                .context("migration_invalid_output")?;
            let title = row["title"]
                .as_str()
                .or_else(|| row["path"].as_str())
                .context("migration_invalid_output")?;
            let state = if frame["code"] == "project_target_root" {
                if row["available"] == true && row["trusted"] == true {
                    "可选择"
                } else {
                    "不可选择：未观察到可信可用根"
                }
            } else if row["selected"] == true {
                "已选"
            } else {
                "未选"
            };
            lines.push(format!(
                "{number}. [{state}] {}",
                serde_json::to_string(title)?
            ));
        }
        return Ok(lines.join("\n"));
    }

    if frame["code"] == "instruction_selection" {
        let choices = &frame["choices"];
        let rows = choices["items"]
            .as_array()
            .context("migration_invalid_output")?;
        ensure!(rows.len() <= 10, "migration_invalid_output");
        let mut lines = vec![format!(
            "第 {} 页 · 已选 {} 项 · 目标目录单独映射",
            choices["page"]
                .as_u64()
                .context("migration_invalid_output")?
                + 1,
            choices["selected"]
                .as_u64()
                .context("migration_invalid_output")?
        )];
        for row in rows {
            let number = row["number"]
                .as_u64()
                .filter(|n| (1..=10).contains(n))
                .context("migration_invalid_output")?;
            let path = row["relativePath"]
                .as_str()
                .context("migration_invalid_output")?;
            lines.push(format!(
                "{number}. [{}] 指令 {} · {} · {} bytes · 目标 {}",
                if row["targetRelativeScope"].is_string() {
                    "x"
                } else {
                    " "
                },
                serde_json::to_string(path)?,
                row["trigger"],
                row["bytes"],
                row["targetRelativeScope"]
            ));
        }
        return Ok(lines.join("\n"));
    }
    if matches!(
        frame["code"].as_str(),
        Some(
            "transfer_source_target"
                | "transfer_destination"
                | "transfer_sources"
                | "transfer_received_selection"
                | "transfer_batch_selection"
        )
    ) {
        let choices = &frame["choices"];
        let rows = choices["items"]
            .as_array()
            .context("migration_invalid_output")?;
        ensure!(rows.len() <= 10, "migration_invalid_output");
        let mut lines = vec![format!(
            "第 {} 页 · 已选 {} 项",
            choices["page"].as_u64().unwrap_or(0) + 1,
            choices["selected"].as_u64().unwrap_or(0)
        )];
        for row in rows {
            let number = row["number"]
                .as_u64()
                .filter(|n| (1..=10).contains(n))
                .context("migration_invalid_output")?;
            let title = row["title"]
                .as_str()
                .or_else(|| row["item"]["sourceName"].as_str());
            let label = match title {
                Some(value) => serde_json::to_string(value)?,
                None => format!(
                    "{} · {} files · {} bytes",
                    item_label(&row["category"]),
                    row["files"].as_u64().context("migration_invalid_output")?,
                    row["bytes"].as_u64().context("migration_invalid_output")?
                ),
            };
            lines.push(format!(
                "{number}. [{}] {label}",
                if row["selected"] == true { "x" } else { " " }
            ));
        }
        return Ok(lines.join("\n"));
    }
    if frame["code"] == "plugin_selection" || frame["code"] == "plugin_records" {
        let choices = &frame["choices"];
        let rows = choices["items"]
            .as_array()
            .context("migration_invalid_output")?;
        ensure!(rows.len() <= 10, "migration_invalid_output");
        let page = choices["page"]
            .as_u64()
            .context("migration_invalid_output")?;
        let mut lines = vec![format!("插件第 {} 页 · 每页最多10项", page + 1)];
        for row in rows {
            let number = row["number"]
                .as_u64()
                .filter(|n| (1..=10).contains(n))
                .context("migration_invalid_output")?;
            let value = if frame["code"] == "plugin_selection" {
                &row["candidate"]
            } else {
                &row["job"]
            };
            let name = value["name"].as_str().context("migration_invalid_output")?;
            let scope = value["scope"]
                .as_str()
                .context("migration_invalid_output")?;
            let pending = value["pending"]
                .as_array()
                .context("migration_invalid_output")?;
            let state = if value["stage"].is_null() {
                String::new()
            } else {
                format!(" · 状态 {}", serde_json::to_string(&value["stage"])?)
            };
            lines.push(format!(
                "{number}. [{}] 插件包 {} · 版本 {} · {scope}{state} · {}项待处理",
                if row["selected"] == true { "x" } else { " " },
                serde_json::to_string(name)?,
                serde_json::to_string(&value["installedVersion"])?,
                pending.len()
            ));
        }
        return Ok(lines.join("\n"));
    }
    if matches!(
        frame["code"].as_str(),
        Some("memory_selection" | "transfer_memory_sources")
    ) {
        let choices = &frame["choices"];
        let rows = choices["items"]
            .as_array()
            .context("migration_invalid_output")?;
        ensure!(rows.len() <= 10, "migration_invalid_output");
        let mut lines = vec![format!(
            "第 {} 页 · 已选 {} 个来源 · 未验证笔记（不是目标路径）",
            choices["page"]
                .as_u64()
                .context("migration_invalid_output")?
                + 1,
            choices["selected"]
                .as_u64()
                .context("migration_invalid_output")?
        )];
        for row in rows {
            let number = row["number"]
                .as_u64()
                .filter(|n| (1..=10).contains(n))
                .context("migration_invalid_output")?;
            lines.push(format!(
                "{number}. [{}] 记忆来源 {} · {}个文件 · {} bytes · {}项阻断",
                if row["selected"] == true { "x" } else { " " },
                serde_json::to_string(&row["sourceGroup"])?,
                row["files"],
                row["bytes"],
                row["blockedItems"]
            ));
        }
        return Ok(lines.join("\n"));
    }
    if frame["code"] == "memory_records" {
        let choices = &frame["choices"];
        let rows = choices["items"]
            .as_array()
            .context("migration_invalid_output")?;
        ensure!(rows.len() <= 10, "migration_invalid_output");
        let mut lines = vec![format!(
            "第 {} 页 · 共 {} 条未验证笔记",
            choices["page"]
                .as_u64()
                .context("migration_invalid_output")?
                + 1,
            choices["totalRecords"]
        )];
        for row in rows {
            let number = row["number"]
                .as_u64()
                .filter(|n| (1..=10).contains(n))
                .context("migration_invalid_output")?;
            lines.push(format!(
                "{number}. [{}] 未验证记忆 {} · {} bytes · 范围 {}",
                if row["record"]["enabled"] == true {
                    "启用"
                } else {
                    "停用"
                },
                serde_json::to_string(&row["record"]["name"])?,
                row["record"]["bytes"],
                row["record"]["scope"]["kind"]
            ));
        }
        return Ok(lines.join("\n"));
    }
    if frame["code"] == "history_selection" {
        let choices = &frame["choices"];
        let rows = choices["items"]
            .as_array()
            .context("migration_invalid_output")?;
        ensure!(rows.len() <= 10, "migration_invalid_output");
        let page = choices["page"]
            .as_u64()
            .context("migration_invalid_output")?;
        let selected = choices["selected"]
            .as_u64()
            .context("migration_invalid_output")?;
        let total = choices["totalItems"]
            .as_u64()
            .context("migration_invalid_output")?;
        let mut lines = vec![format!(
            "第 {} 页 · 发现 {total} 项 · 已选 {selected} 项",
            page + 1
        )];
        if choices["discoveryComplete"] != true {
            lines.push("发现尚不完整，仅可明确选择已发现项；不会报告全量迁入。".into());
        }
        for row in rows {
            let number = row["number"]
                .as_u64()
                .filter(|n| (1..=10).contains(n))
                .context("migration_invalid_output")?;
            let title = row["title"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| row["sourceSessionId"].as_str())
                .context("migration_invalid_output")?;
            let bytes = row["bytes"].as_u64().context("migration_invalid_output")?;
            let issues = row["importIssues"]
                .as_array()
                .context("migration_invalid_output")?;
            lines.push(format!(
                "{number}. [{}] 历史 {} · {bytes} bytes{}",
                if row["selected"] == true { "x" } else { " " },
                serde_json::to_string(title)?,
                if issues.is_empty() {
                    String::new()
                } else {
                    format!(" · 阻断项：{}", serde_json::to_string(issues)?)
                }
            ));
        }
        return Ok(lines.join("\n"));
    }
    if frame["code"] == "selection" {
        let choices = &frame["choices"];
        let rows = choices["items"]
            .as_array()
            .context("migration_invalid_output")?;
        ensure!(rows.len() <= 10, "migration_invalid_output");
        let page = choices["page"]
            .as_u64()
            .context("migration_invalid_output")?;
        let pages = choices["pages"]
            .as_u64()
            .context("migration_invalid_output")?;
        let selected = choices["selected"]
            .as_u64()
            .context("migration_invalid_output")?;
        ensure!(
            (pages == 0 && page == 0 && rows.is_empty()) || (pages > 0 && page < pages),
            "migration_invalid_output"
        );
        let mut lines = vec![format!(
            "第 {}/{} 页 · 已选 {} 项",
            if pages == 0 { 0 } else { page + 1 },
            pages,
            selected
        )];
        for row in rows {
            let label = if row["mappingKind"] == "plugin" {
                "插件包"
            } else if row["mappingKind"] == "template" {
                "会话模板"
            } else {
                item_label(&row["item"]["category"])
            };
            let number = row["number"]
                .as_u64()
                .filter(|n| (1..=10).contains(n))
                .context("migration_invalid_output")?;
            let issues = row["item"]["issues"]
                .as_array()
                .context("migration_invalid_output")?
                .len();
            lines.push(format!(
                "{number}. [{}] {label} {}{}",
                if row["selected"] == true { "x" } else { " " },
                serde_json::to_string(&row["item"]["sourceName"])?,
                if issues > 0 {
                    format!("（{issues}项提示，可用 details {number} 查看）")
                } else {
                    String::new()
                }
            ));
        }
        return Ok(lines.join("\n"));
    }
    if let Some(options) = frame["choices"].as_array() {
        return options
            .iter()
            .map(|option| {
                if option.is_string() {
                    return Ok(serde_json::to_string(option)?);
                }
                if let Some(number) = option["number"].as_u64() {
                    ensure!((1..=10).contains(&number), "migration_invalid_output");
                    return Ok(format!(
                        "{number}. {} · {}",
                        serde_json::to_string(&option["source"])?,
                        serde_json::to_string(&option["scope"])?
                    ));
                }
                Ok(format!(
                    "{} — {}",
                    serde_json::to_string(&option["value"])?,
                    serde_json::to_string(&option["label"])?
                ))
            })
            .collect::<Result<Vec<_>>>()
            .map(|lines| lines.join("\n"));
    }
    if frame["choices"].is_null() {
        Ok(String::new())
    } else {
        Ok(serde_json::to_string_pretty(&frame["choices"])?)
    }
}
pub(super) fn input(
    profile: PathBuf,
    cwd: PathBuf,
    session_id: String,
) -> (GuideInput, mpsc::Receiver<String>) {
    let (sender, receiver) = mpsc::channel(1);
    (
        GuideInput {
            profile,
            cwd,
            session_id,
            pending: Arc::new(Mutex::new(None)),
            sender,
        },
        receiver,
    )
}
pub(super) async fn stream(
    output: tokio::process::ChildStdout,
    tx: AppEventSender,
    pending: Arc<Mutex<Option<PendingPrompt>>>,
    cancel: CancellationToken,
) -> Result<()> {
    let mut output = BufReader::new(output);
    let mut total = 0usize;
    loop {
        let mut bytes = Vec::new();
        let count = (&mut output)
            .take(2 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
            .await?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count)
            .context("migration_output_too_large")?;
        ensure!(
            count <= 2 * 1024 * 1024 && total <= 64 * 1024 * 1024,
            "migration_output_too_large"
        );
        if cancel.is_cancelled() {
            break;
        }
        let frame: Value = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("migration_invalid_output"))?;
        let kind = frame["type"].as_str().context("migration_invalid_output")?;
        ensure!(
            matches!(
                kind,
                "target"
                    | "prompt"
                    | "notice"
                    | "state"
                    | "items"
                    | "item"
                    | "private_field"
                    | "definition_report"
                    | "definition_body"
                    | "agent_compatibility"
                    | "instruction_capture"
                    | "instruction_body"
                    | "instruction_report"
                    | "resource_budget"
                    | "private_transfer"
                    | "private_control"
                    | "private_preparation"
                    | "private_prepare_intent"
                    | "resource_increase_intent"
                    | "resource_increase_receipt"
                    | "creation"
                    | "configuration_layers"
                    | "source_directory"
                    | "operation"
                    | "progress"
                    | "plan_details"
                    | "memory_pending_control"
                    | "memory_control"
                    | "memory_text"
                    | "plugin_job"
                    | "plugin_candidate"
                    | "transfer_identity"
                    | "transfer_selection"
                    | "transfer_state"
                    | "connection_release"
                    | "discovery_problems"
                    | "adoption_state"
                    | "remote_batch_state"
                    | "remote_batch_confirm"
                    | "remote_batch_preview"
                    | "remote_batch_item"
            ),
            "migration_invalid_output"
        );
        let text = if kind == "prompt" {
            let id = frame["id"].as_str().context("migration_invalid_output")?;
            ensure!(
                id.len() == 36
                    && id.bytes().enumerate().all(|(at, byte)| {
                        if [8, 13, 18, 23].contains(&at) {
                            byte == b'-'
                        } else {
                            byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                        }
                    }),
                "migration_invalid_output"
            );
            let mut current = pending.lock().unwrap_or_else(|e| e.into_inner());
            ensure!(current.is_none(), "migration_prompt_overlap");
            if cancel.is_cancelled() {
                break;
            }
            let prompt = pending_prompt(id)?;
            let alias = prompt.alias.clone();
            *current = Some(prompt);
            let message = frame["message"]
                .as_str()
                .context("migration_invalid_output")?;
            let code = frame["code"].as_str().context("migration_invalid_output")?;
            let choices = question_choices(&frame)?;
            let default = if frame["default"].is_null() {
                String::new()
            } else {
                format!("\n默认值：{}", serde_json::to_string(&frame["default"])?)
            };
            format!(
                "本地迁移向导（不发送给模型）\n{message}\n```text\n{choices}\n```{default}\n当前问题：{}\n用 `/migrate answer {alias} <回答>` 作答；接受默认值时省略回答。`/migrate stop` 停止。",
                question_label(code)
            )
        } else if kind == "item" {
            format!(
                "正在配置：{} {}",
                item_label(&frame["result"]["category"]),
                serde_json::to_string(&frame["result"]["sourceName"])?
            )
        } else {
            format!(
                "本地迁移回执（不发送给模型）\n```json\n{}\n```",
                serde_json::to_string_pretty(&frame)?
            )
        };
        if cancel.is_cancelled() {
            break;
        }
        tx.send_ordered(AppEvent::SystemNotice(text)).await;
    }
    *pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(())
}
pub(super) async fn answers(
    mut input: tokio::process::ChildStdin,
    mut receiver: mpsc::Receiver<String>,
    cancel: CancellationToken,
) -> Result<()> {
    loop {
        tokio::select! {
            _=cancel.cancelled()=>return Ok(()),
            value=receiver.recv()=>match value {
                Some(value)=>{if cancel.is_cancelled(){return Ok(());} input.write_all(value.as_bytes()).await?;input.write_all(b"\n").await?;input.flush().await?;},
                None=>return Ok(()),
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn answers_are_single_use_and_expired_prompts_cannot_authorize_the_next_question() {
        let (input, mut rx) = input(
            PathBuf::from("profile"),
            PathBuf::from("workspace"),
            "owner".into(),
        );
        *input.pending.lock().unwrap() = Some(PendingPrompt {
            id: "current".into(),
            alias: "short".into(),
        });
        assert!(input.answer("old", "SYNTHETIC_ANSWER_SECRET").is_err());
        input.answer("current", "yes").unwrap();
        assert!(input.answer("current", "yes").is_err());
        assert!(rx.try_recv().unwrap().contains("current"));
        *input.pending.lock().unwrap() = Some(PendingPrompt {
            id: "next".into(),
            alias: "next-short".into(),
        });
        assert!(input.answer("current", "yes").is_err());
        input.invalidate();
        assert!(input.answer("next", "yes").is_err());
    }
    #[test]
    fn question_rows_are_compact_and_source_issue_codes_are_reserved_for_details() {
        let frame = json!({"code":"selection","choices":{"page":0,"pages":1,"selected":0,"items":[{"number":1,"selected":false,"mappingKind":"mcp","item":{"id":"PRIVATE_BINDING_MUST_NOT_RENDER","category":"mcp","sourceName":"docs","issues":[{"code":"secret_excluded"}]}}]}});
        let text = question_choices(&frame).unwrap();
        assert!(text.contains("1. [ ] MCP \"docs\""));
        assert!(text.contains("details 1"));
        assert!(
            !text.contains("PRIVATE_BINDING_MUST_NOT_RENDER") && !text.contains("secret_excluded")
        );
        let missing_counts = json!({"code":"selection","choices":{"items":[]}});
        assert!(question_choices(&missing_counts).is_err());
        let empty =
            json!({"code":"selection","choices":{"page":0,"pages":0,"selected":0,"items":[]}});
        assert_eq!(question_choices(&empty).unwrap(), "第 0/0 页 · 已选 0 项");
    }
    #[test]
    fn instruction_rows_keep_private_binding_opaque_and_bound_the_review_page() {
        let frame = json!({"code":"instruction_selection","choices":{"page":0,"selected":1,"items":[{"number":1,"sourceId":"PRIVATE_SOURCE_HANDLE","relativePath":"child/AGENTS.md","trigger":"on_cwd","bytes":41,"targetRelativeScope":"mapped"}]}});
        let text = question_choices(&frame).unwrap();
        assert!(
            text.contains("child/AGENTS.md")
                && text.contains("mapped")
                && !text.contains("PRIVATE_SOURCE_HANDLE")
        );
        let mut oversized = frame;
        oversized["choices"]["items"] = json!(vec![oversized["choices"]["items"][0].clone(); 11]);
        assert!(question_choices(&oversized).is_err());
    }
    #[test]
    fn display_aliases_never_reuse_an_older_question_in_the_same_terminal() {
        let first = pending_prompt("ffeeddcc-bbaa-4000-8000-000000000001").unwrap();
        let next = pending_prompt("ffeeddcc-bbaa-4000-8000-000000000002").unwrap();
        assert_ne!(first.alias, next.alias);
        let (input, _rx) = input(
            PathBuf::from("profile"),
            PathBuf::from("workspace"),
            "owner".into(),
        );
        let old = first.alias;
        let current = next.alias.clone();
        *input.pending.lock().unwrap() = Some(next);
        assert!(input.answer(&old, "yes").is_err());
        assert!(input.answer(&current, "yes").is_ok());
    }
}

#[cfg(test)]
mod project_prompt_tests {
    use super::*;
    #[test]
    fn project_rows_hide_opaque_ids_and_untrusted_roots_remain_unselectable() {
        let source = json!({"code":"project_sources","choices":{"page":1,"selected":2,"items":[{"number":1,"title":"Original name","sourceHandle":"OPAQUE_ID_MUST_NOT_RENDER","selected":true}]}});
        let text = question_choices(&source).unwrap();
        assert!(
            text.contains("Original name")
                && text.contains("已选 2")
                && !text.contains("OPAQUE_ID")
        );
        let target = json!({"code":"project_target_root","choices":{"page":0,"items":[{"number":1,"path":"owned target","trusted":false,"available":true,"targetRootHandle":"OPAQUE_ID_MUST_NOT_RENDER"}]}});
        let text = question_choices(&target).unwrap();
        assert!(text.contains("不可选择") && !text.contains("OPAQUE_ID"));
        assert_eq!(question_label("project_target"), "明确选择Native目标工作区");
        assert_eq!(item_label(&json!("project")), "项目关联");
    }
}
