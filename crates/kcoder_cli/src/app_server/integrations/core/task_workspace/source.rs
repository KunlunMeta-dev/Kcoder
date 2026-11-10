//! Reads the same original objects as native thread/goal/agent/workflow views.
use super::*;
use crate::app_server::{
    agent_summary, persisted_thread_value, thread_goal, thread_history_path,
    thread_snapshot_with_metadata_policy,
};
use anyhow::{Context, ensure};
use kcoder_app_protocol::{Thread, ThreadGoal, ThreadStatus};
use kcoder_config::PrivateDirectory;
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, io::Read};

pub(super) struct Collected {
    pub thread: TaskWorkspaceEntry,
    pub entries: Vec<TaskWorkspaceEntry>,
    pub facets: Vec<TaskWorkspaceFacet>,
    pub artifacts: Vec<IntegrationEntityRef>,
    pub observed_at_ms: u64,
}
pub(super) struct NativeSource<'a> {
    native: &'a NativeIntegrationContext,
    workspace: &'a QueryEngine,
    selection: &'a NativeTaskWorkspaceSelection,
}
impl<'a> NativeSource<'a> {
    pub(super) fn capture(
        native: &'a NativeIntegrationContext,
        workspace: &'a QueryEngine,
        selection: &'a NativeTaskWorkspaceSelection,
    ) -> Result<Self> {
        let source = Self {
            native,
            workspace,
            selection,
        };
        source.check(&CancellationToken::new())?;
        Ok(source)
    }
    pub(super) fn check(&self, cancel: &CancellationToken) -> Result<()> {
        ensure!(!cancel.is_cancelled(), "TASK_WORKSPACE_CANCELLED");
        self.selection.verify()?;
        self.native.verify()?;
        ensure!(
            IntegrationOwner::from(self.native.scope())
                .organization_id
                .is_none(),
            "TASK_WORKSPACE_ORGANIZATION_UNAVAILABLE"
        );
        self.check_engine(self.workspace)
    }
    fn check_engine(&self, engine: &QueryEngine) -> Result<()> {
        let profile = engine
            .native_settings_source_path()
            .context("TASK_WORKSPACE_PROFILE_UNAVAILABLE")?;
        let parent = PrivateDirectory::open_existing(
            profile
                .parent()
                .context("TASK_WORKSPACE_PROFILE_UNAVAILABLE")?,
        )?;
        let workspace = PrivateDirectory::open_existing(&engine.state.cwd())?;
        ensure!(
            parent.directory_identity()? == self.native.profile()?.directory_identity()?
                && workspace.directory_identity()? == self.native.workspace_directory_identity()?,
            "TASK_WORKSPACE_OWNER_MISMATCH"
        );
        Ok(())
    }
    pub(super) fn authority_fence(&self) -> Result<String> {
        self.native.verify()?;
        let path = self
            .workspace
            .native_settings_source_path()
            .context("TASK_WORKSPACE_PROFILE_UNAVAILABLE")?;
        let parent = self.native.profile()?;
        let name = path
            .file_name()
            .context("TASK_WORKSPACE_PROFILE_UNAVAILABLE")?;
        let mut file = parent.open_single_link_regular_file(name)?;
        ensure!(
            file.metadata()?.len() <= 16 * 1024 * 1024,
            "TASK_WORKSPACE_PROFILE_UNAVAILABLE"
        );
        let mut hash = Sha256::new();
        let mut content = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut content)?;
        ensure!(
            content.len() <= 16 * 1024 * 1024,
            "TASK_WORKSPACE_PROFILE_UNAVAILABLE"
        );
        // Configuration files are not lease files: trusted owner configuration
        // may legitimately be 0644 inside its private parent. Verify bounded
        // current bytes through the original directory, never relax lease rules.
        let mut current = parent.open_single_link_regular_file(name)?;
        let mut current_bytes = Vec::new();
        std::io::Read::by_ref(&mut current)
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut current_bytes)?;
        ensure!(content == current_bytes, "TASK_WORKSPACE_SOURCE_CHANGED");
        hash.update(&content);
        hash.update(serde_json::to_vec(self.native.scope())?);
        // These are conservative invalidation fences, not permission grants or
        // task-state authorities. Do not read credential bodies into a view.
        for domain in [
            super::super::NativeDomain::Policy,
            super::super::NativeDomain::ConnectivitySources,
            super::super::NativeDomain::ConnectivityTaskCapabilityScope,
            super::super::NativeDomain::ConnectivityCredentials,
        ] {
            if let Some(guard) = super::super::NativeDomainGuard::observe(
                self.native.profile()?,
                self.native.scope(),
                domain,
            )? {
                let directory = guard.directory(self.native.profile()?)?;
                hash.update(directory.directory_identity()?.as_bytes());
                let mut identities = vec![];
                directory.visit_regular_files(
                    |_| true,
                    |name, file| {
                        ensure!(identities.len() < 8192, "TASK_WORKSPACE_CAPACITY");
                        let metadata = file.metadata()?;
                        identities.push((
                            name.to_os_string(),
                            metadata_token(&metadata),
                            metadata.len(),
                            metadata.modified()?,
                        ));
                        Ok(())
                    },
                )?;
                identities.sort_by(|a, b| a.0.cmp(&b.0));
                for (name, identity, length, modified) in identities {
                    hash.update(name.to_string_lossy().as_bytes());
                    hash.update(identity.as_bytes());
                    hash.update(length.to_le_bytes());
                    hash.update(
                        modified
                            .duration_since(std::time::UNIX_EPOCH)?
                            .as_nanos()
                            .to_le_bytes(),
                    );
                }
            }
        }
        Ok(format!("{:x}", hash.finalize()))
    }
    pub(super) fn collect(&self, thread_id: &str, cancel: &CancellationToken) -> Result<Collected> {
        self.check(cancel)?;
        let resident = self.selection.resident.clone();
        let running = self.selection.running;
        let mut thread: Thread = if let Some(engine) = &resident {
            self.check_engine(engine)?;
            serde_json::from_value(thread_snapshot_with_metadata_policy(engine, running, true)?)?
        } else {
            let path = thread_history_path(self.workspace, thread_id)?;
            serde_json::from_value(persisted_thread_value(
                self.workspace,
                thread_id,
                &path,
                running,
            )?)?
        };
        self.selection.projection.apply_thread(&mut thread);
        ensure!(thread.id == thread_id, "TASK_WORKSPACE_OWNER_MISMATCH");
        let thread_view = TaskWorkspaceEntry {
            reference: TaskWorkspaceNativeRef::Thread {
                thread_id: thread_id.into(),
            },
            title: preview(thread.title.as_deref().unwrap_or("")),
            native_status: Some(label(&thread.status)?),
            source_method: "thread/read".into(),
            native_revision: None,
        };
        let mut facets = vec![facet(
            TaskWorkspaceFacetKind::Thread,
            if thread.run_summary.is_some() {
                TaskWorkspaceAvailability::Available
            } else {
                TaskWorkspaceAvailability::Partial
            },
            Some(1),
            thread
                .run_summary
                .is_none()
                .then_some("NATIVE_RUN_FACTS_UNAVAILABLE"),
        )];
        let mut entries = vec![];
        let goal = if let Some(engine) = &resident {
            Ok(engine
                .state
                .goal()
                .map(|goal| thread_goal(thread_id, &goal)))
        } else {
            thread_history_path(self.workspace, thread_id)
                .and_then(|path| kcoder_state::history_persisted_goal(&path))
                .map(|goal| goal.map(|goal| thread_goal(thread_id, &goal)))
        };
        match goal {
            Ok(Some(goal)) if goal.goal_id.is_empty() => {
                facets.push(facet(
                    TaskWorkspaceFacetKind::Goal,
                    TaskWorkspaceAvailability::Unknown,
                    None,
                    Some("ORIGINAL_GOAL_ID_UNAVAILABLE"),
                ));
            }
            Ok(goal) => {
                facets.push(facet(
                    TaskWorkspaceFacetKind::Goal,
                    TaskWorkspaceAvailability::Available,
                    Some(u64::from(goal.is_some())),
                    None,
                ));
                if let Some(goal) = goal {
                    entries.push(goal_entry(goal));
                }
            }
            Err(_) => facets.push(facet(
                TaskWorkspaceFacetKind::Goal,
                TaskWorkspaceAvailability::Unknown,
                None,
                Some("NATIVE_GOAL_UNREADABLE"),
            )),
        }
        if let Some(engine) = &resident {
            let tasks = engine
                .state
                .tasks()
                .into_values()
                .filter(|task| {
                    task.kind == kcoder_state::TaskKind::Subagent
                        && task.parent_session_id.as_deref() == Some(thread_id)
                })
                .collect::<Vec<_>>();
            ensure!(tasks.len() <= 512, "TASK_WORKSPACE_CAPACITY");
            facets.push(facet(
                TaskWorkspaceFacetKind::Agents,
                TaskWorkspaceAvailability::Available,
                Some(tasks.len() as u64),
                None,
            ));
            for task in tasks {
                let title = preview(&task.description);
                let summary = agent_summary(task);
                entries.push(TaskWorkspaceEntry {
                    reference: TaskWorkspaceNativeRef::Agent {
                        thread_id: thread_id.into(),
                        agent_id: summary.agent_id,
                        background_run: summary.background_run,
                    },
                    title,
                    native_status: Some(summary.status),
                    source_method: "agent/list".into(),
                    native_revision: None,
                });
            }
        } else {
            let historical = thread_history_path(self.workspace, thread_id).and_then(|path| {
                kcoder_state::capture_task_workspace_metadata(&path, || self.check(cancel))?
                    .prepare_subagents()
            });
            match historical {
                Ok(Some(snapshot)) => {
                    let mut complete = snapshot.complete;
                    let mut count = 0u64;
                    for agent in snapshot.agents {
                        self.check(cancel)?;
                        let reference = TaskWorkspaceNativeRef::Agent {
                            thread_id: thread_id.into(),
                            agent_id: agent.id,
                            background_run: agent.background_run,
                        };
                        if reference.validate().is_err() {
                            complete = false;
                            continue;
                        }
                        count += 1;
                        entries.push(TaskWorkspaceEntry {
                            reference,
                            title: preview(&agent.description),
                            native_status: (!agent.status.as_str().is_empty())
                                .then(|| agent.status.as_str().to_owned()),
                            source_method: "history/agents".into(),
                            native_revision: None,
                        });
                    }
                    facets.push(facet(
                        TaskWorkspaceFacetKind::Agents,
                        TaskWorkspaceAvailability::Partial,
                        Some(count),
                        Some(if complete {
                            "HISTORICAL_AGENTS_SNAPSHOT"
                        } else {
                            "HISTORICAL_AGENTS_PARTIAL"
                        }),
                    ));
                }
                Ok(None) | Err(_) => facets.push(facet(
                    TaskWorkspaceFacetKind::Agents,
                    TaskWorkspaceAvailability::Unknown,
                    None,
                    Some("HISTORICAL_AGENT_READER_UNAVAILABLE"),
                )),
            }
        }
        let profile = self
            .workspace
            .native_settings_source_path()
            .context("TASK_WORKSPACE_PROFILE_UNAVAILABLE")?;
        let runs_root = profile
            .parent()
            .context("TASK_WORKSPACE_PROFILE_UNAVAILABLE")?
            .join("workflow-runs");
        match kcoder_tools::workflow_runs::observe_list(runs_root) {
            Ok(runs) => {
                let runs = runs
                    .into_iter()
                    .filter(|run| run.thread_id == thread_id)
                    .collect::<Vec<_>>();
                facets.push(facet(
                    TaskWorkspaceFacetKind::Workflows,
                    TaskWorkspaceAvailability::Available,
                    Some(runs.len() as u64),
                    None,
                ));
                for run in runs {
                    ensure!(
                        PrivateDirectory::open_existing(std::path::Path::new(&run.workspace))?
                            .directory_identity()?
                            == self.native.workspace_directory_identity()?,
                        "TASK_WORKSPACE_OWNER_MISMATCH"
                    );
                    let definition_ref =
                        run.definition_id.zip(run.version).map(|(id, revision)| {
                            IntegrationRevisionRef {
                                id,
                                revision: revision.to_string(),
                            }
                        });
                    entries.push(TaskWorkspaceEntry {
                        reference: TaskWorkspaceNativeRef::WorkflowRun {
                            thread_id: thread_id.into(),
                            run_id: run.run_id,
                            revision: run.revision,
                            definition_ref,
                        },
                        title: "".into(),
                        native_status: Some(run.status),
                        source_method: "workflow/runs/list".into(),
                        native_revision: Some(run.revision.to_string()),
                    });
                }
            }
            Err(_) => facets.push(facet(
                TaskWorkspaceFacetKind::Workflows,
                TaskWorkspaceAvailability::Unknown,
                None,
                Some("NATIVE_WORKFLOW_OBSERVATION_UNREADABLE"),
            )),
        }
        facets.push(facet(
            TaskWorkspaceFacetKind::Runtime,
            TaskWorkspaceAvailability::Unknown,
            None,
            Some("ORIGINAL_RUNTIME_REFERENCE_REQUIRED"),
        ));
        facets.push(facet(
            TaskWorkspaceFacetKind::Sources,
            TaskWorkspaceAvailability::Unknown,
            None,
            Some("ORIGINAL_ACCEPTED_TASK_REFERENCE_REQUIRED"),
        ));
        let artifacts = if !self
            .workspace
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("TASK_WORKSPACE_PROFILE_UNAVAILABLE"))?
            .integrations
            .office
            .enabled
        {
            facets.push(facet(
                TaskWorkspaceFacetKind::Artifacts,
                TaskWorkspaceAvailability::Unavailable,
                None,
                Some("OFFICE_DISABLED"),
            ));
            vec![]
        } else {
            let observed = (|| -> Result<Vec<IntegrationEntityRef>> {
                let Some(guard) = super::super::NativeDomainGuard::observe(
                    self.native.profile()?,
                    self.native.scope(),
                    super::super::NativeDomain::Office,
                )?
                else {
                    return Ok(vec![]);
                };
                let store = kcoder_state::integrations::office::OfficeStore::open_in(
                    &guard.directory(self.native.profile()?)?,
                    OsStr::new("data"),
                    IntegrationOwner::from(self.native.scope()),
                )?
                .context("TASK_WORKSPACE_ARTIFACTS_UNAVAILABLE")?;
                Ok(store
                    .list_artifacts(thread_id)?
                    .into_iter()
                    .map(|manifest| IntegrationEntityRef {
                        kind: IntegrationEntityKind::Artifact,
                        id: manifest.id,
                        revision: Some(manifest.revision.to_string()),
                    })
                    .collect())
            })();
            match observed {
                Ok(refs) => {
                    facets.push(facet(
                        TaskWorkspaceFacetKind::Artifacts,
                        TaskWorkspaceAvailability::Available,
                        Some(refs.len() as u64),
                        None,
                    ));
                    refs
                }
                Err(_) => {
                    facets.push(facet(
                        TaskWorkspaceFacetKind::Artifacts,
                        TaskWorkspaceAvailability::Unknown,
                        None,
                        Some("NATIVE_ARTIFACT_OBSERVATION_UNREADABLE"),
                    ));
                    vec![]
                }
            }
        };
        entries.sort_by_key(|entry| serde_json::to_string(&entry.reference).unwrap_or_default());
        self.check(cancel)?;
        Ok(Collected {
            thread: thread_view,
            entries,
            facets,
            artifacts,
            observed_at_ms: u64::try_from(chrono::Utc::now().timestamp_millis())?,
        })
    }
}
fn label(value: &ThreadStatus) -> Result<String> {
    Ok(serde_json::to_value(value)?
        .as_str()
        .context("TASK_WORKSPACE_NATIVE_STATUS_INVALID")?
        .into())
}
fn preview(value: &str) -> String {
    value.chars().take(512).collect()
}
fn goal_entry(goal: ThreadGoal) -> TaskWorkspaceEntry {
    TaskWorkspaceEntry {
        reference: TaskWorkspaceNativeRef::Goal {
            thread_id: goal.thread_id,
            goal_id: goal.goal_id,
            revision: goal.revision,
        },
        title: preview(&goal.objective),
        native_status: Some(goal.status),
        source_method: "thread/goal/get".into(),
        native_revision: Some(goal.revision.to_string()),
    }
}
fn facet(
    kind: TaskWorkspaceFacetKind,
    availability: TaskWorkspaceAvailability,
    observed_count: Option<u64>,
    reason: Option<&str>,
) -> TaskWorkspaceFacet {
    TaskWorkspaceFacet {
        kind,
        availability,
        observed_count,
        reason_code: reason.map(str::to_owned),
    }
}

fn metadata_token(metadata: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.uid(),
            metadata.gid(),
            metadata.mode(),
            metadata.nlink(),
            metadata.ctime(),
            metadata.ctime_nsec(),
            metadata.size()
        )
    }
    #[cfg(not(unix))]
    {
        format!(
            "{}:{:?}:{:?}:{}",
            metadata.len(),
            metadata.modified().ok(),
            metadata.created().ok(),
            metadata.permissions().readonly()
        )
    }
}
