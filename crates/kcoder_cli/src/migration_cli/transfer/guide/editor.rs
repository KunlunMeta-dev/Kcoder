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
                "Select a Native batch number from the current adoption receipt; quit returns.",
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
                "Select an available batch number from the receipt.",
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
                "Release of this connection is not confirmed; rely on the original batch receipt.",
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
            let answer=self.io.ask("transfer_batch_menu","read refreshes; projects shows original project provenance/target mappings; instructions reads original batch instructions/compiled text; resources shows budgets and original increase receipts; resources-increase explicitly increases limits; private selects private bundles from saved plans and checks original state; select selects items and previews; apply confirms submission; reconcile checks the original attempt; resume explicitly resumes; undo undoes; cancel cancels; back returns.",json!({"jobId":job,"workerRunning":state.worker_running,"unconfirmed":state.state.job.has_unconfirmed_outcomes}),None)?;
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
                        "Cancel the original batch? Confirmed submissions are not treated as if they never happened; undo is a separate operation.",
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
                    "Choose a currently available operation; active work is not started twice.",
                ),
            };
            if let Err(error) = result {
                self.io.notice(
                    &safe_error(&error),
                    "Batch completion was not confirmed. Read the original record first; no automatic resend or request identity change.",
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
        ensure!(self.io.ask("transfer_batch_confirm",&format!("After reviewing the Native preview and issues above, enter {required} to confirm this operation. Other targets are not modified and source programs are not run."),serde_json::Value::Null,None)?==required,"migration_transfer_confirmation_required");
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
            let answer=self.io.ask("transfer_batch_selection","toggle N selects/deselects and configures; details N shows public candidates; next/prev changes pages; preview generates the saved preview; quit returns. Nothing is selected by default.",json!({"page":page,"selected":selected.len(),"items":rows}),None)?;
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
                            "Reuse confirmed old results whose targets were not edited? New secrets are not added.",
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
                                "This item was not selected. Review Native issues and explicitly correct them; it is not presented as importable.",
                            )?,
                        }
                    } else {
                        self.io.notice(
                            "migration_transfer_invalid_selection",
                            "Select a number on this page.",
                        )?;
                    }
                }
                _ => self.io.notice(
                    "migration_transfer_invalid_selection",
                    "Choose a valid operation; target content was not published.",
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
            "Explicit target name; rename on conflict, without overwriting existing results.",
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
                "Target endpoint; do not enter credentials.",
                provider.endpoint.as_deref(),
            )?);
            let model = nonempty(self.io.text(
                "model",
                "Model ID; do not guess unknown configuration.",
                provider.model.as_deref(),
            )?);
            return Ok(MigrationBatchChoice::Provider {
                item_id,
                target_name: name,
                endpoint,
                model,
                context_window_tokens: self.io.number(
                    "context_window_tokens",
                    "Context window tokens.",
                    provider.context_window_tokens,
                )?,
                output_headroom_tokens: self.io.number(
                    "output_headroom_tokens",
                    "Output headroom tokens.",
                    provider.output_headroom_tokens,
                )?,
                max_output_tokens: self.io.number(
                    "max_output_tokens",
                    "Maximum output tokens.",
                    provider.max_output_tokens,
                )?,
            });
        }
        if let Some(mcp) = page.mcps.iter().find(|row| row.item_id == item.id) {
            if !mcp.required_env.is_empty() || !mcp.required_headers.is_empty() {
                self.io.notice("migration_transfer_private_values_not_transferred","Transfer does not include source private values. Native explicitly validates required target references; no placeholder credentials or false connection claims.")?;
            }
            return Ok(MigrationBatchChoice::Mcp {
                item_id,
                target_name: name,
                cwd: nonempty(self.io.text(
                    "mcp_cwd",
                    "MCP working directory on the target machine; only saves the definition, without running source commands.",
                    None,
                )?),
                enable_after_import: self.io.yes(
                    "enable_mcp",
                    "Explicitly enable this MCP? Disabled by default; enabling does not mean connection validation passed.",
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
            let mapping = match self.io.text("memory_mapping", "Source memory is unverified notes and remains disabled after import. Explicitly choose global or current_workspace; the target is not inferred from source directories.", None)?.as_str() {
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
                "Explicitly enable this compatible asset? Disabled by default; source scripts are not executed.",
            )?,
            memory_mapping: None,
        })
    }
}
fn nonempty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}
