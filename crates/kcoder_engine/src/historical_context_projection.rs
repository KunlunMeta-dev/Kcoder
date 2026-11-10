//! Current-model admission and owned attachment delivery, without provider calls or source execution.
use super::*;
use anyhow::ensure;
use kcoder_config::PrivateDirectory;
use kcoder_state::historical_contexts::{ContextPreparationProgress, PreparedContextReader};
use kcoder_types::historical_context::*;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
mod message;
#[cfg(test)]
mod tests;
pub const MAX_PROJECTED_HISTORY_BYTES: u64 = 16 * 1024 * 1024 - 4096;

pub struct HistoricalModelProjection {
    report: HistoricalModelProjectionReport,
    binding: HistoricalSessionSeedBinding,
    message: Message,
    assets: PreparedContextReader,
}
impl HistoricalModelProjection {
    pub fn report(&self) -> &HistoricalModelProjectionReport {
        &self.report
    }
    pub fn binding(&self) -> &HistoricalSessionSeedBinding {
        &self.binding
    }
}
pub enum HistoricalModelProjectionOutcome {
    Blocked(HistoricalModelProjectionReport),
    Ready(Box<HistoricalModelProjection>),
}
fn hash(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn issue(report: &mut HistoricalModelProjectionReport, code: &str) {
    report.issues.push(HistoricalContextIssue {
        code: code.into(),
        position: None,
        block_index: None,
    })
}
fn fresh(engine: &QueryEngine) -> Result<()> {
    ensure!(
        engine.agent_depth() == 0
            && engine.state.message_count() == 0
            && engine.state.goal().is_none()
            && engine.state.tasks().is_empty()
            && engine.state.session_mode() == kcoder_state::SessionMode::Default,
        "historical_projection_requires_new_session"
    );
    ensure!(
        engine.client_storage_owner.is_none(),
        "historical_projection_requires_durable_storage"
    );
    Ok(())
}
fn private_child(parent: &PrivateDirectory, name: &OsStr) -> Result<PrivateDirectory> {
    let child = match parent.open_child(name, false) {
        Ok(child) => child,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            parent.create_private_child(name)?
        }
        Err(error) => return Err(error),
    };
    child.verify_private_directory()?;
    Ok(child)
}
impl QueryEngine {
    fn historical_model_fingerprint(&self) -> Result<String> {
        let settings = recover_read_lock(&self.settings, "settings").clone();
        let summary = crate::model_configuration_summary(
            &settings,
            kcoder_types::ModelConfigurationBoundary::SessionSnapshot,
        )?;
        hash(&(
            summary,
            &settings.permission_mode,
            &settings.permission_rules,
            &settings.allowed_tools,
            &settings.denied_tools,
            self.active_tool_registry().names(),
            self.effective_studio_work_mode(),
            self.state.cwd(),
        ))
    }
    /// The host owns the idle execution gate. No request is sent and no source tool is called.
    pub async fn prepare_historical_context(
        &self,
        operation_id: &str,
        source: &PreparedContextReader,
        mut check: impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<HistoricalModelProjectionOutcome> {
        fresh(self)?;
        ensure!(
            uuid::Uuid::parse_str(operation_id).is_ok(),
            "historical_projection_invalid_operation"
        );
        ensure!(
            check(ContextPreparationProgress {
                attachment_index: None,
                processed_bytes: 0
            }),
            "historical_projection_cancelled"
        );
        let fingerprint = self.historical_model_fingerprint()?;
        let settings = recover_read_lock(&self.settings, "settings").clone();
        let document = &source.context().document;
        let mut report = HistoricalModelProjectionReport {
            projection_ready: false,
            estimated_input_tokens: None,
            input_limit_tokens: None,
            images: 0,
            files: 0,
            issues: Vec::new(),
        };
        if !historical_context_revision_supported(&document.revision) {
            issue(&mut report, "historical_projection_unsupported_revision")
        }
        if !settings.model_capabilities.text {
            issue(&mut report, "historical_projection_text_unavailable")
        }
        if settings.api_format.is_none() {
            issue(&mut report, "historical_projection_protocol_unknown")
        }
        if settings
            .context_window_tokens
            .is_none_or(|value| value == 0)
            || settings.context_output_headroom.is_none()
        {
            issue(&mut report, "historical_projection_context_limit_unknown")
        }
        for attachment in &document.attachments {
            if attachment
                .media_type
                .as_deref()
                .is_some_and(|mime| mime.to_ascii_lowercase().starts_with("image/"))
            {
                report.images += 1
            } else {
                report.files += 1
            }
        }
        if report.images > 0 && !settings.model_capabilities.vision {
            issue(&mut report, "historical_projection_vision_unavailable")
        }
        let tools = self.active_tool_registry().names();
        if report.files > 0
            && (!settings.model_capabilities.tools
                || !tools
                    .iter()
                    .any(|name| matches!(name.as_str(), "read" | "bash" | "PowerShell")))
        {
            issue(&mut report, "historical_projection_file_access_unavailable")
        }
        if !report.issues.is_empty() {
            return Ok(HistoricalModelProjectionOutcome::Blocked(report));
        }
        // Validate native image decoding before copying any files into the target session.
        let images = message::images(source, &mut report, &mut check)?;
        if !report.issues.is_empty() {
            return Ok(HistoricalModelProjectionOutcome::Blocked(report));
        }
        let definitions = self.tool_definitions_for_model().await;
        let available = definitions
            .iter()
            .map(|definition| definition.name.clone())
            .collect::<HashSet<_>>();
        let mut system = crate::prompt_runtime::build_system_prompt_for_work_mode(
            &self.cwd,
            &settings.model,
            false,
            self.is_luna_mode_active(),
            self.permission_mode_suppresses_user_elicitation(),
            &available,
            self.effective_studio_work_mode(),
        );
        system.push_str(&self.skill_catalog_prompt(&available));
        let budget = crate::context::ContextBudget::from_settings(&settings);
        report.input_limit_tokens = Some(budget.hard_input_limit() as u64);
        // The first pass uses deterministic target-local paths, but creates no target files.
        let target = self
            .session_storage_dir_for(&self.session_id())
            .join("attachments");
        let paths = (0..document.attachments.len())
            .map(|index| {
                Ok(target
                    .join("historical-contexts")
                    .join(&source.context().receipt.preparation_id)
                    .join(source.delivery_filename(index as u32)?))
            })
            .collect::<Result<Vec<_>>>()?;
        let Some(mut message) = message::build(document, &paths, &images, &mut report)? else {
            return Ok(HistoricalModelProjectionOutcome::Blocked(report));
        };
        let mut request = MessagesRequest::new(settings.model.clone(), vec![message.clone()]);
        request.system = Some(system);
        request.tools = definitions;
        self.prepend_project_user_context(&mut request.messages)?;
        let estimate = crate::context::TokenCounter::count_request(&request, true).tokens;
        report.estimated_input_tokens = Some(estimate as u64);
        if estimate >= budget.hard_input_limit() {
            issue(&mut report, "historical_projection_context_budget_exceeded");
            return Ok(HistoricalModelProjectionOutcome::Blocked(report));
        }
        ensure!(
            fingerprint == self.historical_model_fingerprint()?,
            "historical_projection_model_changed"
        );
        fresh(self)?;
        let root = PrivateDirectory::open_or_create(&self.session_storage_root)?;
        root.verify_trusted_config_directory()?;
        let session = private_child(
            &root,
            OsStr::new(&kcoder_state::artifact_id_path_component(
                &self.session_id(),
            )),
        )?;
        let owner = private_child(&session, OsStr::new("attachments"))?;
        let copied = source.copy_to_bound(&target, &owner, &mut check)?;
        let actual = (0..document.attachments.len())
            .map(|index| copied.attachment_path(index as u32))
            .collect::<Result<Vec<_>>>()?;
        if actual != paths {
            // Canonical target spelling may differ (for example Windows verbatim paths).
            let Some(actual_message) = message::build(document, &actual, &images, &mut report)?
            else {
                return Ok(HistoricalModelProjectionOutcome::Blocked(report));
            };
            message = actual_message;
            request.messages = vec![message.clone()].into();
            self.prepend_project_user_context(&mut request.messages)?;
            let estimate = crate::context::TokenCounter::count_request(&request, true).tokens;
            report.estimated_input_tokens = Some(estimate as u64);
            if estimate >= budget.hard_input_limit() {
                issue(&mut report, "historical_projection_context_budget_exceeded");
                return Ok(HistoricalModelProjectionOutcome::Blocked(report));
            }
        }
        ensure!(
            fingerprint == self.historical_model_fingerprint()?,
            "historical_projection_model_changed"
        );
        fresh(self)?;
        report.projection_ready = true;
        let binding = HistoricalSessionSeedBinding {
            operation_id: operation_id.into(),
            session_id: self.session_id(),
            source_job_id: document.source_job_id.clone(),
            view_id: document.view_id.clone(),
            preparation: source.context().receipt.clone(),
            model_snapshot_sha256: fingerprint,
            projection_sha256: hash(&message)?,
        };
        Ok(HistoricalModelProjectionOutcome::Ready(Box::new(
            HistoricalModelProjection {
                report,
                binding,
                message,
                assets: copied,
            },
        )))
    }
    /// The same gate remains held from admission through publication; current settings are rechecked.
    pub fn publish_prepared_historical_context(
        &self,
        projection: HistoricalModelProjection,
        check: impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<HistoricalSessionSeedReceipt> {
        ensure!(
            projection.binding.session_id == self.session_id()
                && projection.binding.model_snapshot_sha256
                    == self.historical_model_fingerprint()?,
            "historical_projection_model_changed"
        );
        projection.assets.verify_current(check)?;
        for (index, _) in projection
            .assets
            .context()
            .document
            .attachments
            .iter()
            .enumerate()
        {
            projection.assets.attachment_path(index as u32)?;
        }
        ensure!(
            projection.binding.model_snapshot_sha256 == self.historical_model_fingerprint()?,
            "historical_projection_model_changed"
        );
        self.state
            .publish_historical_seed(projection.binding, projection.message)
    }
}
