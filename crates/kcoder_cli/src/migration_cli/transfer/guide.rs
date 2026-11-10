//! Guided cross-target migration is a client of the existing Gateway and Native journals.
use super::*;
use crate::cli_args::MigrationTransferGuideArgs;
use crate::migration_cli::guide::GuideIo;
use kcoder_app_protocol::*;
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
#[path = "guide/adoption.rs"]
mod adoption;
#[path = "guide/directory.rs"]
mod directory;
#[path = "guide/editor.rs"]
mod editor;
#[path = "guide/flow.rs"]
mod flow;
#[path = "guide/instructions.rs"]
mod instructions;
#[path = "guide/private.rs"]
mod private;
#[path = "guide/project_mcp.rs"]
mod project_mcp;
#[path = "guide/projects.rs"]
mod projects;
#[path = "guide/questions.rs"]
mod questions;
#[path = "guide/record.rs"]
mod record;
#[path = "guide/resources.rs"]
mod resources;
#[path = "guide/source_views.rs"]
mod source_views;
#[path = "guide/target.rs"]
mod target;
use record::{Draft, Store};

pub(super) fn run(
    options: &MigrationTransferArgs,
    args: &MigrationTransferGuideArgs,
    cwd: Option<&Path>,
) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let signal_cancel = cancelled.clone();
    let signal = runtime.spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancel.store(true, Ordering::Release);
        }
    });
    let result = runtime.block_on(async {
        let io = GuideIo::open(args.jsonl, cancelled.clone())?;
        let client = http::Client::open(&options.gateway, &options.access_token_env)?;
        let (mut store, saved) = Store::open(&args.record, cwd)?;
        let (base, _) = client.runtime_authority()?;
        let draft = match saved {
            Some(draft) => {
                ensure!(
                    draft.gateway == base.as_str()
                        && args
                            .source_target
                            .as_ref()
                            .is_none_or(|id| id == &draft.source.target_id)
                        && args
                            .target
                            .as_ref()
                            .is_none_or(|id| id == &draft.target.target_id)
                        && args
                            .source_workspace
                            .as_ref()
                            .is_none_or(|cwd| Some(cwd) == draft.source.workspace_path.as_ref())
                        && args
                            .target_workspace
                            .as_ref()
                            .is_none_or(|cwd| Some(cwd) == draft.target.workspace_path.as_ref())
                        && args.source_directory.as_ref().is_none_or(|path| draft
                            .source_views
                            .as_ref()
                            .and_then(|views| views.requested_directory.as_ref())
                            .is_some_and(|old| old == path))
                        && (!args.include_project || draft.include_project)
                        && (!args.include_history || draft.include_history),
                    "migration_transfer_record_scope_changed"
                );
                draft
            }
            None => {
                let targets = questions::targets(&client).await?;
                let source = questions::target(&io, &targets, args.source_target.as_deref(), true)?;
                let target = questions::target(&io, &targets, args.target.as_deref(), false)?;
                let kind = loop {
                    match io
                        .ask(
                            "source",
                            "选择来源产品：claude-code 或 codex。",
                            json!(["claude-code", "codex"]),
                            None,
                        )?
                        .as_str()
                    {
                        "claude-code" => {
                            break kcoder_types::migration::MigrationSourceKind::ClaudeCode;
                        }
                        "codex" => break kcoder_types::migration::MigrationSourceKind::Codex,
                        _ => io.notice(
                            "migration_transfer_invalid_selection",
                            "请选择明确的来源产品。",
                        )?,
                    }
                };
                let session = |purpose, target_id: String, workspace_path: Option<String>| {
                    MigrationSourceSessionParams {
                        session_id: uuid::Uuid::new_v4().to_string(),
                        purpose,
                        target_id,
                        workspace_path,
                    }
                };
                let mut draft = Draft {
                    version: 1,
                    gateway: base.to_string(),
                    source_scope: source.scope,
                    target_scope: target.scope,
                    source_principal: source.principal,
                    target_principal: target.principal,
                    source_kind: kind,
                    include_project: args.include_project,
                    include_history: args.include_history,
                    source: session(
                        MigrationSourceSessionPurpose::Source,
                        source.id,
                        args.source_workspace.clone(),
                    ),
                    target: session(
                        MigrationSourceSessionPurpose::Target,
                        target.id.clone(),
                        args.target_workspace.clone(),
                    ),
                    recovery: session(
                        MigrationSourceSessionPurpose::TargetRecovery,
                        target.id,
                        args.target_workspace.clone(),
                    ),
                    request_id: uuid::Uuid::new_v4().to_string(),
                    attempt_id: uuid::Uuid::new_v4().to_string(),
                    adoption_id: uuid::Uuid::new_v4().to_string(),
                    selections: Vec::new(),
                    source_views: args.source_directory.as_ref().map(|directory| {
                        record::SourceViews {
                            session_id: String::new(),
                            requested_directory: Some(directory.clone()),
                            ..Default::default()
                        }
                    }),
                    instruction_capture: None,
                    instruction_mappings: Vec::new(),
                    resource_increases: Default::default(),
                    private_credentials: None,
                    copy_prepared: false,
                    resume: None,
                    cancel_command_id: None,
                    target_finish_attempt: None,
                    target_cancel_id: None,
                    target_resume: None,
                    manifest_sha256: None,
                    adoption_selections: None,
                    adoption_prepared: false,
                    adoption_resume: None,
                    adoption_cancel_id: None,
                    selected_job: None,
                    batch_operations: Default::default(),
                };
                if let Some(views) = &mut draft.source_views {
                    views.session_id = draft.source.session_id.clone();
                }
                store.save(&draft)?;
                draft
            }
        };
        Guide {
            io,
            client,
            store,
            draft,
            cancelled,
            rpc_marker: http::rpc_marker(args.rpc_token_env.as_deref())?,
        }
        .execute()
        .await
    });
    signal.abort();
    result.map_err(|error| anyhow::anyhow!(safe_error(&error)))
}

