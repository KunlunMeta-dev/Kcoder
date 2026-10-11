//! Version-bound evidence; public summaries contain fingerprints and opaque private references.
use super::*;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn definition_fingerprint(definition: &WorkflowDefinition) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(definition)?)
    ))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolContractVerification {
    pub known_nodes: Vec<String>,
    pub unknown_nodes: Vec<String>,
    pub runtime_bound_nodes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticVerification {
    pub saved_version: u64,
    pub definition_sha256: String,
    pub checked_at_ms: u64,
    pub checked_nodes: Vec<String>,
    pub checks: Vec<String>,
    pub tool_contracts: String,
    #[serde(default)]
    pub tool_contract_details: Option<ToolContractVerification>,
}
impl StaticVerification {
    pub(super) fn with_tool_contracts(
        mut self,
        definition: &WorkflowDefinition,
        checks: ToolContractVerification,
    ) -> Result<Self> {
        let nodes: std::collections::BTreeSet<_> = definition
            .nodes
            .iter()
            .filter(|node| node.config.tool.is_some())
            .map(|node| node.id.clone())
            .collect();
        let checked: std::collections::BTreeSet<_> = checks
            .known_nodes
            .iter()
            .chain(&checks.unknown_nodes)
            .cloned()
            .collect();
        ensure!(
            nodes == checked
                && checked.len() == checks.known_nodes.len() + checks.unknown_nodes.len()
                && checks
                    .runtime_bound_nodes
                    .iter()
                    .all(|id| checks.known_nodes.contains(id)),
            "workflow_invalid: tool contract coverage does not match definition"
        );
        self.tool_contracts = if !checks.unknown_nodes.is_empty() {
            "partially_checked"
        } else if nodes.is_empty() {
            "not_applicable"
        } else {
            "known_arguments_checked"
        }
        .into();
        self.tool_contract_details = Some(checks);
        Ok(self)
    }
    pub(super) fn checked(definition: &WorkflowDefinition) -> Result<Self> {
        crate::graph::validate(definition, true)?;
        Ok(Self {
            saved_version: definition.saved_version.context("workflow_unsaved")?,
            definition_sha256: definition_fingerprint(definition)?,
            checked_at_ms: now_ms()?,
            checked_nodes: definition
                .nodes
                .iter()
                .map(|node| node.id.clone())
                .collect(),
            checks: vec![
                "dependency_graph",
                "schema_defaults",
                "declared_pointers",
                "pure_code_syntax",
                "node_contracts",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            tool_contract_details: None,
            tool_contracts: if definition
                .nodes
                .iter()
                .any(|node| node.config.tool.is_some())
            {
                "not_checked"
            } else {
                "not_applicable"
            }
            .into(),
        })
    }
}

/// An explicitly requested finite case; required nodes must have real result checks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowScenarioRequest {
    pub id: String,
    pub required_check_nodes: Vec<String>,
    pub expected_skipped_nodes: Option<Vec<String>>,
}
impl WorkflowScenarioRequest {
    pub fn validate(&self, definition: &WorkflowDefinition) -> Result<()> {
        crate::graph::validate_id(&self.id)?;
        let required: std::collections::BTreeSet<_> = self.required_check_nodes.iter().collect();
        ensure!(
            !required.is_empty()
                && required.len() == self.required_check_nodes.len()
                && required.len() <= crate::graph::MAX_NODES
                && required.iter().all(|id| definition
                    .nodes
                    .iter()
                    .any(|node| &node.id == *id && node.config.result_check.is_some())),
            "workflow_invalid: scenario requires unique declared result-check nodes"
        );
        if let Some(skipped) = &self.expected_skipped_nodes {
            let unique: std::collections::BTreeSet<_> = skipped.iter().collect();
            ensure!(
                unique.len() == skipped.len()
                    && unique.len() <= crate::graph::MAX_NODES
                    && unique.iter().all(|id| !required.contains(id)
                        && definition.nodes.iter().any(|node| &node.id == *id)),
                "workflow_invalid: scenario skipped nodes must be unique known nodes disjoint from required checks"
            );
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowScenarioVerification {
    pub request: WorkflowScenarioRequest,
    pub status: String,
    pub scope: String,
}
impl WorkflowScenarioVerification {
    pub fn outcome(&self, evidence: &RuntimeVerification) -> &'static str {
        match evidence.execution_status.as_str() {
            "running" => "pending",
            "completed"
                if evidence.check_status == "passed"
                    && self
                        .request
                        .required_check_nodes
                        .iter()
                        .all(|id| evidence.checked_nodes.contains(id))
                    && self
                        .request
                        .expected_skipped_nodes
                        .as_ref()
                        .is_none_or(|expected| {
                            let expected: std::collections::BTreeSet<_> = expected.iter().collect();
                            let actual: std::collections::BTreeSet<_> =
                                evidence.skipped_nodes.iter().collect();
                            expected == actual
                        }) =>
            {
                "passed"
            }
            "completed" => "failed",
            "failed" if evidence.check_status == "failed" => "failed",
            _ => "incomplete",
        }
    }
}

fn unknown_outcome() -> String {
    "unknown".into()
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeVerification {
    pub definition_id: String,
    pub saved_version: u64,
    pub definition_sha256: String,
    pub run_id: String,
    pub resume_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_attempt: Option<u32>,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub execution_status: String,
    #[serde(default = "unknown_outcome")]
    pub outcome_certainty: String,
    pub check_status: String,
    pub scope: String,
    pub checked_nodes: Vec<String>,
    #[serde(default)]
    pub configured_nodes: Vec<String>,
    pub skipped_nodes: Vec<String>,
    pub input_sha256: String,
    pub private_input_ref: String,
    pub output_sha256: Option<String>,
    pub private_output_ref: Option<String>,
    /// Only an allowlisted model/provider/effort snapshot, never full settings.
    pub model_snapshot: Value,
    pub safety_sha256: Option<String>,
    #[serde(default)]
    pub interaction_modified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario: Option<WorkflowScenarioVerification>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionVerification {
    pub definition_id: String,
    pub saved_version: u64,
    pub draft_status: String,
    pub availability: String,
    pub static_check: Option<StaticVerification>,
    pub runs: Vec<RuntimeVerification>,
    pub total_run_count: usize,
    pub next_offset: Option<usize>,
}

impl WorkflowStore {
    pub fn verification(&self, id: &str, version: u64) -> Result<VersionVerification> {
        self.verification_page(id, version, 0, 32)
    }
    pub fn verification_page(
        &self,
        id: &str,
        version: u64,
        offset: usize,
        limit: usize,
    ) -> Result<VersionVerification> {
        ensure!(
            (1..=32).contains(&limit),
            "workflow_invalid: evidence page limit must be 1–32"
        );
        crate::graph::validate_id(id)?;
        let library = self.read_library()?;
        let record = library.records.get(id);
        let historical = match self.historical_version(id, version) {
            Ok(value) => Some(value),
            Err(error)
                if error.to_string().contains("still published")
                    || error.to_string().contains("workflow_not_found") =>
            {
                None
            }
            Err(error) => return Err(error),
        };
        let definition = record
            .and_then(|record| record.versions.get(&version))
            .or_else(|| historical.as_ref().map(|value| &value.definition))
            .context("workflow_not_found: saved version")?;
        let availability = if historical.is_some() {
            "archived_history"
        } else {
            "saved"
        };
        let hash = definition_fingerprint(definition)?;
        let mut runs = Vec::new();
        let root = self.open(false)?.context("workflow_not_found: library")?;
        let directory = match root.open_child(OsStr::new("verification"), false) {
            Ok(directory) => Some(directory),
            Err(error) if not_found(&error) => None,
            Err(error) => return Err(error),
        };
        if let Some(directory) = directory {
            let _lease = library_lease(&directory, false)?;
            for (_, file) in
                directory.open_regular_files(|leaf| leaf.to_string_lossy().ends_with(".json"))?
            {
                ensure!(
                    file.metadata()?.len() <= 64 * 1024,
                    "workflow_quota: verification record too large"
                );
                let run: RuntimeVerification = serde_json::from_reader(file.take(64 * 1024 + 1))
                    .context("workflow_corrupt: invalid verification evidence")?;
                if run.definition_id == id && run.saved_version == version {
                    ensure!(
                        run.definition_sha256 == hash,
                        "workflow_corrupt: verification definition hash mismatch"
                    );
                    runs.push(run);
                }
            }
        }
        runs.sort_by(|a, b| {
            b.updated_at_ms
                .cmp(&a.updated_at_ms)
                .then_with(|| a.run_id.cmp(&b.run_id))
        });
        let total_run_count = runs.len();
        let mut bytes = 0usize;
        let mut selected = Vec::new();
        for run in runs.into_iter().skip(offset).take(limit) {
            let size = serde_json::to_vec(&run)?.len();
            if bytes.saturating_add(size) > 512 * 1024 {
                break;
            }
            bytes += size;
            selected.push(run);
        }
        let end = offset.saturating_add(selected.len());
        Ok(VersionVerification {
            definition_id: id.into(),
            saved_version: version,
            availability: availability.into(),
            draft_status: if record
                .is_some_and(|record| record.draft.status == WorkflowStatus::Draft)
            {
                "new_draft_unverified"
            } else {
                "saved"
            }
            .into(),
            static_check: record
                .and_then(|record| record.static_checks.get(&version).cloned())
                .or_else(|| historical.and_then(|value| value.static_check)),
            runs: selected,
            total_run_count,
            next_offset: (end < total_run_count).then_some(end),
        })
    }

    /// The caller has already authenticated a control change against this real run.
    /// Updates the run receipt only; the pinned definition and static evidence are immutable.
    pub fn mark_run_interaction_modified(&self, run_id: &str) -> Result<()> {
        ensure!(
            self.mark_interaction_modified(run_id, None)?,
            "workflow_not_found: no active evidence for controlled run"
        );
        Ok(())
    }

    /// Ordinary runs may have no verification receipt. Storage failures still propagate.
    /// A retried control cannot change another resume attempt's evidence.
    pub fn mark_run_attempt_interaction_modified(
        &self,
        run_id: &str,
        resume_count: u32,
    ) -> Result<bool> {
        self.mark_interaction_modified(run_id, Some(resume_count))
    }

    fn mark_interaction_modified(&self, run_id: &str, resume_count: Option<u32>) -> Result<bool> {
        crate::graph::validate_id(run_id)?;
        let Some(root) = self.open(false)? else {
            return Ok(false);
        };
        let directory = match root.open_child(OsStr::new("verification"), false) {
            Ok(directory) => directory,
            Err(error) if not_found(&error) => return Ok(false),
            Err(error) => return Err(error),
        };
        let _lease = library_lease(&directory, true)?;
        let mut found = false;
        for (leaf, file) in directory.open_regular_files(|name| {
            name.to_string_lossy().starts_with(&format!("{run_id}-"))
                && name.to_string_lossy().ends_with(".json")
        })? {
            ensure!(
                file.metadata()?.len() <= 64 * 1024,
                "workflow_quota: verification record too large"
            );
            let mut evidence: RuntimeVerification =
                serde_json::from_reader(file.take(64 * 1024 + 1))?;
            if evidence.run_id == run_id
                && evidence.execution_status == "running"
                && resume_count.is_none_or(|count| evidence.resume_count == count)
            {
                evidence.interaction_modified = true;
                evidence.updated_at_ms = now_ms()?;
                directory.atomic_replace(&leaf, &serde_json::to_vec(&evidence)?)?;
                found = true;
            }
        }
        Ok(found)
    }

    /// The host holds the per-run execution/resume lease while allocating this artifact ordinal.
    pub fn next_verification_attempt(&self, run_id: &str) -> Result<u32> {
        crate::graph::validate_id(run_id)?;
        let root = self.open(true)?.context("workflow_not_found: library")?;
        let directory = root.open_child(OsStr::new("verification"), true)?;
        let _lease = library_lease(&directory, true)?;
        let mut highest = None;
        for (_, file) in directory.open_regular_files(|leaf| {
            leaf.to_string_lossy().starts_with(&format!("{run_id}-"))
                && leaf.to_string_lossy().ends_with(".json")
        })? {
            ensure!(
                file.metadata()?.len() <= 64 * 1024,
                "workflow_quota: evidence too large"
            );
            let evidence: RuntimeVerification = serde_json::from_reader(file.take(64 * 1024 + 1))?;
            if evidence.run_id == run_id {
                let attempt = evidence.artifact_attempt.unwrap_or(evidence.resume_count);
                highest = Some(highest.map_or(attempt, |current: u32| current.max(attempt)));
            }
        }
        highest.map_or(Ok(0), |attempt| {
            attempt
                .checked_add(1)
                .context("workflow_quota: verification artifact ordinal exhausted")
        })
    }
    /// Start admission and version cleanup share the main lease, closing read/start/archive races.
    pub fn admit_verification(
        &self,
        evidence: &RuntimeVerification,
        definition: &WorkflowDefinition,
    ) -> Result<()> {
        let directory = self.open(true)?.context("workflow_not_found: library")?;
        let _lease = library_lease(&directory, false)?;
        let library = load(&directory)?;
        let active=library.records.get(&evidence.definition_id).and_then(|record|record.versions.get(&evidence.saved_version))
            .context("workflow_version_archived: selected version is no longer published; reload before starting a run")?;
        ensure!(
            definition_fingerprint(active)? == definition_fingerprint(definition)?,
            "workflow_conflict: admission snapshot differs from saved version"
        );
        self.record_verification_pinned(evidence, definition)
    }

    pub fn record_verification(&self, evidence: &RuntimeVerification) -> Result<()> {
        crate::graph::validate_id(&evidence.definition_id)?;
        crate::graph::validate_id(&evidence.run_id)?;
        let definition = self.read_saved(&evidence.definition_id, Some(evidence.saved_version))?;
        self.record_verification_pinned(evidence, &definition)
    }
    /// The trusted host owns this exact immutable snapshot, even if it was explicitly archived.
    pub fn record_verification_pinned(
        &self,
        evidence: &RuntimeVerification,
        definition: &WorkflowDefinition,
    ) -> Result<()> {
        crate::graph::validate_id(&evidence.definition_id)?;
        crate::graph::validate_id(&evidence.run_id)?;
        ensure!(
            definition.id == evidence.definition_id
                && definition.saved_version == Some(evidence.saved_version)
                && definition.status == WorkflowStatus::Saved,
            "workflow_conflict: evidence does not match pinned identity"
        );
        ensure!(
            definition_fingerprint(definition)? == evidence.definition_sha256,
            "workflow_conflict: evidence does not match the immutable saved version"
        );
        ensure!(
            matches!(evidence.outcome_certainty.as_str(), "known" | "unknown")
                && evidence.scope == "configured_result_checks"
                && matches!(
                    evidence.check_status.as_str(),
                    "not_requested" | "pending" | "passed" | "failed" | "incomplete"
                ),
            "workflow_invalid: verification scope/status"
        );
        ensure!(
            evidence.checked_nodes.iter().all(|id| definition
                .nodes
                .iter()
                .any(|node| &node.id == id && node.config.result_check.is_some()))
                && evidence
                    .skipped_nodes
                    .iter()
                    .all(|id| definition.nodes.iter().any(|node| &node.id == id)),
            "workflow_invalid: evidence references unknown checks/nodes"
        );
        ensure!(
            evidence.check_status != "passed"
                || (evidence.execution_status == "completed" && !evidence.checked_nodes.is_empty()),
            "workflow_invalid: passing checks require completed execution and actual checked nodes"
        );
        if let Some(scenario) = &evidence.scenario {
            scenario.request.validate(definition)?;
            ensure!(
                scenario.scope == "declared_configured_checks"
                    && scenario.status == scenario.outcome(evidence),
                "workflow_invalid: scenario verdict differs from actual configured-check coverage"
            );
        }
        ensure!(
            evidence.model_snapshot.is_object()
                && evidence
                    .model_snapshot
                    .as_object()
                    .unwrap()
                    .keys()
                    .all(|key| matches!(
                        key.as_str(),
                        "model"
                            | "provider"
                            | "reasoningEffort"
                            | "configuration"
                            | "selectionSource"
                            | "agents"
                            | "agentsIncomplete"
                    )),
            "workflow_invalid: non-public model snapshot fields"
        );
        if let Some(configuration) = evidence.model_snapshot.get("configuration") {
            serde_json::from_value::<kcoder_types::ModelConfigurationSummary>(
                configuration.clone(),
            )
            .map_err(|_| anyhow::anyhow!("workflow_invalid: unsafe model configuration"))?;
        }
        ensure!(
            evidence
                .model_snapshot
                .get("selectionSource")
                .is_none_or(|value| value.as_str() == Some("inherited_session")),
            "workflow_invalid: unsupported model selection source"
        );
        ensure!(
            evidence
                .model_snapshot
                .get("agentsIncomplete")
                .is_none_or(Value::is_boolean),
            "workflow_invalid: unsafe snapshot completeness"
        );
        if let Some(agents) = evidence.model_snapshot.get("agents") {
            let agents: Vec<kcoder_types::WorkflowAgentConfigurationSummary> =
                serde_json::from_value(agents.clone()).map_err(|_| {
                    anyhow::anyhow!("workflow_invalid: unsafe agent model configuration")
                })?;
            let mut identities = std::collections::BTreeSet::new();
            ensure!(
                agents.len() <= 64
                    && serde_json::to_vec(&evidence.model_snapshot)?.len() <= 48 * 1024,
                "workflow_invalid: agent configuration limit"
            );
            for agent in agents {
                ensure!(
                    agent.run_id == evidence.run_id
                        && agent.artifact_attempt
                            == evidence.artifact_attempt.unwrap_or(evidence.resume_count)
                        && !agent.agent_id.is_empty()
                        && agent.agent_id.len() <= 160
                        && agent
                            .agent_id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                        && identities.insert(agent.agent_id),
                    "workflow_invalid: mismatched agent configuration attempt"
                );
            }
        }
        let root = self.open(true)?.context("workflow_not_found: library")?;
        let directory = root.open_child(OsStr::new("verification"), true)?;
        let _lease = library_lease(&directory, true)?;
        let leaf = format!(
            "{}-{}.json",
            evidence.run_id,
            evidence.artifact_attempt.unwrap_or(evidence.resume_count)
        );
        let mut evidence = evidence.clone();
        match directory.open_regular_file(OsStr::new(&leaf)) {
            Ok(file) => {
                ensure!(
                    file.metadata()?.len() <= 64 * 1024,
                    "workflow_quota: verification record too large"
                );
                let prior: RuntimeVerification = serde_json::from_reader(file.take(64 * 1024 + 1))?;
                ensure!(
                    prior.definition_id == evidence.definition_id
                        && prior.saved_version == evidence.saved_version
                        && prior.definition_sha256 == evidence.definition_sha256
                        && prior.input_sha256 == evidence.input_sha256,
                    "workflow_conflict: run evidence identity/input changed"
                );
                evidence.interaction_modified |= prior.interaction_modified;
                ensure!(
                    prior.execution_status == "running"
                        || serde_json::to_value(&prior)? == serde_json::to_value(&evidence)?,
                    "workflow_conflict: terminal evidence is immutable"
                );
            }
            Err(error) if not_found(&error) => {}
            Err(error) => return Err(error),
        }
        let bytes = serde_json::to_vec(&evidence)?;
        ensure!(
            bytes.len() <= 64 * 1024,
            "workflow_quota: verification record too large"
        );
        let files =
            directory.open_regular_files(|leaf| leaf.to_string_lossy().ends_with(".json"))?;
        let mut total = bytes.len() as u64;
        let mut count = 1;
        for (name, file) in files {
            if name != OsStr::new(&leaf) {
                total += file.metadata()?.len();
                count += 1;
            }
        }
        ensure!(
            count <= 1024 && total <= 16 * 1024 * 1024,
            "workflow_quota: verification history full; prior evidence retained"
        );
        directory
            .atomic_replace(OsStr::new(&leaf), &bytes)
            .context("workflow_storage: evidence commit unconfirmed; reload before retrying")
    }
}
