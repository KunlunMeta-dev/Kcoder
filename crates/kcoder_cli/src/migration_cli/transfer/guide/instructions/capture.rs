use super::*;

impl Guide {
    pub(in crate::migration_cli::transfer::guide) async fn choose_instructions(
        &mut self,
    ) -> Result<()> {
        ensure!(
            !self.draft.copy_prepared,
            "migration_transfer_selection_frozen_read_original"
        );
        let session = self.session(MigrationSourceSessionPurpose::Source).await?;
        if self.draft.instruction_capture.is_none() {
            let root = self.io.text(
                "transfer_instruction_root",
                "来源主机上明确授权的受信任指令根绝对路径；产品目录授权不能代替此授权。",
                None,
            )?;
            let cwd = self.io.text(
                "transfer_instruction_cwd",
                "来源主机上该根内的实际工作目录绝对路径；须与所选来源连接工作目录一致。",
                self.draft.source.workspace_path.as_deref(),
            )?;
            let descendants = self.io.yes(
                "transfer_instruction_descendants",
                "是否还扫描此授权根内的后代指令目录？不读取根外祖先、不复制工作树。",
            )?;
            ensure!(self.io.yes("transfer_instruction_static", "确认只捕获可检查的静态指令子集？不继承来源权限/系统身份，不执行来源程序；未知动态或不完整链只能明确保留待处理。")?, "migration_instruction_static_subset_confirmation_required");
            let params: MigrationInstructionCaptureParams = serde_json::from_value(json!({
                "captureId":uuid::Uuid::new_v4().to_string(),"source":self.draft.source_kind,
                "format":"static_v2","sourceRoot":root,"sourceCwd":cwd,
                "includeDescendants":descendants,"confirmStaticSubset":true,
            }))
            .map_err(|_| anyhow::anyhow!("migration_instruction_invalid_directories"))?;
            self.draft.instruction_capture = Some(Capture {
                session_id: session.session_id.clone(),
                params,
                dispatched: false,
            });
            self.save()?;
        }
        let capture = self.draft.instruction_capture.as_ref().unwrap().clone();
        ensure!(
            capture.session_id == session.session_id,
            "migration_transfer_source_reselection_required"
        );
        if !capture.dispatched {
            self.draft.instruction_capture.as_mut().unwrap().dispatched = true;
            self.save()?;
            // A possibly accepted capture is never repeated. Reopening observes the same ID.
            let result: MigrationInstructionCaptureResult = self
                .source_query(&session, "instructions_capture", &capture.params)
                .await?;
            super::super::super::instructions::capture(&result, &capture.params)?;
            self.io.state("instruction_capture", &result)?;
        } else {
            self.io.notice("migration_instruction_observe_original", "只读取原captureId核对已捕获快照；不重新捕获、更换解释或扫描新来源。原连接失效时须明确source-reset重新授权。")?;
        }
        self.preview_source_instructions(&session, &capture.params.capture_id)
            .await?;
        if self.io.yes(
            "transfer_instruction_select",
            "是否将这份已查看的静态指令快照纳入原传输？接收后还需逐项目标目录映射，迁入默认停用。",
        )? {
            let selection = MigrationSourceSelectionV1::Instructions {
                capture_id: capture.params.capture_id.clone(),
            };
            if !self.draft.selections.contains(&selection) {
                ensure!(
                    self.draft.selections.len() < 64,
                    "migration_transfer_selection_budget_exceeded"
                );
                self.draft.selections.push(selection);
                self.save()?;
            }
        }
        self.io.state(
            "transfer_selection",
            &json!({"selected":self.draft.selections.len(),"requestId":self.draft.request_id}),
        )
    }
}
