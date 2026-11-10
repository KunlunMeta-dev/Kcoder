//! Transport carries only captured source data, never source or destination filesystem authority.
use super::{authority::SnapshotRoot, model::*, read};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io::Write};
use zeroize::Zeroizing;

pub(crate) const MAX_GRAPH_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const GRAPH_PARSER: &str = "scoped-instructions/v2";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableFile {
    relative: String,
    bytes: u64,
    sha256: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PortableInstructionGraph {
    version: u32,
    parser_revision: String,
    source: kcoder_types::migration::MigrationSourceKind,
    relative_cwd: String,
    directories: BTreeMap<String, bool>,
    markers: BTreeMap<String, bool>,
    observations: BTreeMap<String, PortableFile>,
    sources: Vec<EncodedSource>,
    candidates: Vec<Candidate>,
    complete_launch_chain: bool,
    dynamic_scope_present: bool,
}
impl PortableInstructionGraph {
    pub(crate) fn from_snapshot(snapshot: &InstructionSourceSnapshot) -> Result<Self> {
        snapshot.validate_payload()?;
        ensure!(
            snapshot.version == 2,
            "source_transfer_instruction_parser_unsupported"
        );
        let (relative_cwd, directories, markers) = snapshot.root.portable_observations(snapshot)?;
        let graph = Self {
            version: 1,
            parser_revision: GRAPH_PARSER.into(),
            source: snapshot.source(),
            relative_cwd,
            directories,
            markers,
            observations: snapshot
                .observations
                .iter()
                .map(|(path, observed)| {
                    (
                        path.clone(),
                        PortableFile {
                            relative: observed.relative.clone(),
                            bytes: observed.bytes,
                            sha256: observed.sha256.clone(),
                        },
                    )
                })
                .collect(),
            sources: snapshot.sources.clone(),
            candidates: snapshot.candidates.clone(),
            complete_launch_chain: snapshot.complete_launch_chain,
            dynamic_scope_present: snapshot.dynamic_scope_present,
        };
        graph.validate()?;
        Ok(graph)
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1 && self.parser_revision == GRAPH_PARSER,
            "source_transfer_instruction_parser_unsupported"
        );
        read::parts(&self.relative_cwd)?;
        ensure!(
            self.directories.len() <= MAX_DIRECTORIES
                && self.markers.len() <= 1024
                && self.observations.len() <= MAX_ENTRIES
                && self.sources.len() <= MAX_FILES
                && !self.candidates.is_empty()
                && self.candidates.len() <= MAX_FILES,
            "source_transfer_instruction_graph_invalid"
        );
        let mut metadata = 0usize;
        for key in self
            .directories
            .keys()
            .chain(self.markers.keys())
            .chain(self.observations.keys())
        {
            read::parts(key)?;
            metadata = metadata.saturating_add(2 * key.len() + 256);
        }
        ensure!(
            metadata <= 3 * MAX_METADATA_BYTES,
            "source_transfer_instruction_graph_invalid"
        );
        for (key, observed) in &self.observations {
            ensure!(
                key == &observed.relative
                    && observed.bytes <= MAX_FILE_BYTES as u64
                    && match &observed.sha256 {
                        Some(hash) =>
                            hash.len() == 64
                                && hash
                                    .bytes()
                                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                        None => observed.bytes == 0,
                    },
                "source_transfer_instruction_graph_invalid"
            );
        }
        for candidate in &self.candidates {
            ensure!(
                !candidate.id.is_empty()
                    && candidate.id.len() <= 160
                    && candidate
                        .id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
                "source_transfer_instruction_graph_invalid"
            );
        }
        Ok(())
    }
    pub(crate) fn source(&self) -> kcoder_types::migration::MigrationSourceKind {
        self.source
    }
    pub(crate) fn encode(&self) -> Result<Zeroizing<Vec<u8>>> {
        self.validate()?;
        bounded_encode(self, MAX_GRAPH_BYTES)
    }
    pub(crate) fn decode(bytes: &[u8]) -> Result<Self> {
        ensure!(
            bytes.len() <= MAX_GRAPH_BYTES,
            "source_transfer_instruction_graph_invalid"
        );
        let graph: Self = serde_json::from_slice(bytes)
            .map_err(|_| anyhow::anyhow!("source_transfer_instruction_graph_invalid"))?;
        graph.validate()?;
        // Native exports have one canonical representation; extra JSON whitespace is not a new recipe.
        ensure!(
            graph.encode()?.as_slice() == bytes,
            "source_transfer_instruction_graph_invalid"
        );
        Ok(graph)
    }
    pub(crate) fn into_snapshot(
        self,
        binding: crate::source_transfer::ReceivedInstructionGraphBinding,
    ) -> Result<InstructionSourceSnapshot> {
        self.validate()?;
        ensure!(
            binding.source()? == self.source,
            "source_transfer_instruction_graph_changed"
        );
        let root = SnapshotRoot::received(
            binding,
            self.source,
            self.relative_cwd,
            self.directories,
            self.markers,
        )?;
        let snapshot = InstructionSourceSnapshot {
            version: 2,
            root,
            directories: BTreeMap::new(),
            markers: BTreeMap::new(),
            observations: self
                .observations
                .into_iter()
                .map(|(key, file)| {
                    (
                        key,
                        FileObservation {
                            relative: file.relative,
                            identity: None,
                            bytes: file.bytes,
                            sha256: file.sha256,
                        },
                    )
                })
                .collect(),
            sources: self.sources,
            candidates: self.candidates,
            complete_launch_chain: self.complete_launch_chain,
            dynamic_scope_present: self.dynamic_scope_present,
        };
        snapshot.validate_payload()?;
        snapshot.root.verify_graph_identity(&snapshot)?;
        Ok(snapshot)
    }
}

