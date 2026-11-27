//! Static dependencies remain original bytes under the same pinned source root.
use super::super::{grant::InstructionSourceGrant, model::*, read};
use super::syntax::{self, Edit};
use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const MAX_IMPORT_DEPTH: usize = 4;
const MAX_VISITS: usize = 4096;

struct Node {
    text: String,
    edits: Vec<Edit>,
}
fn node(snapshot: &InstructionSourceSnapshot, path: &str) -> Result<Node> {
    let source = snapshot
        .sources
        .iter()
        .find(|source| source.relative == path)
        .ok_or_else(|| anyhow::anyhow!("migration_instruction_import_unavailable"))?;
    ensure!(
        source.data.len() <= MAX_FILE_BYTES.div_ceil(3) * 4,
        "migration_instruction_snapshot_invalid"
    );
    let bytes = STANDARD
        .decode(&source.data)
        .map_err(|_| anyhow::anyhow!("migration_instruction_snapshot_invalid"))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| anyhow::anyhow!("migration_instruction_import_encoding_requires_review"))?;
    ensure!(
        !text.contains('\0'),
        "migration_instruction_import_encoding_requires_review"
    );
    let edits = syntax::edits(&text)?;
    Ok(Node { text, edits })
}

/// Discovery never follows an unsupported proposal, even if another path outside the root exists.
pub(super) fn capture(
    snapshot: &mut InstructionSourceSnapshot,
    grant: &InstructionSourceGrant,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<()> {
    let mut pending = snapshot
        .candidates
        .iter()
        .filter(|candidate| candidate.disposition == InstructionDisposition::Selected)
        .map(|candidate| (candidate.relative_path.clone(), MAX_IMPORT_DEPTH))
        .collect::<VecDeque<_>>();
    let mut visited = BTreeMap::<String, usize>::new();
    let mut visits = 0;
    let mut bytes = snapshot
        .sources
        .iter()
        .map(|source| {
            snapshot
                .observations
                .get(&source.relative)
                .map_or(0, |observed| observed.bytes)
        })
        .sum::<u64>();
    while let Some((path, remaining)) = pending.pop_front() {
        ensure!(check(bytes), "migration_cancelled");
        grant.verify()?;
        visits += 1;
        ensure!(
            visits <= MAX_VISITS,
            "migration_instruction_source_budget_exceeded"
        );
        if visited
            .get(&path)
            .is_some_and(|previous| *previous >= remaining)
        {
            continue;
        }
        visited.insert(path.clone(), remaining);
        if !snapshot
            .sources
            .iter()
            .any(|source| source.relative == path)
        {
            let (observed, source) = read::read(
                snapshot.root.physical()?,
                &path,
                &mut snapshot.directories,
                check,
            )?;
            if let Some(original) = snapshot.observations.get(&path) {
                ensure!(
                    original == &observed,
                    "migration_instruction_source_changed"
                );
            } else {
                let metadata = snapshot
                    .observations
                    .keys()
                    .map(|key| 2 * key.len() + 256)
                    .sum::<usize>();
                ensure!(
                    snapshot.observations.len() < MAX_ENTRIES
                        && metadata.saturating_add(2 * path.len() + 256) <= MAX_METADATA_BYTES,
                    "migration_instruction_source_budget_exceeded"
                );
                snapshot.observations.insert(path.clone(), observed.clone());
            }
            let Some(source) = source else {
                continue;
            };
            bytes = bytes
                .checked_add(observed.bytes)
                .ok_or_else(|| anyhow::anyhow!("migration_instruction_source_budget_exceeded"))?;
            ensure!(
                snapshot.sources.len() < MAX_FILES && bytes <= MAX_BYTES as u64,
                "migration_instruction_source_budget_exceeded"
            );
            snapshot.sources.push(source);
        }
        let Ok(parsed) = node(snapshot, &path) else {
            continue;
        };
        if remaining == 0 {
            continue;
        }
        for edit in parsed.edits {
            if let Edit::Import { path: import, .. } = edit
                && let Ok(dependency) = syntax::resolve(&path, &import)
            {
                pending.push_back((dependency, remaining - 1));
                ensure!(
                    pending.len() <= MAX_VISITS,
                    "migration_instruction_source_budget_exceeded"
                );
            }
        }
    }
    snapshot.verify_source(check)
}

/// All rendering is pure over the captured source graph. No file may be refreshed while compiling.
pub(super) fn compile(snapshot: &InstructionSourceSnapshot, path: &str) -> Result<super::Compiled> {
    let mut output = String::new();
    let mut state = Render {
        snapshot,
        nodes: BTreeMap::new(),
        ancestors: BTreeSet::new(),
        visits: 0,
    };
    state.expand(path, 0, &mut output)?;
    let original = state.nodes.get(path).expect("expanded root");
    let exact_file_bytes = output == original.text;
    Ok(super::Compiled {
        text: output,
        exact_file_bytes,
    })
}
struct Render<'a> {
    snapshot: &'a InstructionSourceSnapshot,
    nodes: BTreeMap<String, Node>,
    ancestors: BTreeSet<String>,
    visits: usize,
}
impl Render<'_> {
    fn expand(&mut self, path: &str, depth: usize, output: &mut String) -> Result<()> {
        self.visits += 1;
        ensure!(
            self.visits <= MAX_VISITS && depth <= MAX_IMPORT_DEPTH,
            "migration_instruction_import_budget_requires_review"
        );
        ensure!(
            self.ancestors.insert(path.into()),
            "migration_instruction_import_cycle_requires_review"
        );
        if !self.nodes.contains_key(path) {
            self.nodes.insert(path.into(), node(self.snapshot, path)?);
        }
        // A node may be revisited through multiple parents; source bytes are decoded only once.
        let edits = self
            .nodes
            .get(path)
            .expect("inserted node")
            .edits
            .iter()
            .map(|edit| match edit {
                Edit::Import { range, path } => (range.clone(), Some(path.clone())),
                Edit::Comment(range) => (range.clone(), None),
            })
            .collect::<Vec<_>>();
        let mut start = 0;
        for (range, import) in edits {
            append(
                output,
                &self.nodes.get(path).expect("inserted node").text[start..range.start],
            )?;
            if let Some(import) = import {
                let dependency = syntax::resolve(path, &import)?;
                ensure!(
                    depth < MAX_IMPORT_DEPTH,
                    "migration_instruction_import_budget_requires_review"
                );
                self.expand(&dependency, depth + 1, output)?;
            }
            start = range.end;
        }
        append(
            output,
            &self.nodes.get(path).expect("inserted node").text[start..],
        )?;
        self.ancestors.remove(path);
        Ok(())
    }
}
fn append(output: &mut String, text: &str) -> Result<()> {
    ensure!(
        output.len().saturating_add(text.len()) <= MAX_FILE_BYTES,
        "migration_instruction_import_budget_requires_review"
    );
    output.push_str(text);
    Ok(())
}
