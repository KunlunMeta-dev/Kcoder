//! Spec lifecycle tools adapter behavior; domain operations remain in kcoder_specs.

use super::*;

#[async_trait]
impl Tool for SpecInitTool {
    fn name(&self) -> String {
        "SpecInit".to_string()
    }

    fn description(&self) -> String {
        "Initialize the spec-driven development subsystem for this project. \
         Creates .kcoder/specs, a starter spec, and auto-triggered using-specs/Superpowers skills."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecInitInput))
    }

    fn is_destructive(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecInitInput = parse_input(&input)?;
        let cwd = ctx.state.cwd();
        let worker_cwd = cwd.clone();
        let force_update = input.force_update;
        let initialized = tokio::task::spawn_blocking(move || {
            let (path, receipts) = kcoder_specs::init_with_force_report(&worker_cwd, force_update)
                .map_err(|error| ToolError::Execution(format!("failed to init specs: {error}")))?;
            let bundled = crate::bundled_skills::sync_bundled(
                &project_skills_root(&worker_cwd),
                false,
                force_update,
            )?;
            Ok::<_, ToolError>((path, receipts, bundled))
        })
        .await
        .map_err(|error| ToolError::Execution(format!("spec init worker failed: {error}")))?;

        match initialized {
            Ok((path, receipts, bundled)) => {
                let transaction_id = bundled.transaction_id.clone().or_else(|| {
                    receipts
                        .last()
                        .map(|receipt| receipt.transaction_id.clone())
                });
                let mut text = format!("Initialized spec subsystem at {}", path.display());
                if input.force_update {
                    text.push_str(" (skills updated)");
                }
                match reload_skill_registry(ctx) {
                    Ok(true) => {
                        text.push_str("; skill registry reloaded");
                        record_spec_reload_status(
                            &project_skills_root(&ctx.state.cwd()),
                            transaction_id.as_deref(),
                            true,
                        );
                    }
                    Ok(false) => {}
                    Err(error) => {
                        text.push_str(&format!(
                            "; committed_reload_pending ({error}); only retry registry reload"
                        ));
                        record_spec_reload_status(
                            &project_skills_root(&ctx.state.cwd()),
                            transaction_id.as_deref(),
                            false,
                        );
                    }
                }
                if activate_using_specs_skill(ctx) {
                    text.push_str("; using-specs activated");
                }
                if activate_superpowers_root_skill(ctx) {
                    text.push_str("; using-superpowers activated");
                }
                Ok(ToolOutput::text(text))
            }
            Err(error) => Err(error),
        }
    }
}

#[async_trait]
impl Tool for SpecUpdateTool {
    fn name(&self) -> String {
        "SpecUpdate".to_string()
    }

    fn description(&self) -> String {
        "Update the project's spec workflow skills. Runs bundled Superpowers skill sync, \
         regenerates the auto-triggered using-specs skill from .kcoder/specs/config.yaml, \
         records bundled provenance, and reloads the live skill registry."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecUpdateInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecUpdateInput = parse_input(&input)?;
        let cwd = ctx.state.cwd();
        let root = project_skills_root(&cwd);
        let using_specs_content = rendered_using_specs_content(&cwd);
        let using_specs_plan =
            plan_using_specs_update(&cwd, &using_specs_content, input.force_update);
        let worker_root = root.clone();
        let dry_run = input.dry_run;
        let force_update = input.force_update;
        let bundled = tokio::task::spawn_blocking(move || {
            crate::bundled_skills::sync_bundled(&worker_root, dry_run, force_update)
        })
        .await
        .map_err(|error| ToolError::Execution(format!("bundled sync worker failed: {error}")))??;

        let mut actions = vec![using_specs_plan.action.clone()];
        if !input.dry_run {
            let transaction_id;
            if using_specs_plan.conflict {
                let worker_ctx = ctx.clone();
                let worker_root = root.clone();
                let new_file = using_specs_plan.new_file.clone();
                let content = using_specs_content.clone();
                let receipt = tokio::task::spawn_blocking(move || {
                    write_using_specs_conflict(&worker_ctx, &worker_root, &new_file, &content)
                })
                .await
                .map_err(|error| {
                    ToolError::Execution(format!("spec conflict worker failed: {error}"))
                })??;
                transaction_id = Some(receipt.transaction_id);
            } else {
                let worker_cwd = cwd.clone();
                let (_, receipt) = tokio::task::spawn_blocking(move || {
                    kcoder_specs::sync_using_specs_skill_report(&worker_cwd)
                })
                .await
                .map_err(|error| {
                    ToolError::Execution(format!("using-specs worker failed: {error}"))
                })?
                .map_err(|e| {
                    ToolError::Execution(format!("failed to regenerate using-specs skill: {e}"))
                })?;
                transaction_id = Some(receipt.transaction_id);
            }
            match reload_skill_registry(ctx) {
                Ok(_) => {
                    activate_using_specs_skill(ctx);
                    activate_superpowers_root_skill(ctx);
                    actions.push("skill registry reloaded".to_string());
                    record_spec_reload_status(&root, transaction_id.as_deref(), true);
                }
                Err(error) => {
                    actions.push(format!(
                        "committed_reload_pending: {error}; only retry registry reload"
                    ));
                    record_spec_reload_status(&root, transaction_id.as_deref(), false);
                }
            }
        }

        let output = serde_json::json!({
            "success": true,
            "dry_run": input.dry_run,
            "force_update": input.force_update,
            "bundled": bundled,
            "actions": actions,
        });
        serde_json::to_string_pretty(&output)
            .map(ToolOutput::text)
            .map_err(|e| ToolError::Execution(format!("failed to serialize spec update: {e}")))
    }
}