struct Guide {
    io: GuideIo,
    client: http::Client,
    store: Store,
    draft: Draft,
    cancelled: Arc<AtomicBool>,
    rpc_marker: String,
}
impl Guide {
    async fn post<P: serde::Serialize, R: serde::de::DeserializeOwned>(
        &self,
        lane: &str,
        operation: &str,
        params: &P,
    ) -> Result<R> {
        tokio::select! {result=self.client.post(lane,operation,params)=>result,_=async{
            while !self.cancelled.load(Ordering::Acquire){tokio::time::sleep(Duration::from_millis(100)).await;}
        }=>anyhow::bail!("migration_transfer_stopped_read_original_request")}
    }
    async fn scope(&self, source: bool) -> Result<()> {
        self.io.active()?;
        let rows = questions::targets(&self.client).await?;
        let same = |id: &str, scope: &str, principal: &Option<String>| {
            rows.iter()
                .any(|row| row.id == id && row.scope == scope && &row.principal == principal)
        };
        ensure!(
            same(
                &self.draft.target.target_id,
                &self.draft.target_scope,
                &self.draft.target_principal
            ) && (!source
                || same(
                    &self.draft.source.target_id,
                    &self.draft.source_scope,
                    &self.draft.source_principal
                )),
            "migration_transfer_record_scope_changed"
        );
        Ok(())
    }
    fn save(&mut self) -> Result<()> {
        self.io.active()?;
        self.store.save(&self.draft)
    }
    async fn execute(&mut self) -> Result<()> {
        self.io.notice("migration_transfer_guide","向导只访问明确选择的来源和目标；不运行来源程序或模型。记录只保存公开选择与操作身份，原生回执才是结果。退出只停止本地等待，release 明确释放所属连接。")?;
        self.scope(false).await?;
        self.io.state("transfer_identity",&json!({"requestId":self.draft.request_id,"adoptionId":self.draft.adoption_id,"sourceTarget":self.draft.source.target_id,"destinationTarget":self.draft.target.target_id,"copyPrepared":self.draft.copy_prepared,"adoptionPrepared":self.draft.adoption_prepared}))?;
        loop {
            self.io.active()?;
            let action=self.io.ask("transfer_menu","select 选择资料及静态层次；instructions 明确捕获及预览指令；source-reset 明确释放后重新选择未传输来源目录；copy 确认传输；read 查原请求；reconnect 只重连原目标；reconnect-copy 重连既有两端；retry 核对后重试原尝试；cancel 取消；resume 明确恢复；finish 仅目标完成完整分片；target-cancel/target-resume 仅目标取消/恢复；adopt 选择接纳预览；adoption-read 核对接纳；adoption-retry 核对原接纳请求；adoption-resume 恢复接纳；adoption-cancel 取消接纳；batch 预览/提交/撤销；release 释放连接；quit 退出。",json!({"selected":self.draft.selections.len(),"requestId":self.draft.request_id,"received":self.draft.manifest_sha256.is_some()}),None)?;
            let result = match action.as_str() {
                "quit" => return Ok(()),
                "select" => self.select().await,
                "instructions" => self.choose_instructions().await,
                "source-reset" => self.reset_source_views().await,
                "copy" => self.copy(false).await,
                "retry" => self.copy(true).await,
                "read" => self.read_target(true).await.map(|_| ()),
                "reconnect" => self.reconnect(false).await,
                "reconnect-copy" => self.reconnect(true).await,
                "cancel" => self.cancel_copy().await,
                "resume" => self.resume_copy().await,
                "finish" => self.target_finish().await,
                "target-cancel" => self.target_cancel().await,
                "target-resume" => self.target_resume().await,
                "adopt" => self.adopt().await,
                "adoption-read" => self.adoption_read(true).await.map(|_| ()),
                "adoption-retry" => self.adoption_retry().await,
                "adoption-resume" => self.adoption_resume().await,
                "adoption-cancel" => self.adoption_cancel().await,
                "batch" => self.edit_batch().await,
                "release" => self.release().await,
                _ => self.io.notice(
                    "migration_transfer_invalid_selection",
                    "请选择明确的向导操作；未修改目标。",
                ),
            };
            if let Err(error) = result {
                self.io.notice(
                    &safe_error(&error),
                    "操作未确认完成。保留原记录和身份；先读取原生状态，不要创建替代请求。",
                )?;
            }
        }
    }
}
fn safe_error(error: &anyhow::Error) -> String {
    let text = error.to_string();
    if text.len() <= 180
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && (text.starts_with("migration_")
            || text.starts_with("source_transfer_")
            || private::is_error_code(&text))
    {
        text
    } else {
        "migration_transfer_failed_read_original_request".into()
    }
}
