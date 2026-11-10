//! Bounded project knowledge views over existing documents; this module never publishes knowledge.

use anyhow::{Context, Result, ensure};
use kcoder_config::{FolderTrust, FolderTrustStore, PrivateDirectory};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

pub const MAX_KNOWLEDGE_FILES: usize = 8;
pub const DEFAULT_KNOWLEDGE_BYTES: usize = 32 * 1024;
pub const MAX_KNOWLEDGE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectKnowledgeKind {
    AuthoritativeSpec,
    CandidateSpec,
    HistoricalChange,
    ProjectDocument,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectKnowledgeSource {
    pub path: String,
    pub kind: ProjectKnowledgeKind,
    pub revision: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectKnowledgeView {
    pub scope: String,
    pub sources: Vec<ProjectKnowledgeSource>,
    pub bytes_read: usize,
    pub byte_budget: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectKnowledgeProposal {
    pub status: &'static str,
    pub path: String,
    pub base_revision: String,
    pub proposed_revision: String,
    pub diff: String,
    pub delta: Option<String>,
    pub change_base: Option<ProjectKnowledgeChangeBase>,
    pub publication: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectKnowledgeSourceGuard {
    pub path: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectKnowledgeChangeBase {
    pub scope: String,
    pub sources: Vec<ProjectKnowledgeSourceGuard>,
}

/// Authority is supplied by the target host, never by model input or a client path.
pub struct ProjectKnowledgeAccess {
    workspace: PathBuf,
    profile: PathBuf,
    directory: PrivateDirectory,
    workspace_identity: String,
    profile_identity: String,
    scope: String,
}

impl ProjectKnowledgeAccess {
    pub fn open(
        workspace: &Path,
        profile: &Path,
        principal: Option<&str>,
        session: &str,
    ) -> Result<Self> {
        ensure!(!session.is_empty(), "project_knowledge_missing_session");
        let directory = PrivateDirectory::open_existing(workspace)?;
        let profile_directory = PrivateDirectory::open_existing(profile)?;
        profile_directory.verify_trusted_config_directory()?;
        let workspace = workspace.canonicalize()?;
        let profile = profile.canonicalize()?;
        let workspace_identity = directory.directory_identity()?;
        let profile_identity = profile_directory.directory_identity()?;
        static HOST: OnceLock<String> = OnceLock::new();
        let host = HOST
            .get_or_init(|| format!("{}:{:?}", std::process::id(), std::time::SystemTime::now()));
        let scope = hash(&serde_json::to_vec(&(
            "kcoder-project-knowledge/1",
            host,
            &workspace,
            &workspace_identity,
            &profile,
            &profile_identity,
            principal,
            session,
        ))?);
        let access = Self {
            workspace,
            profile,
            directory,
            workspace_identity,
            profile_identity,
            scope,
        };
        access.revalidate()?;
        Ok(access)
    }

    fn revalidate(&self) -> Result<()> {
        ensure!(
            FolderTrustStore::trust_all_from_environment()
                || FolderTrustStore::load(&self.profile).check(&self.workspace)
                    == FolderTrust::Trusted,
            "project_knowledge_untrusted: trust this workspace in the current target profile before reading project knowledge"
        );
        ensure!(
            PrivateDirectory::open_existing(&self.workspace)?.directory_identity()?
                == self.workspace_identity
                && PrivateDirectory::open_existing(&self.profile)?.directory_identity()?
                    == self.profile_identity,
            "project_knowledge_scope_changed: reread in the current workspace and target profile"
        );
        Ok(())
    }

    /// Every invocation reads fresh bytes. Oversized or unavailable inputs fail without partial facts.
    pub fn read(
        &self,
        paths: &[String],
        byte_budget: usize,
        mut active: impl FnMut() -> bool,
    ) -> Result<ProjectKnowledgeView> {
        ensure!(
            !paths.is_empty() && paths.len() <= MAX_KNOWLEDGE_FILES,
            "project_knowledge_paths: provide 1..=8 relevant Markdown paths"
        );
        ensure!(
            (1..=MAX_KNOWLEDGE_BYTES).contains(&byte_budget),
            "project_knowledge_budget: max_total_bytes must be 1..=65536"
        );
        let mut unique = BTreeSet::new();
        let selected = paths
            .iter()
            .map(|path| {
                let kind = classify(path)?;
                ensure!(
                    unique.insert(path),
                    "project_knowledge_duplicate_path: {path}"
                );
                Ok((path, kind))
            })
            .collect::<Result<Vec<_>>>()?;
        self.revalidate()?;
        let mut sources = Vec::new();
        let mut bytes_read = 0;
        for (path, kind) in selected {
            ensure!(active(), "project_knowledge_cancelled");
            let remaining = byte_budget - bytes_read;
            ensure!(
                remaining > 0,
                "project_knowledge_budget_exceeded: request fewer relevant sources"
            );
            let mut directory = self.directory.duplicate_handle()?;
            let mut components = Path::new(path).components().peekable();
            while let Some(Component::Normal(component)) = components.next() {
                if components.peek().is_some() {
                    directory = directory.open_child(component, false)?;
                } else {
                    let snapshot = directory
                        .read_source_document_snapshot(component, remaining as u64, &mut active)
                        .with_context(|| format!("project_knowledge_read: {path}"))?;
                    let content = std::str::from_utf8(snapshot.bytes())
                        .context("project_knowledge_requires_utf8")?
                        .to_owned();
                    let mut current_parent = PrivateDirectory::open_existing(&self.workspace)?;
                    for part in Path::new(path)
                        .parent()
                        .into_iter()
                        .flat_map(Path::components)
                    {
                        if let Component::Normal(part) = part {
                            current_parent = current_parent.open_child(part, false)?;
                        }
                    }
                    ensure!(
                        current_parent.directory_identity()? == directory.directory_identity()?,
                        "project_knowledge_source_moved: reread the current source path"
                    );
                    bytes_read += content.len();
                    sources.push(ProjectKnowledgeSource {
                        path: path.clone(),
                        kind,
                        revision: snapshot.sha256,
                        content,
                    });
                }
            }
        }
        self.revalidate()?;
        ensure!(active(), "project_knowledge_cancelled");
        Ok(ProjectKnowledgeView {
            scope: self.scope.clone(),
            sources,
            bytes_read,
            byte_budget,
        })
    }

    /// Generate a transient candidate, without modifying documents, changes, or publication state.
    pub fn propose(
        &self,
        view: &ProjectKnowledgeView,
        expected_scope: &str,
        path: &str,
        expected_revision: &str,
        replacement: &str,
    ) -> Result<ProjectKnowledgeProposal> {
        ensure!(
            expected_scope == self.scope && view.scope == self.scope,
            "project_knowledge_scope_changed: reread in the current account, target, workspace and task"
        );
        ensure!(
            replacement.len() <= MAX_KNOWLEDGE_BYTES,
            "project_knowledge_proposal_budget_exceeded"
        );
        let source = view
            .sources
            .iter()
            .find(|source| source.path == path)
            .context("project_knowledge_proposal_requires_selected_source")?;
        ensure!(
            source.revision == expected_revision,
            "project_knowledge_stale_revision: reread the source and reconcile the candidate"
        );
        ensure!(
            source.kind != ProjectKnowledgeKind::HistoricalChange,
            "project_knowledge_historical_source: propose against the current owning specification"
        );
        // A candidate cannot use a previously read view after an external edit.
        let fresh = self.read(&[path.to_owned()], MAX_KNOWLEDGE_BYTES, || true)?;
        ensure!(
            fresh.sources[0].revision == expected_revision,
            "project_knowledge_stale_revision: source changed while preparing the candidate"
        );
        let source = &fresh.sources[0];
        let diff = similar::TextDiff::from_lines(source.content.as_str(), replacement)
            .unified_diff()
            .context_radius(3)
            .header(path, path)
            .to_string();
        ensure!(
            diff.len() <= MAX_KNOWLEDGE_BYTES,
            "project_knowledge_diff_budget_exceeded"
        );
        let delta = if source.kind == ProjectKnowledgeKind::AuthoritativeSpec {
            Some(proposed_delta(&source.content, replacement)?)
        } else {
            None
        };
        Ok(ProjectKnowledgeProposal {
            status: "candidate_update",
            path: path.into(),
            base_revision: expected_revision.into(),
            proposed_revision: hash(replacement.as_bytes()),
            diff,
            delta,
            change_base: (source.kind == ProjectKnowledgeKind::AuthoritativeSpec).then(|| {
                ProjectKnowledgeChangeBase {
                    scope: self.scope.clone(),
                    sources: vec![ProjectKnowledgeSourceGuard {
                        path: path.into(),
                        revision: expected_revision.into(),
                    }],
                }
            }),
            publication: "Not saved or confirmed. Carry change_base into SpecNewChange.knowledge_base, reconcile this candidate in that existing Specs change, validate/review it, and publish only through the existing confirmation and archive workflow. Project documents use their existing revision-aware editing workflow; Wiki uses its own revision and organization controls.",
        })
    }

    /// A candidate's source guards become part of the existing change base, never a parallel store.
    pub fn new_change(
        &self,
        name: &str,
        title: Option<String>,
        base: &ProjectKnowledgeChangeBase,
    ) -> Result<PathBuf> {
        ensure!(
            base.scope == self.scope,
            "project_knowledge_scope_changed: reread and review the candidate in the current task"
        );
        self.revalidate()?;
        validate_source_guards(&base.sources)?;
        crate::change_lifecycle::new_change_with_knowledge_sources(
            &self.workspace,
            name,
            title,
            &base.sources,
        )
    }
}

pub(crate) fn validate_source_guards(guards: &[ProjectKnowledgeSourceGuard]) -> Result<()> {
    ensure!(
        !guards.is_empty() && guards.len() <= MAX_KNOWLEDGE_FILES,
        "project_knowledge_source_guards: provide 1..=8 source revisions"
    );
    let mut paths = BTreeSet::new();
    for guard in guards {
        ensure!(
            classify(&guard.path)? == ProjectKnowledgeKind::AuthoritativeSpec
                && guard.revision.len() == 64
                && guard.revision.bytes().all(|byte| byte.is_ascii_hexdigit())
                && paths.insert(&guard.path),
            "project_knowledge_source_guard_invalid"
        );
    }
    Ok(())
}

/// Archive/check/sync recheck the candidate's original source versions without upgrading them.
pub(crate) fn source_guard_errors(
    workspace: &Path,
    guards: &[ProjectKnowledgeSourceGuard],
) -> Result<Vec<String>> {
    if guards.is_empty() {
        return Ok(Vec::new());
    }
    validate_source_guards(guards)?;
    let result = guards.iter().filter_map(|guard| {
        let check = || -> Result<String> {
            let mut parent = PrivateDirectory::open_existing(workspace)?;
            let relative = Path::new(&guard.path);
            for component in relative.parent().into_iter().flat_map(Path::components) {
                if let Component::Normal(component) = component { parent = parent.open_child(component, false)?; }
            }
            Ok(parent.read_source_document_snapshot(relative.file_name().context("missing source name")?, MAX_KNOWLEDGE_BYTES as u64, || true)?.sha256)
        };
        match check() {
            Ok(revision) if revision == guard.revision => None,
            Ok(_) => Some(format!("project_knowledge_stale_revision: {} changed after the candidate read; reread and confirm a new candidate/change, do not upgrade the old source guard", guard.path)),
            Err(error) => Some(format!("project_knowledge_source_unavailable: {}: {error:#}", guard.path)),
        }
    }).collect();
    Ok(result)
}

/// Bind the guard to the same input bytes the existing publication transaction will protect.
pub(crate) fn check_prepared_source_guards(
    guards: &[ProjectKnowledgeSourceGuard],
    inputs: &[(PathBuf, Vec<u8>)],
) -> Result<()> {
    if guards.is_empty() {
        return Ok(());
    }
    validate_source_guards(guards)?;
    for guard in guards {
        let relative = Path::new(&guard.path).strip_prefix(crate::SPECS_DIR)?;
        let bytes = inputs
            .iter()
            .find(|(path, _)| path == relative)
            .map(|(_, bytes)| bytes)
            .context("project_knowledge_source_unavailable_in_publication")?;
        ensure!(
            hash(bytes) == guard.revision,
            "project_knowledge_stale_revision: {} changed before publication preparation",
            guard.path
        );
    }
    Ok(())
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn classify(path: &str) -> Result<ProjectKnowledgeKind> {
    ensure!(
        !path.is_empty()
            && !path.contains(['\\', ':', '\0'])
            && !path.chars().any(char::is_control)
            && path
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..")
            && Path::new(path)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            && Path::new(path).extension() == Some(OsStr::new("md")),
        "project_knowledge_path: expected a project-relative Markdown path without traversal or links"
    );
    if let Some(relative) = path.strip_prefix(".kcoder/specs/specs/") {
        ensure!(
            relative.contains('/'),
            "project_knowledge_path: expected an owning spec domain"
        );
        return Ok(ProjectKnowledgeKind::AuthoritativeSpec);
    }
    if path.starts_with(".kcoder/specs/changes/archive/") {
        return Ok(ProjectKnowledgeKind::HistoricalChange);
    }
    if path.starts_with(".kcoder/specs/changes/") {
        return Ok(ProjectKnowledgeKind::CandidateSpec);
    }
    ensure!(
        !path.split('/').any(|part| part.starts_with('.')),
        "project_knowledge_path: hidden state and skills are not project document sources; use the existing owning tool"
    );
    Ok(ProjectKnowledgeKind::ProjectDocument)
}

fn proposed_delta(before: &str, after: &str) -> Result<String> {
    let before = crate::parse_spec(before, "project")?;
    let after = crate::parse_spec(after, &before.domain)?;
    ensure!(
        before.domain == after.domain,
        "project_knowledge_domain_changed: reconcile domain moves in the existing Specs workflow"
    );
    let extras = |spec: &crate::Spec| {
        spec.sections
            .iter()
            .filter(|(title, _)| title != "Purpose" && title != "Requirements")
            .cloned()
            .collect::<Vec<_>>()
    };
    ensure!(
        extras(&before) == extras(&after),
        "project_knowledge_delta_requires_manual_reconciliation: non-requirement sections changed; use the existing Specs review workflow"
    );
    ensure!(
        after
            .sections
            .iter()
            .any(|(title, _)| title == "Requirements"),
        "project_knowledge_delta_requires_requirements_section"
    );
    ensure!(
        before.purpose == after.purpose || before.purpose.trim().is_empty(),
        "project_knowledge_purpose_requires_manual_reconciliation: the existing delta workflow only fills an empty Purpose; it does not replace an established Purpose"
    );
    let mut delta = String::new();
    if before.purpose != after.purpose {
        delta.push_str(&format!("## Purpose\n\n{}\n\n", after.purpose));
    }
    for (heading, requirements) in [
        (
            "ADDED",
            after
                .requirements
                .iter()
                .filter(|new| !before.requirements.iter().any(|old| old.name == new.name))
                .collect::<Vec<_>>(),
        ),
        (
            "MODIFIED",
            after
                .requirements
                .iter()
                .filter(|new| {
                    before
                        .requirements
                        .iter()
                        .any(|old| old.name == new.name && old.raw != new.raw)
                })
                .collect(),
        ),
    ] {
        if !requirements.is_empty() {
            delta.push_str(&format!("## {heading} Requirements\n\n"));
            for requirement in requirements {
                delta.push_str(requirement.raw.trim());
                delta.push_str("\n\n");
            }
        }
    }
    let removed = before
        .requirements
        .iter()
        .filter(|old| !after.requirements.iter().any(|new| new.name == old.name))
        .collect::<Vec<_>>();
    if !removed.is_empty() {
        delta.push_str("## REMOVED Requirements\n\n");
        for requirement in removed {
            delta.push_str(&format!("### Requirement: {}\n\n", requirement.name));
        }
    }
    Ok(delta)
}

#[cfg(test)]
#[path = "project_knowledge_tests.rs"]
mod tests;
