//! The guided editor submits the same public choices and operation identities as other clients.
use super::*;
use kcoder_types::migration::MigrationCategory;
use std::collections::BTreeMap;
#[path = "editor/agents.rs"]
mod agents;
#[path = "editor/configurable.rs"]
mod configurable;

impl Guide {
    pub(super) async fn edit_batch(&mut self) -> Result<()> {
        let state = self.adoption_read(true).await?;
        let MigrationSourceNullable::Value(state) = state.state else {
            anyhow::bail!("migration_transfer_preview_required")
        };
        ensure!(
            state.phase == MigrationSourceAdoptionPhase::PreviewReady
                && state.worker_state == MigrationSourceAdoptionWorkerState::Stopped,
            "migration_transfer_preview_required"
        );
        ensure!(
            !state.jobs.is_empty() && state.jobs.iter().all(|job| job.preview_ready),
            "migration_transfer_preview_required"
        );
        let job = loop {
            let rows=state.jobs.iter().enumerate().map(|(i,job)|json!({"number":i+1,"jobId":job.job_id,"source":job.source,"scope":job.target_scope})).collect::<Vec<_>>();
            let answer = self.io.ask(
                "transfer_batch_job",
                "选择当前接纳回执中的原生批次编号；quit 返回。",
                json!(rows),
                None,
            )?;
            if answer == "quit" {
                return Ok(());
            }
            if let Some(job) = answer
                .parse::<usize>()
                .ok()
                .and_then(|n| n.checked_sub(1))
                .and_then(|n| state.jobs.get(n))
            {
                break job.job_id.clone();
            }
            self.io.notice(
                "migration_transfer_invalid_selection",
                "请选择回执中可用的批次编号。",
            )?;
        };
        self.draft.selected_job = Some(job.clone());
        self.save()?;
        self.scope(false).await?;
        let (base, authorization) = self.client.runtime_authority()?;
        let mut client = runtime::Client::connect(
            &base,
            &authorization,
            &self.rpc_marker,
            &self.draft.target.target_id,
            self.draft.target.workspace_path.as_deref(),
        )
        .await?;
        client.require(CAPABILITY_MIGRATION_BATCH_WORKERS_V1)?;
        let result = self.batch_menu(&mut client, &job).await;
        let released = client.close().await;
        if released.is_err() {
            self.io.notice(
                "migration_remote_connection_close_unknown",
                "本连接释放尚未确认；以原批次回执为准。",
            )?;
        }
        result
    }
    pub(super) async fn rpc<P: serde::Serialize, R: serde::de::DeserializeOwned>(
        &self,
        client: &mut runtime::Client,
        method: &str,
        params: &P,
    ) -> Result<R> {
        self.scope(false).await?;
        let value = tokio::select! {value=client.call(method,params)=>value,_=async{
            while !self.cancelled.load(Ordering::Acquire){tokio::time::sleep(Duration::from_millis(100)).await;}
        }=>Err(anyhow::anyhow!("migration_transfer_stopped_read_original_request"))}?;
        self.scope(false).await?;
        Ok(value)
    }
    pub(super) async fn batch_read(
        &self,
        client: &mut runtime::Client,
        job: &str,
    ) -> Result<MigrationBatchStateResult> {
        let state: MigrationBatchStateResult = self
            .rpc(
                client,
                method::MIGRATION_BATCH_READ,
                &MigrationOperationParams { job_id: job.into() },
            )
            .await?;
        ensure!(
            state.state.job.job_id == job,
            "migration_remote_invalid_response"
        );
        Ok(state)
    }
    async fn batch_menu(&mut self, client: &mut runtime::Client, job: &str) -> Result<()> {
        loop {
            let state = self.batch_read(client, job).await?;
            self.io.state("remote_batch_state", &state)?;
            let answer=self.io.ask("transfer_batch_menu","read 刷新；projects 原项目出处/目标映射；instructions 原批次指令原文/compiled；resources 预算及原提高回执；resources-increase 明确提高额度；private 从已存计划逐项选择私密bundle及核对原状态；select 逐项选择并预览；apply 确认提交；reconcile 核对原尝试；resume 明确恢复；undo 撤销；cancel 取消；back 返回。",json!({"jobId":job,"workerRunning":state.worker_running,"unconfirmed":state.state.job.has_unconfirmed_outcomes}),None)?;
            let result = match answer.as_str() {
                "back" => return Ok(()),
                "read" => Ok(()),
                "instructions" => self.saved_instructions(client, job).await,
                "projects" => self.saved_projects(client, job).await,
                "resources" => self.resource_budget(client, job).await,
                "private" => self.private_menu(client, job).await,
                "resources-increase" if !state.worker_running => {
                    self.resource_increase(client, job, &state).await
                }
                "select" if !state.worker_running => {
                    self.batch_select(client, job, state.state.job.sequence)
                        .await
                }
                "apply" if !state.worker_running => {
                    self.batch_operation(client, job, &state, MigrationBatchRunMode::Apply, false)
                        .await
                }
                "resume" if !state.worker_running => {
                    self.batch_operation(client, job, &state, MigrationBatchRunMode::Resume, false)
                        .await
                }
                "undo" if !state.worker_running => {
                    self.batch_operation(
                        client,
                        job,
                        &state,
                        MigrationBatchRunMode::Rollback,
                        false,
                    )
                    .await
                }
                "reconcile" if !state.worker_running => {
                    self.batch_operation(client, job, &state, MigrationBatchRunMode::Apply, true)
                        .await
                }
                "cancel" => {
                    if self.io.yes(
                        "transfer_batch_cancel",
                        "确认取消原批次？已经确认的提交不会被当作未发生；撤销是独立操作。",
                    )? {
                        let result: MigrationJobReadResult = self
                            .rpc(
                                client,
                                method::MIGRATION_CANCEL,
                                &MigrationCancelParams {
                                    job_id: job.into(),
                                    expected_sequence: state.state.job.sequence,
                                },
                            )
                            .await?;
                        ensure!(
                            result.job.job_id == job,
                            "migration_remote_invalid_response"
                        );
                        self.io.state("remote_batch_state", &result)
                    } else {
                        Ok(())
                    }
                }
                _ => self.io.notice(
                    "migration_transfer_invalid_selection",
                    "请选择当前可执行的操作；活动工作不会被重复启动。",
                ),
            };
            if let Err(error) = result {
                self.io.notice(
                    &safe_error(&error),
                    "未确认该批次操作完成。先读取原记录；不自动重发或改变请求身份。",
                )?;
            }
        }
    }
    async fn batch_operation(
        &mut self,
        client: &mut runtime::Client,
        job: &str,
        state: &MigrationBatchStateResult,
        mode: MigrationBatchRunMode,
        reconcile: bool,
    ) -> Result<()> {
        let params = if reconcile {
            self.draft
                .batch_operations
                .get(job)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("migration_transfer_original_operation_required"))?
        } else {
            ensure!(
                !state.state.job.has_unconfirmed_outcomes,
                "migration_transfer_reconcile_original_first"
            );
            let plan_id = state
                .state
                .batch
                .as_ref()
                .and_then(|batch| batch.plan_id.clone())
                .ok_or_else(|| anyhow::anyhow!("migration_transfer_preview_required"))?;
            MigrationBatchRunParams {
                job_id: job.into(),
                expected_sequence: state.state.job.sequence,
                plan_id,
                request_id: uuid::Uuid::new_v4().to_string(),
                mode,
            }
        };
        self.io.state("remote_batch_confirm",&json!({"job":state.state,"operation":params.mode,"requestId":params.request_id,"originalAttempt":reconcile}))?;
        let required = if params.mode == MigrationBatchRunMode::Rollback {
            "UNDO"
        } else {
            "IMPORT"
        };
        ensure!(self.io.ask("transfer_batch_confirm",&format!("核对以上原生预览与问题后，输入 {required} 确认这项操作。不会修改其它目标或运行来源程序。"),serde_json::Value::Null,None)?==required,"migration_transfer_confirmation_required");
        self.draft
            .batch_operations
            .insert(job.into(), params.clone());
        self.save()?;
        let mut result: MigrationBatchStateResult = self
            .rpc(client, method::MIGRATION_BATCH_RUN, &params)
            .await?;
        let deadline = std::time::Instant::now() + Duration::from_secs(300);
        loop {
            ensure!(
                result.state.job.job_id == job,
                "migration_remote_invalid_response"
            );
            self.io.state("remote_batch_state", &result)?;
            if !result.worker_running || std::time::Instant::now() >= deadline {
                return Ok(());
            }
            self.io.active()?;
            tokio::time::sleep(Duration::from_millis(500)).await;
            result = self.batch_read(client, job).await?;
        }
    }
    async fn batch_select(
        &mut self,
        client: &mut runtime::Client,
        job: &str,
        sequence: u64,
    ) -> Result<()> {
        let current = self.batch_read(client, job).await?;
        ensure!(
            current
                .state
                .batch
                .as_ref()
                .is_some_and(|batch| batch.plan_id.is_none()),
            "migration_plan_already_exists"
        );
        let mut page = 0usize;
        let mut selected = BTreeMap::<String, MigrationBatchChoice>::new();
        let mut project_catalog = None;
        loop {
            let result: MigrationItemsResult = self
                .rpc(
                    client,
                    method::MIGRATION_ITEMS,
                    &MigrationItemsParams {
                        job_id: job.into(),
                        cursor: None,
                        page_index: Some(page),
                        include_templates: true,
                    },
                )
                .await?;
            ensure!(
                result.items.len() <= 10,
                "migration_remote_invalid_response"
            );
            let rows=result.items.iter().enumerate().map(|(i,item)|json!({"number":i+1,"item":item,"selected":selected.contains_key(&item.id)})).collect::<Vec<_>>();
            let answer=self.io.ask("transfer_batch_selection","toggle N 选择/取消并配置，details N 查看已公开的候选，next/prev 翻页，preview 生成保存的预览，quit 返回。没有默认全选。",json!({"page":page,"selected":selected.len(),"items":rows}),None)?;
            let mut words = answer.split_whitespace();
            match words.next().unwrap_or("") {
                "quit" => return Ok(()),
                "next" if result.next_cursor.is_some() => page += 1,
                "prev" if page > 0 => page -= 1,
                "preview" if !selected.is_empty() => {
                    let fresh = self.batch_read(client, job).await?;
                    ensure!(
                        fresh.state.job.sequence == sequence && !fresh.worker_running,
                        "migration_remote_preview_changed"
                    );
                    let inheritance = self
                        .project_mcp_selection(client, job, selected.values())
                        .await?;
                    let params = MigrationBatchPlanParams {
                        project_mcp_inheritance: inheritance,
                        job_id: job.into(),
                        expected_sequence: sequence,
                        choices: selected.into_values().collect(),
                        include_default_items: false,
                        excluded_item_ids: Vec::new(),
                        reuse_existing: self.io.yes(
                            "reuse",
                            "是否复用已确认且目标未被编辑的旧结果？不会补入新的秘密。",
                        )?,
                        credentials: Vec::new(),
                        mcp_credentials: Vec::new(),
                    };
                    let planned: MigrationJobReadResult = self
                        .rpc(client, method::MIGRATION_BATCH_PLAN, &params)
                        .await?;
                    ensure!(
                        planned.job.job_id == job,
                        "migration_remote_invalid_response"
                    );
                    return self.io.state("remote_batch_preview", &planned);
                }
                verb @ ("toggle" | "details") => {
                    if let Some(item) = words
                        .next()
                        .and_then(|n| n.parse::<usize>().ok())
                        .filter(|n| (1..=10).contains(n))
                        .and_then(|n| result.items.get(n - 1))
                    {
                        if verb == "details" {
                            self.io.state("remote_batch_item", &result)?;
                            continue;
                        }
                        if selected.remove(&item.id).is_some() {
                            continue;
                        }
                        match self
                            .configure_remote(
                                client,
                                job,
                                item,
                                &result,
                                &selected,
                                &mut project_catalog,
                            )
                            .await
                        {
                            Ok(choice) => {
                                selected.insert(item.id.clone(), choice);
                            }
                            Err(error) => self.io.notice(
                                &safe_error(&error),
                                "该项未选择。请查看原生问题并明确修正；不伪装为可迁入。",
                            )?,
                        }
                    } else {
                        self.io.notice(
                            "migration_transfer_invalid_selection",
                            "请选择当前页内的编号。",
                        )?;
                    }
                }
                _ => self.io.notice(
                    "migration_transfer_invalid_selection",
                    "请选择有效操作；没有发布目标内容。",
                )?,
            }
        }
    }
    async fn configure_remote(
        &self,
        client: &mut runtime::Client,
        job: &str,
        item: &kcoder_types::migration::MigrationItemPreview,
        page: &MigrationItemsResult,
        selected: &BTreeMap<String, MigrationBatchChoice>,
        project_catalog: &mut Option<String>,
    ) -> Result<MigrationBatchChoice> {
        ensure!(
            configurable::can_configure(
                item,
                page.providers.iter().any(|row| row.item_id == item.id)
            ),
            "migration_transfer_item_blocked"
        );
        self.io.state("remote_batch_item", item)?;
        if item.category == MigrationCategory::History {
            return Ok(MigrationBatchChoice::History {
                item_id: item.id.clone(),
            });
        }
        if item.category == MigrationCategory::Project {
            return self
                .project_choice(client, job, &item.id, project_catalog)
                .await;
        }
        let proposed = page
            .drafts
            .iter()
            .find(|draft| draft.item_id == item.id)
            .map(|draft| draft.target_name.as_str());
        let name = self.io.text(
            "target_name",
            "明确目标名称；冲突时改名，不覆盖既有结果。",
            proposed,
        )?;
        ensure!(
            !name.is_empty() && name.len() <= 256,
            "migration_transfer_invalid_target_name"
        );
        let item_id = item.id.clone();
        if let Some(provider) = page.providers.iter().find(|row| row.item_id == item.id) {
            let endpoint = nonempty(self.io.text(
                "endpoint",
                "目标连接地址；不要输入密钥。",
                provider.endpoint.as_deref(),
            )?);
            let model = nonempty(self.io.text(
                "model",
                "模型 ID；不要猜测未知配置。",
                provider.model.as_deref(),
            )?);
            return Ok(MigrationBatchChoice::Provider {
                item_id,
                target_name: name,
                endpoint,
                model,
                context_window_tokens: self.io.number(
                    "context_window_tokens",
                    "上下文窗口 tokens。",
                    provider.context_window_tokens,
                )?,
                output_headroom_tokens: self.io.number(
                    "output_headroom_tokens",
                    "预留输出 tokens。",
                    provider.output_headroom_tokens,
                )?,
                max_output_tokens: self.io.number(
                    "max_output_tokens",
                    "最大输出 tokens。",
                    provider.max_output_tokens,
                )?,
            });
        }
        if let Some(mcp) = page.mcps.iter().find(|row| row.item_id == item.id) {
            if !mcp.required_env.is_empty() || !mcp.required_headers.is_empty() {
                self.io.notice("migration_transfer_private_values_not_transferred","传输不包含来源私有值。原生会明确验证目标是否具备所需引用；不会填入占位密钥或假称已连接。")?;
            }
            return Ok(MigrationBatchChoice::Mcp {
                item_id,
                target_name: name,
                cwd: nonempty(self.io.text(
                    "mcp_cwd",
                    "MCP 在目标机器上的工作目录；仅保存定义，不执行来源命令。",
                    None,
                )?),
                enable_after_import: self.io.yes(
                    "enable_mcp",
                    "是否明确启用此 MCP？默认停用；启用不代表连接验证通过。",
                )?,
            });
        }
        if let Some(template) = page.templates.iter().find(|row| row.item_id == item.id) {
            let dependency = template
                .provider_item_id
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_template_provider_mapping_required"))?;
            ensure!(
                selected.contains_key(dependency),
                "migration_template_select_provider_first"
            );
            return Ok(MigrationBatchChoice::Template {
                item_id,
                target_name: name,
                provider_item_id: dependency.clone(),
            });
        }
        if item.category == MigrationCategory::Plugin {
            return Ok(MigrationBatchChoice::Plugin {
                item_id,
                target_name: name,
            });
        }
        ensure!(
            page.assets.iter().any(|asset| asset.item_id == item.id),
            "migration_transfer_item_unsupported"
        );
        if item.category == MigrationCategory::Memory {
            let mapping = match self.io.text("memory_mapping", "来源记忆是未验证笔记，迁入保持停用。明确选择 global 或 current_workspace，不按来源目录推断目标。", None)?.as_str() {
                "global" => kcoder_types::imported_memory::ImportedMemoryMapping::Global,
                "current_workspace" => kcoder_types::imported_memory::ImportedMemoryMapping::CurrentWorkspace,
                _ => anyhow::bail!("migration_memory_scope_required"),
            };
            return Ok(MigrationBatchChoice::Asset {
                agent_adaptation: None,
                item_id,
                target_name: name,
                enable_after_import: false,
                memory_mapping: Some(mapping),
            });
        }
        if matches!(
            item.category,
            MigrationCategory::Instructions | MigrationCategory::Agent | MigrationCategory::Hook
        ) {
            let agent_adaptation = if item.category == MigrationCategory::Agent {
                self.agent_adaptation(client, job, &item_id).await?
            } else {
                None
            };
            return Ok(MigrationBatchChoice::Asset {
                agent_adaptation,
                item_id,
                target_name: name,
                enable_after_import: false,
                memory_mapping: None,
            });
        }
        Ok(MigrationBatchChoice::Asset {
            agent_adaptation: None,
            item_id,
            target_name: name,
            enable_after_import: self.io.yes(
                "enable_asset",
                "是否明确启用该兼容资产？默认停用，不执行来源脚本。",
            )?,
            memory_mapping: None,
        })
    }
}
fn nonempty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}