pub(crate) fn bounded_encode(value: &impl Serialize, limit: usize) -> Result<Zeroizing<Vec<u8>>> {
    checked_encode(value, limit, &mut |_| true)
}
pub(crate) fn checked_encode(
    value: &impl Serialize,
    limit: usize,
    check: &mut dyn FnMut(u64) -> bool,
) -> Result<Zeroizing<Vec<u8>>> {
    struct Writer<'a> {
        bytes: Zeroizing<Vec<u8>>,
        limit: usize,
        next_check: usize,
        check: &'a mut dyn FnMut(u64) -> bool,
        cancelled: bool,
    }
    impl Write for Writer<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.bytes.len().saturating_add(bytes.len()) > self.limit {
                return Err(std::io::Error::other("instruction graph budget exceeded"));
            }
            let mut remaining = bytes;
            while !remaining.is_empty() {
                if self.bytes.len() >= self.next_check {
                    if !(self.check)(self.bytes.len() as u64) {
                        self.cancelled = true;
                        return Err(std::io::Error::other("source_transfer_cancelled"));
                    }
                    self.next_check = self.bytes.len().saturating_add(64 * 1024);
                }
                let count = remaining.len().min(self.next_check - self.bytes.len());
                self.bytes.extend_from_slice(&remaining[..count]);
                remaining = &remaining[count..];
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Writer {
        bytes: Zeroizing::new(Vec::new()),
        limit,
        next_check: 0,
        check,
        cancelled: false,
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| {
        anyhow::anyhow!(if writer.cancelled {
            "source_transfer_cancelled"
        } else {
            "source_transfer_instruction_graph_budget_exceeded"
        })
    })?;
    Ok(writer.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_checks_continue_inside_one_large_serde_string_write() {
        let content = "x".repeat(1024 * 1024);
        let mut checks = Vec::new();
        let result = checked_encode(&content, 2 * 1024 * 1024, &mut |bytes| {
            checks.push(bytes);
            bytes < 128 * 1024
        });
        assert_eq!(result.unwrap_err().to_string(), "source_transfer_cancelled");
        assert!(checks.contains(&(64 * 1024)) && checks.contains(&(128 * 1024)));
        assert!(checks.iter().all(|bytes| *bytes <= 128 * 1024));
    }
}
