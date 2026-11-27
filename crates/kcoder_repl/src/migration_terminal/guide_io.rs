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
        "entry" => "Start or resume migration",
        "records" => "Select migration records",
        "instruction_request_id" => "Check instruction capture request",
        "instruction_revalidate" => "Reauthorize original instruction capture",
        "instruction_format" => "Check original instruction interpretation version",
        "instruction_static_subset" => "Confirm static instruction interpretation subset",
        "instruction_source" => "Select instruction source format",
        "instruction_root" => "Authorize instruction source root",
        "instruction_cwd" => "Select source startup directory",
        "instruction_source_consent" => "Confirm read-only instruction source access",
        "instruction_descendants" => "Select descendant instruction scope",
        "instruction_selection" => "Select instructions and target mappings",
        "instruction_target_scope" => "Map target instruction directory",
        "instruction_incomplete_chain" => "Confirm retaining an incomplete instruction chain",
        "instruction_capture_confirm" => "Confirm archiving instruction snapshots",
        "instruction_saved" => "View archived original instructions",
        "instruction_next_body" => "Read the next instruction section",
        "creation_request_id" => "Open original capture request",
        "creation_control" => "Check original capture progress",
        "creation_control_id" => "Check capture control identity",
        "creation_confirm" => "Confirm resuming original capture",
        "definition_selection" => "Select pending Agent/Hook sources",
        "definition_saved" => "Select pending definitions",
        "definition_page" => "View definition field report",
        "definition_save_consent" => "Confirm saving pending definitions only",
        "definition_next_body" => "Read the next definition section",
        "agent_adapt" => "Explicitly select static Agent adaptation",
        "agent_original_body" => "Review original Agent definition",
        "agent_model_kind" => "Select Agent model policy",
        "agent_provider" => "Set target Agent Provider",
        "agent_model" => "Set target Agent model",
        "agent_tools" => "Select tools allowed by the original definition",
        "agent_reviewed_sha256" => "Confirm reviewed original SHA256",
        "memory_selection" | "transfer_memory_sources" => "Select unverified memory sources",
        "memory_mapping" => "Select target memory scope",
        "memory_records" => "Manage unverified memories",
        "memory_control_consent" => "Confirm memory context changes",
        "memory_request_id" => "Check memory operation identity",
        "memory_receipt" => "Check original memory receipt",
        "memory_next_text" => "Read the next memory text page",
        "memory_undo_original" => "Review original migration rollback",
        "history_selection" => "Select history files",
        "history_partial_consent" => "Confirm partial history discovery",
        "plugin_selection" => "Select plugin packages",
        "plugin_records" => "Select plugin copy records",
        "plugin_record_menu" => "Manage original plugin record",
        "plugin_request_id" => "Check plugin operation identity",
        "plugin_capture_consent" => "Confirm static plugin copy",
        "plugin_use_consent" => "Confirm including plugin copies",
        "plugin_partial_consent" => "Confirm plugin selection scope",
        "plugin_undo_confirm" => "Confirm standalone plugin rollback",
        "plugin_target_name" => "Set plugin installation identifier",
        "menu" => "Select an operation",
        "selection" => "Select migration items",
        "target_name" => "Set target name",
        "endpoint" => "Set connection endpoint",
        "model" => "Set model",
        "context_window_tokens" => "Set context window",
        "output_headroom_tokens" => "Set output headroom",
        "max_output_tokens" => "Set maximum output",
        "credential_consent" => "Authorize an existing connection credential",
        "credential_source" => "Select a declared credential source",
        "mcp_cwd" => "Set MCP working directory",
        "mcp_private_consent" => "Authorize selected private fields",
        "enable_mcp" => "Confirm enabling MCP",
        "enable_asset" => "Confirm enabling assets",
        "template_dependency" => "Confirm template connection dependencies",
        "reuse" => "Confirm reusing existing results",
        "request_id" => "Check operation identity",
        "confirm_operation" => "Confirm target changes",
        "results_page" => "Browse migration results",
        "source" => "Select source product",
        "source_home" => "Select source directory",
        "project_source_directory" => "Authorize project-list product directory",
        "project_source_consent" => "Confirm read-only project list access",
        "project_sources" => "Select original project lists",
        "project_source_roots" => "Check original project root provenance",
        "project_partial_consent" => "Confirm retaining an incomplete project list",
        "project_target" => "Explicitly select a Native target workspace",
        "project_target_root" => "Associate each root with an actual trusted directory",
        "project_register_name" => "Register target workspace name",
        "project_register_path" => "Register actual target directory",
        "project_register_confirm" => "Confirm non-destructive workspace registration",
        "project_saved" => "View original project records",
        "project_report" => "View project provenance and saved mappings",
        "target_settings_scope" => "Select settings destination scope",
        "configuration_sources" => "Select static settings sources",
        "configuration_layers_page" => "View settings layers",
        "saved_configuration_layers" => "Select archived settings sources",
        "transfer_source_target" => "Select source target",
        "transfer_destination" => "Select receiving target",
        "transfer_sources" => "Select transfer items",
        "transfer_source_directory" => "Select source-host directory",
        "transfer_source_directory_path" => "Enter source-host product root",
        "transfer_source_directory_confirm" => "Authorize selected source directory",
        "transfer_source_reset_confirm" => "Confirm source reselection",
        "transfer_instruction_root" => "Authorize source instruction root",
        "transfer_instruction_cwd" => "Check source working directory",
        "transfer_instruction_descendants" => "Authorize descendant instruction scanning",
        "transfer_instruction_static" => "Confirm static instruction subset",
        "transfer_instruction_preview" => "Preview source instructions",
        "transfer_instruction_select" => "Confirm instruction snapshot transfer",
        "transfer_instruction_workspace" => "Confirm target workspace mapping",
        "transfer_instruction_mapping" => "Map each instruction directory",
        "transfer_instruction_scope" => "Select target-relative directory",
        "transfer_instruction_archive" => "Retain incomplete chains as pending",
        "transfer_instruction_mapping_confirm" => "Confirm per-item instruction mappings",
        "transfer_instruction_saved" => "Preview original batch instruction snapshots",
        "transfer_resource_bytes" => "Select total byte limit",
        "transfer_resource_files" => "Select file count limit",
        "transfer_resource_confirm" => "Confirm increasing migration budget",
        "transfer_resource_retry" => "Check original budget increase request",
        "transfer_history_view_confirm" => "Confirm changing history source directory",
        "transfer_private_menu" => "Manage original private transfer record",
        "transfer_private_sources" => "Select original job private sources",
        "transfer_private_candidates" => "Select mapped private fields",
        "transfer_private_selector" => "Confirm declared credential slots",
        "transfer_private_fields" => "Select individual private MCP fields",
        "transfer_private_api_consent" => "Confirm transferring selected API keys",
        "transfer_private_mcp_consent" => "Confirm transferring selected private MCP values",
        "transfer_private_continue" => "Check original private receipt",
        "transfer_private_cancel" => "Cancel original private transfer side",
        "transfer_private_resume" => "Restore original private control progress",
        "transfer_private_release" => "Release original transfer key",
        "transfer_private_prepare" => "Confirm original complete private bundle",
        "transfer_private_restore" => "Restore original Native preparation intent",
        "transfer_menu" => "Manage cross-target migration",
        "transfer_copy_confirm" => "Confirm data transfer",
        "transfer_cancel_confirm" => "Confirm transfer cancellation",
        "transfer_resume_confirm" => "Confirm resuming transfer",
        "transfer_reconnect" => "Confirm reconnecting to original target",
        "transfer_target_finish" => "Confirm target receipt completion",
        "transfer_target_cancel" => "Confirm cancelling target receipt",
        "transfer_target_resume" => "Confirm resuming target receipt",
        "transfer_received_selection" => "Select adoption items",
        "transfer_project_mapping" => "Confirm project mappings",
        "transfer_project_mcp_inheritance" => "Select inherited MCP names to retain",
        "transfer_adoption_confirm" => "Confirm adoption preview",
        "transfer_adoption_retry" => "Check original adoption request",
        "transfer_adoption_resume" => "Confirm resuming adoption",
        "transfer_adoption_cancel" => "Confirm adoption cancellation",
        "transfer_batch_job" => "Select adoption batch",
        "transfer_batch_menu" => "Manage remote batch",
        "transfer_batch_selection" => "Select remote migration items",
        "transfer_batch_confirm" => "Confirm remote target changes",
        "transfer_batch_cancel" => "Confirm batch cancellation",
        "transfer_release_confirm" => "Confirm releasing migration connection",
        _ => "Local selection",
    }
}
fn item_label(value: &Value) -> &'static str {
    match value.as_str().unwrap_or("") {
        "template" => "Session template",
        "provider" => "Model connection",
        "mcp" => "MCP",
        "agent" => "Pending Agent definition",
        "hook" => "Pending Hook definition",
        "skill" => "Skill",
        "command" => "Command",
        "instructions" => "Instructions",
        "workflow" => "Workflow",
        "history" => "History",
        "plugin" => "Plugin configuration",
        "project" => "Project association",
        _ => "Asset",
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
            "Projects page {} · {} selected · Source paths do not authorize target directories",
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
                    "Selectable"
                } else {
                    "Unavailable: no trusted, available root observed"
                }
            } else if row["selected"] == true {
                "Selected"
            } else {
                "Not selected"
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
            "Page {} · {} selected · Map target directories separately",
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
                "{number}. [{}] Instructions {} · {} · {} bytes · Target {}",
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
            "Page {} · {} selected",
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
        let mut lines = vec![format!(
            "Plugins page {} · Up to 10 items per page",
            page + 1
        )];
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
                format!(" · Status {}", serde_json::to_string(&value["stage"])?)
            };
            lines.push(format!(
                "{number}. [{}] Plugin package {} · Version {} · {scope}{state} · {} pending",
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
            "Page {} · {} sources selected · Unverified notes (not target paths)",
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
                "{number}. [{}] Memory source {} · {} files · {} bytes · {} blockers",
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
            "Page {} · {} unverified notes",
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
                "{number}. [{}] Unverified memory {} · {} bytes · Scope {}",
                if row["record"]["enabled"] == true {
                    "Enabled"
                } else {
                    "Disabled"
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
            "Page {} · {total} discovered · {selected} selected",
            page + 1
        )];
        if choices["discoveryComplete"] != true {
            lines.push("Discovery is incomplete. Select only discovered items explicitly; this is not a complete import.".into());
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
                "{number}. [{}] History {} · {bytes} bytes{}",
                if row["selected"] == true { "x" } else { " " },
                serde_json::to_string(title)?,
                if issues.is_empty() {
                    String::new()
                } else {
                    format!(" · Blockers: {}", serde_json::to_string(issues)?)
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
            "Page {}/{} · {} selected",
            if pages == 0 { 0 } else { page + 1 },
            pages,
            selected
        )];
        for row in rows {
            let label = if row["mappingKind"] == "plugin" {
                "Plugin package"
            } else if row["mappingKind"] == "template" {
                "Session template"
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
                    format!(" ({issues} issues; use details {number} to review)")
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
                format!("\nDefault: {}", serde_json::to_string(&frame["default"])?)
            };
            format!(
                "Local migration guide (not sent to the model)\n{message}\n```text\n{choices}\n```{default}\nCurrent question: {}\nReply with `/migrate answer {alias} <answer>`; omit the answer to accept the default. Use `/migrate stop` to stop.",
                question_label(code)
            )
        } else if kind == "item" {
            format!(
                "Configuring: {} {}",
                item_label(&frame["result"]["category"]),
                serde_json::to_string(&frame["result"]["sourceName"])?
            )
        } else {
            format!(
                "Local migration receipt (not sent to the model)\n```json\n{}\n```",
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
        assert_eq!(question_choices(&empty).unwrap(), "Page 0/0 · 0 selected");
    }

    #[test]
    fn english_guide_chrome_preserves_original_source_titles() {
        let frame = json!({"code":"history_selection","choices":{"page":0,"selected":1,"totalItems":1,"discoveryComplete":true,"items":[{"number":1,"title":"用户原始会话标题","selected":true,"bytes":42,"importIssues":[]}]}});
        let text = question_choices(&frame).unwrap();
        assert!(text.starts_with("Page 1 · 1 discovered · 1 selected"));
        assert!(text.contains("History") && text.contains("用户原始会话标题"));
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
                && text.contains("2 selected")
                && !text.contains("OPAQUE_ID")
        );
        let target = json!({"code":"project_target_root","choices":{"page":0,"items":[{"number":1,"path":"owned target","trusted":false,"available":true,"targetRootHandle":"OPAQUE_ID_MUST_NOT_RENDER"}]}});
        let text = question_choices(&target).unwrap();
        assert!(text.contains("Unavailable") && !text.contains("OPAQUE_ID"));
        assert_eq!(
            question_label("project_target"),
            "Explicitly select a Native target workspace"
        );
        assert_eq!(item_label(&json!("project")), "Project association");
    }
}
