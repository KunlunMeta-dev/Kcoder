//! Only known guide files are read; directory metadata discovery never copies a worktree.
use super::{grant::InstructionSourceGrant, model::*, read};
use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_types::migration::MigrationSourceKind;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    ffi::OsStr,
};

struct Capture<'a, F> {
    version: u32,
    grant: &'a InstructionSourceGrant,
    policy: &'a InstructionSourcePolicy,
    check: &'a mut F,
    directories: BTreeMap<String, DirectoryObservation>,
    observations: BTreeMap<String, FileObservation>,
    markers: BTreeMap<String, MarkerObservation>,
    sources: Vec<EncodedSource>,
    candidates: Vec<Candidate>,
    bytes: usize,
    entries: usize,
    metadata_bytes: usize,
}
impl InstructionSourceGrant {
    pub fn capture_sources(
        &self,
        policy: &InstructionSourcePolicy,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<InstructionSourceSnapshot> {
        self.capture_versioned(policy, &mut check, 1)
    }
    /// This is an explicit static-file subset, not observation of vendor runtime policy.
    pub fn capture_static_sources(
        &self,
        policy: &InstructionSourcePolicy,
        static_subset_confirmed: bool,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<InstructionSourceSnapshot> {
        ensure!(
            static_subset_confirmed,
            "migration_instruction_static_subset_confirmation_required"
        );
        self.capture_versioned(policy, &mut check, 2)
    }
    fn capture_versioned(
        &self,
        policy: &InstructionSourcePolicy,
        check: &mut impl FnMut(u64) -> bool,
        version: u32,
    ) -> Result<InstructionSourceSnapshot> {
        self.verify()?;
        policy.validate()?;
        let mut capture = Capture {
            version,
            grant: self,
            policy,
            check,
            directories: BTreeMap::new(),
            observations: BTreeMap::new(),
            markers: BTreeMap::new(),
            sources: Vec::new(),
            candidates: Vec::new(),
            bytes: 0,
            entries: 0,
            metadata_bytes: 0,
        };
        let relative = self.binding.relative(self.binding.cwd())?;
        let mut lineage = vec![String::new()];
        let mut joined = String::new();
        for component in read::parts(&relative)? {
            if !joined.is_empty() {
                joined.push('/');
            }
            joined.push_str(component);
            lineage.push(joined.clone());
        }
        let start = if self.binding.source() == MigrationSourceKind::Codex {
            capture.codex_start(&lineage)?
        } else {
            0
        };
        for (at, path) in lineage.iter().enumerate() {
            capture.visit(path, InstructionTrigger::Launch, at >= start)?;
        }
        if policy.include_descendants {
            capture.descendants(&relative)?;
        }
        self.verify()?;
        let launch = capture
            .candidates
            .iter()
            .filter(|row| row.trigger == InstructionTrigger::Launch)
            .collect::<Vec<_>>();
        let complete = !launch
            .iter()
            .any(|row| row.disposition == InstructionDisposition::RequiresReview)
            && (self.binding.source() != MigrationSourceKind::Codex
                || launch
                    .iter()
                    .filter(|row| row.disposition == InstructionDisposition::Selected)
                    .map(|row| row.bytes)
                    .sum::<u64>()
                    <= policy.codex_max_bytes);
        let dynamic = capture
            .candidates
            .iter()
            .any(|row| row.trigger != InstructionTrigger::Launch);
        let mut snapshot = InstructionSourceSnapshot {
            version,
            root: self.binding.clone().into(),
            directories: capture.directories,
            observations: capture.observations,
            markers: capture.markers,
            sources: capture.sources,
            candidates: capture.candidates,
            complete_launch_chain: complete,
            dynamic_scope_present: dynamic,
        };
        if version == 2 {
            super::format::capture(&mut snapshot, self, check)?;
            snapshot.complete_launch_chain &= !snapshot.candidates.iter().any(|row| {
                row.trigger == InstructionTrigger::Launch
                    && row.disposition == InstructionDisposition::RequiresReview
            });
        }
        self.verify()?;
        Ok(snapshot)
    }
}
impl<F: FnMut(u64) -> bool> Capture<'_, F> {
    fn active(&mut self) -> Result<()> {
        ensure!((self.check)(self.bytes as u64), "migration_cancelled");
        self.grant.verify()
    }
    fn file(
        &mut self,
        scope: &str,
        name: &str,
        role: InstructionRole,
        trigger: InstructionTrigger,
        selected: bool,
    ) -> Result<Option<usize>> {
        self.active()?;
        let path = join(scope, name);
        if self.observations.contains_key(&path) {
            return Ok(None);
        }
        let (observed, source) = read::read(
            &self.grant.binding,
            &path,
            &mut self.directories,
            self.check,
        )?;
        self.metadata_bytes = self.metadata_bytes.saturating_add(2 * path.len() + 256);
        ensure!(
            self.observations.len() < MAX_ENTRIES && self.metadata_bytes <= MAX_METADATA_BYTES,
            "migration_instruction_source_budget_exceeded"
        );
        self.observations.insert(path.clone(), observed);
        let Some(source) = source else {
            return Ok(None);
        };
        ensure!(
            self.candidates.len() < MAX_FILES,
            "migration_instruction_source_budget_exceeded"
        );
        let bytes = STANDARD
            .decode(&source.data)
            .map_err(|_| anyhow::anyhow!("migration_instruction_snapshot_invalid"))?;
        self.bytes = self
            .bytes
            .checked_add(bytes.len())
            .ok_or_else(|| anyhow::anyhow!("migration_instruction_source_budget_exceeded"))?;
        ensure!(
            self.bytes <= MAX_BYTES,
            "migration_instruction_source_budget_exceeded"
        );
        let disposition = match std::str::from_utf8(&bytes) {
            _ if self.version == 2 && !selected => InstructionDisposition::Shadowed,
            Err(_) => InstructionDisposition::RequiresReview,
            Ok(text) if text.contains('\0') => InstructionDisposition::RequiresReview,
            Ok(text) if text.trim().is_empty() => InstructionDisposition::Empty,
            Ok(text)
                if self.version == 1
                    && (crate::asset_adapter::frontmatter(text)
                        .map_or(true, |(fields, _)| !fields.is_empty())
                        || text.lines().any(|line| line.trim_start().starts_with('@'))) =>
            {
                InstructionDisposition::RequiresReview
            }
            Ok(_) if !selected => InstructionDisposition::Shadowed,
            Ok(_) => InstructionDisposition::Selected,
        };
        let index = self.candidates.len();
        self.candidates.push(Candidate {
            id: format!("instruction-{}", uuid::Uuid::new_v4().simple()),
            relative_path: path,
            relative_scope: scope.into(),
            role,
            trigger,
            disposition,
            bytes: bytes.len() as u64,
            rank: index as u32,
            reason_code: (self.version == 2
                && disposition == InstructionDisposition::RequiresReview)
                .then(|| "migration_instruction_encoding_requires_review".into()),
        });
        self.sources.push(source);
        Ok(Some(index))
    }
    fn visit(&mut self, scope: &str, trigger: InstructionTrigger, active: bool) -> Result<()> {
        self.active()?;
        if self.grant.binding.source() == MigrationSourceKind::ClaudeCode {
            let shared = self.file(scope, "CLAUDE.md", InstructionRole::Shared, trigger, active)?;
            let internal = self.file(
                scope,
                ".claude/CLAUDE.md",
                InstructionRole::Shared,
                trigger,
                active,
            )?;
            if let (Some(shared), Some(internal)) = (shared, internal) {
                // Current public documentation does not specify a safe flattening order for this pair.
                for index in [shared, internal] {
                    if self.candidates[index].disposition == InstructionDisposition::Selected {
                        self.candidates[index].disposition = InstructionDisposition::RequiresReview;
                    }
                }
            }
            self.file(
                scope,
                "CLAUDE.local.md",
                InstructionRole::Local,
                trigger,
                active,
            )?;
        } else {
            let mut chosen = false;
            for (name, role) in [
                ("AGENTS.override.md".to_owned(), InstructionRole::Override),
                ("AGENTS.md".to_owned(), InstructionRole::Ordinary),
            ]
            .into_iter()
            .chain(
                self.policy
                    .codex_fallback_names
                    .iter()
                    .cloned()
                    .map(|name| (name, InstructionRole::Fallback)),
            ) {
                if let Some(index) = self.file(scope, &name, role, trigger, active && !chosen)?
                    && self.candidates[index].disposition != InstructionDisposition::Empty
                {
                    chosen = true;
                }
            }
        }
        Ok(())
    }
    fn codex_start(&mut self, lineage: &[String]) -> Result<usize> {
        let mut found = None;
        for (at, path) in lineage.iter().enumerate() {
            self.active()?;
            for marker in &self.policy.codex_root_markers {
                let observed =
                    read::marker(&self.grant.binding, path, marker, &mut self.directories)?;
                if observed.identity.is_some() {
                    found = Some(at);
                }
                self.metadata_bytes = self
                    .metadata_bytes
                    .saturating_add(2 * observed.relative.len() + 256);
                ensure!(
                    self.metadata_bytes <= MAX_METADATA_BYTES,
                    "migration_instruction_source_budget_exceeded"
                );
                self.markers.insert(observed.relative.clone(), observed);
            }
        }
        // Without a project marker inside the grant, the known static default examines cwd only.
        Ok(found.unwrap_or(lineage.len() - 1))
    }
    fn descendants(&mut self, cwd: &str) -> Result<()> {
        let mut queue = VecDeque::from([(cwd.to_owned(), 0usize)]);
        let mut visited = BTreeSet::new();
        while let Some((scope, depth)) = queue.pop_front() {
            self.active()?;
            ensure!(
                visited.insert(scope.clone()) && visited.len() <= MAX_DIRECTORIES,
                "migration_instruction_source_budget_exceeded"
            );
            let Some(directory) =
                read::open_directory(&self.grant.binding, &scope, &mut self.directories)?
            else {
                anyhow::bail!("migration_instruction_source_changed")
            };
            ensure!(
                self.entries < MAX_ENTRIES,
                "migration_instruction_source_budget_exceeded"
            );
            let mut names = Vec::new();
            let mut visited_names = 0usize;
            let progress = self.bytes as u64;
            directory.visit_entry_names_bounded(MAX_ENTRIES - self.entries, |name| {
                visited_names += 1;
                if visited_names.is_multiple_of(64) {
                    ensure!((self.check)(progress), "migration_cancelled");
                }
                names.push(name.to_os_string());
                Ok(())
            })?;
            names.sort();
            for name in names {
                self.entries += 1;
                if self.entries.is_multiple_of(64) {
                    self.active()?;
                }
                ensure!(
                    self.entries <= MAX_ENTRIES,
                    "migration_instruction_source_budget_exceeded"
                );
                let name = name
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("migration_instruction_path_unsupported"))?;
                if [
                    ".git",
                    ".hg",
                    ".svn",
                    ".claude",
                    ".codex",
                    ".agents",
                    ".kcoder",
                    ".config",
                    ".cache",
                    ".ssh",
                    ".aws",
                    "node_modules",
                    "target",
                    "dist",
                    "build",
                    ".venv",
                    "__pycache__",
                ]
                .contains(&name)
                {
                    continue;
                }
                let metadata = directory.entry_metadata(OsStr::new(name))?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    continue;
                }
                ensure!(depth < 16, "migration_instruction_source_budget_exceeded");
                let relative = join(&scope, name);
                let trigger = match self.grant.binding.source() {
                    MigrationSourceKind::ClaudeCode => InstructionTrigger::OnRead,
                    MigrationSourceKind::Codex => InstructionTrigger::OnCwd,
                };
                self.visit(&relative, trigger, true)?;
                queue.push_back((relative, depth + 1));
            }
        }
        Ok(())
    }
}
fn join(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.into()
    } else {
        format!("{parent}/{name}")
    }
}