#[async_trait]
impl Tool for SpecNewChangeTool {
    fn name(&self) -> String {
        "SpecNewChange".to_string()
    }

    fn description(&self) -> String {
        "Create a new spec-driven change scaffold under .kcoder/specs/changes/. \
         Creates proposal.md, design.md, tasks.md, schema-specific artifacts such as \
         review.md/plan.md, and a starter delta spec at specs/<capability>/spec.md. \
         Requires the `using-superpowers` and `using-specs` skills to be active \
         first; activate them via the `skill` tool if this fails with a \
         workflow-locked error."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecNewChangeInput))
    }

    fn is_destructive(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecNewChangeInput = parse_input(&input)?;
        require_using_specs_skill(ctx)?;

        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }

        match kcoder_specs::new_change(&ctx.state.cwd(), &input.name, input.title) {
            Ok(path) => Ok(ToolOutput::text(format!(
                "Created change at {}",
                path.display()
            ))),
            Err(e) => Err(ToolError::Execution(format!(
                "failed to create change: {}",
                e
            ))),
        }
    }
}

#[async_trait]
impl Tool for SpecArchiveTool {
    fn name(&self) -> String {
        "SpecArchive".to_string()
    }

    fn description(&self) -> String {
        "Archive a completed spec-driven change. Before merging, it automatically \
         rejects incomplete tasks and schema readiness blockers, syncs unchanged \
         deltas, runs the project precheck configured in .kcoder/specs/config.yaml, \
         and checks for unresolved spec conflicts or drift. \
         On success the change is moved to .kcoder/specs/changes/archive/."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecArchiveInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecArchiveInput = parse_input(&input)?;
        require_using_specs_skill(ctx)?;
        let worker_ctx = ctx.clone();
        let change_name = input.name;
        tokio::task::spawn_blocking(move || {
            match kcoder_specs::archive_with_outcome(&worker_ctx.state.cwd(), &change_name) {
                Ok(outcome) => {
                    let path = outcome.archive_dir;
                    let mut message = format!("Archived change to {}", path.display());
                    if outcome.recovery_pending {
                        message.push_str("; committed_publication_recovery_pending: retain the archive journal and retry SpecArchive for this change; do not reapply its delta");
                        return Ok(ToolOutput::text(message));
                    }
                    let lessons = match maybe_generate_lessons_learned_skill(&worker_ctx, &change_name, &path) {
                        Ok(value) => value,
                        Err(error) => { message.push_str(&format!("; committed_lessons_pending: {error}")); None }
                    };
                    if let Some(lessons) = lessons {
                        message.push_str(&format!(
                            "; generated lessons-learned skill at {}",
                            lessons.display()
                        ));
                    }
                    Ok(ToolOutput::text(message))
                }
                Err(e) => Err(ToolError::Execution(format!(
                    "failed to archive change: {}",
                    e
                ))),
            }
        })
        .await
        .map_err(|error| ToolError::Execution(format!("spec archive worker failed: {error}")))?
    }
}

#[async_trait]
impl Tool for SpecSyncTool {
    fn name(&self) -> String {
        "SpecSync".to_string()
    }

    fn description(&self) -> String {
        "Rebase a spec-driven change against the current authoritative specs. \
         Fast-forwards unchanged deltas or reports conflicting edits without writing deltas or the base snapshot. \
         Returns a publication receipt: committed with recovery_pending requires retrying SpecSync for the same change to finish publication."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecSyncInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecSyncInput = parse_input(&input)?;
        require_using_specs_skill(ctx)?;

        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }

        match kcoder_specs::sync(&ctx.state.cwd(), &input.name) {
            Ok(report) => {
                let mut text = String::new();
                if report
                    .publication
                    .is_some_and(|receipt| receipt.recovery_pending)
                {
                    text.push_str("SpecSync committed; publication recovery is pending. Retry SpecSync for this change to finish publication.\n");
                } else if report.base_updated {
                    text.push_str("Base snapshot updated.\n");
                } else {
                    text.push_str("Base snapshot NOT updated due to unresolved conflicts.\n");
                }
                if !report.fast_forwards.is_empty() {
                    text.push_str("\nFast-forwarded:\n");
                    for r in &report.fast_forwards {
                        let _ = writeln!(text, "- specs/{}: {}", r.domain, r.name);
                    }
                }
                if !report.conflicts.is_empty() {
                    text.push_str("\nConflicts (resolve manually and re-run sync):\n");
                    for r in &report.conflicts {
                        let _ = writeln!(text, "- specs/{}: {}", r.domain, r.name);
                    }
                }
                if report.fast_forwards.is_empty() && report.conflicts.is_empty() {
                    text.push_str("No drift detected.");
                }
                Ok(ToolOutput::text(
                    serde_json::json!({
                        "change_name":input.name,
                        "publication":report.publication.unwrap_or_default(),
                        "base_updated":report.base_updated,
                        "fast_forwards":report.fast_forwards,
                        "conflicts":report.conflicts,
                        "summary":text,
                    })
                    .to_string(),
                ))
            }
            Err(e) => Err(ToolError::Execution(format!(
                "failed to sync change: {}",
                e
            ))),
        }
    }
}
