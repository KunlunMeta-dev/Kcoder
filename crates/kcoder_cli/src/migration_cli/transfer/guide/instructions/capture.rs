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
                "Absolute path of an explicitly authorized, trusted instruction root on the source host. Product directory authorization does not replace this authorization.",
                None,
            )?;
            let cwd = self.io.text(
                "transfer_instruction_cwd",
                "Absolute path of the actual working directory inside that source-host root; it must match the selected source connection working directory.",
                self.draft.source.workspace_path.as_deref(),
            )?;
            let descendants = self.io.yes(
                "transfer_instruction_descendants",
                "Also scan descendant instruction directories inside this authorized root? Ancestors outside the root are not read and worktrees are not copied.",
            )?;
            ensure!(self.io.yes("transfer_instruction_static", "Capture only the inspectable static instruction subset? Source permissions/system identity are not inherited and source programs are not executed. Unknown dynamic semantics or incomplete chains can only be explicitly retained as pending.")?, "migration_instruction_static_subset_confirmation_required");
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
            self.io.notice("migration_instruction_observe_original", "Read only the original captureId to check captured snapshots. No recapture, interpretation changes or new-source scanning. An expired original connection requires explicit source-reset and reauthorization.")?;
        }
        self.preview_source_instructions(&session, &capture.params.capture_id)
            .await?;
        if self.io.yes(
            "transfer_instruction_select",
            "Include this reviewed static instruction snapshot in the original transfer? After receipt, each item still needs target directory mapping. Imports are disabled by default.",
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
