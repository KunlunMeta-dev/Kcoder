//! Native physical recovery evidence stays inside the original workflow run.
use super::*;
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_state::{AppState, ArtifactValidationReport};
use kcoder_types::workflow::{WorkflowDefinition, WorkflowNode, WorkflowNodeKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    io::{Read, Write},
    path::{Path, PathBuf},
};
const NAME: &str = "collaboration-artifacts-v1.json";
const LIMIT: u64 = 128 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileObservation {
    bytes: u64,
    sha256: String,
    producer_run: String,
    producer_node: String,
    producer_agent: String,
    declarations_sha256: String,
    validation_run: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    run_id: String,
    definition_sha256: String,
    policy_sha256: String,
    workspace_identity: String,
    files: BTreeMap<String, FileObservation>,
}
pub(in crate::workflow) struct NativeArtifacts {
    directory: PathBuf,
    source: Option<PathBuf>,
    observation_root: PathBuf,
    run_id: String,
    definition: WorkflowDefinition,
    policy_sha256: String,
    state: AppState,
    initialized: tokio::sync::OnceCell<()>,
}
impl NativeArtifacts {
    pub(in crate::workflow) fn new(
        directory: PathBuf,
        source: Option<PathBuf>,
        observation_root: PathBuf,
        run_id: String,
        definition: WorkflowDefinition,
        policy: &Value,
        state: AppState,
    ) -> Result<Self> {
        Ok(Self {
            directory,
            source,
            observation_root,
            run_id,
            definition,
            policy_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(policy)?)),
            state,
            initialized: tokio::sync::OnceCell::new(),
        })
    }
    fn definition_hash(root: &Path) -> Result<String> {
        let directory = PrivateDirectory::open_existing(root)?;
        let bytes = read(&directory, "definition.json", 128 * 1024)?;
        let state: Value = serde_json::from_slice(&read(&directory, "state.json", 128 * 1024)?)?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        ensure!(
            state["definition_sha256"].as_str() == Some(hash.as_str()),
            "workflow_artifact: original fixed definition identity is unavailable"
        );
        Ok(hash)
    }
    fn workspace_identity(&self) -> Result<String> {
        PrivateDirectory::open_existing(&self.state.cwd())?.directory_identity()
    }
    fn wanted(&self) -> BTreeSet<String> {
        self.definition
            .nodes
            .iter()
            .flat_map(|node| {
                node.config
                    .artifact_requirements
                    .iter()
                    .map(|item| item.path.clone())
            })
            .collect()
    }
    fn validate(&self, root: &Path, manifest: &Manifest) -> Result<()> {
        ensure!(
            manifest.version == 1
                && manifest.files.len() <= 32
                && manifest.definition_sha256 == Self::definition_hash(root)?
                && manifest.policy_sha256 == self.policy_sha256
                && manifest.workspace_identity == self.workspace_identity()?,
            "workflow_artifact: original source, policy or workspace changed"
        );
        let state: Value = serde_json::from_slice(&read(
            &PrivateDirectory::open_existing(root)?,
            "state.json",
            128 * 1024,
        )?)?;
        ensure!(
            state["run_id"].as_str() == Some(manifest.run_id.as_str()),
            "workflow_artifact: original run evidence mismatch"
        );
        for (path, file) in &manifest.files {
            kcoder_workflow::collaboration::validate_relative_artifact_path(path)?;
            ensure!(
                file.sha256.len() == 64
                    && file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && file.declarations_sha256.len() == 64,
                "workflow_artifact: invalid original native file observation"
            );
        }
        Ok(())
    }
    pub(in crate::workflow) async fn ensure_initialized(
        &self,
        runner: &dyn AgentRunner,
    ) -> Result<()> {
        // Publish readiness only after the complete native physical check.
        // Tokio releases the initializer permit on error or cancellation, so a
        // waiter can retry but cannot observe a partially initialized run.
        self.initialized
            .get_or_try_init(|| async {
                let directory = PrivateDirectory::open_existing(&self.directory)?;
                if let Some(source) = &self.source {
                    let source_dir = PrivateDirectory::open_existing(source)?;
                    let mut manifest: Manifest =
                        serde_json::from_slice(&read(&source_dir, NAME, LIMIT)?)?;
                    self.validate(source, &manifest)?;
                    self.fresh(runner, &manifest, false).await?;
                    if *source != self.directory {
                        manifest
                            .files
                            .retain(|path, _| self.wanted().contains(path));
                        manifest.run_id = self.run_id.clone();
                        manifest.definition_sha256 = Self::definition_hash(&self.directory)?;
                        create(&directory, &manifest)?;
                    }
                } else {
                    create(
                        &directory,
                        &Manifest {
                            version: 1,
                            run_id: self.run_id.clone(),
                            definition_sha256: Self::definition_hash(&self.directory)?,
                            policy_sha256: self.policy_sha256.clone(),
                            workspace_identity: self.workspace_identity()?,
                            files: BTreeMap::new(),
                        },
                    )?;
                }
                Ok::<(), anyhow::Error>(())
            })
            .await?;
        let directory = PrivateDirectory::open_existing(&self.directory)?;
        let manifest: Manifest = serde_json::from_slice(&read(&directory, NAME, LIMIT)?)?;
        self.validate(&self.directory, &manifest)?;
        Ok(())
    }
    async fn fresh(
        &self,
        runner: &dyn AgentRunner,
        manifest: &Manifest,
        require_all: bool,
    ) -> Result<()> {
        let wanted = self.wanted();
        if require_all {
            ensure!(
                wanted.iter().all(|path| manifest.files.contains_key(path)),
                "workflow_artifact: required native artifact evidence is missing"
            );
        }
        let mut evidence = vec![];
        for (path, expected) in manifest
            .files
            .iter()
            .filter(|(path, _)| wanted.contains(*path))
        {
            let output = self.read_file(runner, path).await?;
            let actual = output
                .execution_metadata
                .iter()
                .find_map(|meta| match meta {
                    crate::ToolExecutionMetadata::FileRead(value) => Some(value),
                    _ => None,
                })
                .context("workflow_artifact: actual native file-read evidence is unavailable")?;
            let (bytes, hash) = actual
                .full_content_observation()
                .context("workflow_artifact: current file identity is unstable")?;
            ensure!(
                bytes == expected.bytes && hash == expected.sha256,
                "workflow_artifact: file changed since the original successful write; inspect it before continuing"
            );
            evidence.push(actual.clone());
        }
        ensure!(
            evidence.iter().all(|evidence| evidence.still_matches()),
            "workflow_artifact: file set changed during recovery verification"
        );
        Ok(())
    }
    async fn read_file(&self, runner: &dyn AgentRunner, path: &str) -> Result<crate::ToolOutput> {
        ensure!(
            runner.workflow_tool_is_read_only("read"),
            "workflow_artifact: registered native reader unavailable"
        );
        let (output, _) = runner
            .run_workflow_tool(
                &format!("collaboration-recheck-{}", uuid::Uuid::new_v4()),
                "read",
                json!({"file_path":path,"format":"raw"}),
            )
            .await
            .map_err(|_| {
                anyhow::anyhow!("workflow_artifact: current file read was denied or unavailable")
            })?;
        ensure!(
            !output.is_error,
            "workflow_artifact: current file missing, denied or unavailable"
        );
        let expected = self
            .state
            .cwd()
            .join(path)
            .canonicalize()
            .context("workflow_artifact: current file missing")?;
        let evidence = output
            .execution_metadata
            .iter()
            .find_map(|meta| match meta {
                crate::ToolExecutionMetadata::FileRead(value) => Some(value),
                _ => None,
            })
            .context("workflow_artifact: reader did not return native descriptor evidence")?;
        ensure!(
            evidence.path() == expected && evidence.full_content_observation().is_some(),
            "workflow_artifact: current native file identity does not match the original scope"
        );
        Ok(output)
    }
    pub(in crate::workflow) fn record(
        &self,
        agent_id: &str,
        requirements: &[kcoder_state::ArtifactRequirement],
        report: &ArtifactValidationReport,
    ) -> Result<()> {
        let observation =
            crate::workflow_runs::observe_read(self.observation_root.clone(), &self.run_id)?;
        let nodes: Vec<_> = observation
            .node_states
            .iter()
            .filter(|node| node.agent_id.as_deref() == Some(agent_id) && node.status == "running")
            .collect();
        ensure!(
            nodes.len() == 1,
            "workflow_artifact: original native producer node is unavailable"
        );
        let directory = PrivateDirectory::open_existing(&self.directory)?;
        let mut manifest: Manifest = serde_json::from_slice(&read(&directory, NAME, LIMIT)?)?;
        self.validate(&self.directory, &manifest)?;
        for (index, requirement) in requirements.iter().enumerate() {
            let entry = report
                .entries
                .iter()
                .find(|entry| entry.index == index)
                .context("workflow_artifact: original report entry missing")?;
            if !requirement.required
                && entry.status == kcoder_state::ArtifactValidationStatus::SkippedMissing
            {
                continue;
            }
            manifest.files.insert(
                requirement.path.clone(),
                FileObservation {
                    bytes: entry
                        .size_bytes
                        .context("workflow_artifact: actual size unavailable")?,
                    sha256: entry
                        .sha256
                        .clone()
                        .context("workflow_artifact: actual hash unavailable")?,
                    producer_run: self.run_id.clone(),
                    producer_node: nodes[0].node_id.clone(),
                    producer_agent: agent_id.into(),
                    declarations_sha256: report.run.declarations_sha256.clone(),
                    validation_run: report.run.run_id.clone(),
                },
            );
        }
        let bytes = serde_json::to_vec(&manifest)?;
        ensure!(
            bytes.len() as u64 <= LIMIT,
            "workflow_artifact: native evidence limit"
        );
        directory.atomic_replace(OsStr::new(NAME), &bytes)?;
        Ok(())
    }
    pub(in crate::workflow) async fn recheck(
        &self,
        runner: &dyn AgentRunner,
        node: &WorkflowNode,
        original: Value,
    ) -> Result<Value> {
        self.ensure_initialized(runner).await?;
        let manifest: Manifest = serde_json::from_slice(&read(
            &PrivateDirectory::open_existing(&self.directory)?,
            NAME,
            LIMIT,
        )?)?;
        self.validate(&self.directory, &manifest)?;
        if node.id == "collaboration_output" {
            self.fresh(runner, &manifest, true).await?;
        }
        if node.kind == WorkflowNodeKind::Tool {
            let tool = node
                .config
                .tool
                .as_ref()
                .context("workflow_artifact: original read node missing")?;
            ensure!(
                tool.name == "read" && tool.bindings.is_empty(),
                "workflow_artifact: recovery only accepts original bounded readback"
            );
            let path = tool.arguments["file_path"]
                .as_str()
                .context("workflow_artifact: original read path missing")?;
            ensure!(
                manifest.files.contains_key(path),
                "workflow_artifact: original successful producer evidence missing"
            );
            self.fresh(runner, &manifest, false).await?;
            let output = self.read_file(runner, path).await?;
            return Ok(json!({"content":output.content,"isError":output.is_error}));
        }
        Ok(original)
    }
}
fn read(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Vec<u8>> {
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    let mut bytes = vec![];
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit,
        "workflow_artifact: bounded native evidence required"
    );
    Ok(bytes)
}
fn create(directory: &PrivateDirectory, manifest: &Manifest) -> Result<()> {
    let bytes = serde_json::to_vec(manifest)?;
    ensure!(
        bytes.len() as u64 <= LIMIT,
        "workflow_artifact: evidence limit"
    );
    let mut file = directory.open_read_write_file(OsStr::new(NAME), true)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    directory.sync()?;
    Ok(())
}
