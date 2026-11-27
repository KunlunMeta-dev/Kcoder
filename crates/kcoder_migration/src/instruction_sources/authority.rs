//! A foreign snapshot is data under an original receiving receipt, never a physical source grant.
use super::{
    grant::RootBinding, model::InstructionSourceSnapshot, portable::PortableInstructionGraph,
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub(super) type PortableRootObservations = (String, BTreeMap<String, bool>, BTreeMap<String, bool>);

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum SnapshotRoot {
    Physical(RootBinding),
    Received(Box<ReceivedRoot>),
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReceivedRoot {
    authority_kind: ReceivedKind,
    binding: crate::source_transfer::ReceivedInstructionGraphBinding,
    source: kcoder_types::migration::MigrationSourceKind,
    relative_cwd: String,
    directories: BTreeMap<String, bool>,
    markers: BTreeMap<String, bool>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
enum ReceivedKind {
    #[serde(rename = "received_instruction_graph")]
    InstructionGraph,
}
impl From<RootBinding> for SnapshotRoot {
    fn from(value: RootBinding) -> Self {
        Self::Physical(value)
    }
}
impl SnapshotRoot {
    pub(super) fn verify_consumer(&self, profile: &std::path::Path) -> Result<()> {
        if let Self::Received(root) = self {
            root.binding.verify_consumer(profile)?;
        }
        Ok(())
    }
    pub(super) fn received(
        binding: crate::source_transfer::ReceivedInstructionGraphBinding,
        source: kcoder_types::migration::MigrationSourceKind,
        relative_cwd: String,
        directories: BTreeMap<String, bool>,
        markers: BTreeMap<String, bool>,
    ) -> Result<Self> {
        ensure!(
            binding.source()? == source,
            "source_transfer_instruction_graph_changed"
        );
        Ok(Self::Received(Box::new(ReceivedRoot {
            authority_kind: ReceivedKind::InstructionGraph,
            binding,
            source,
            relative_cwd,
            directories,
            markers,
        })))
    }
    pub(super) fn physical(&self) -> Result<&RootBinding> {
        match self {
            Self::Physical(root) => Ok(root),
            Self::Received(_) => anyhow::bail!("migration_instruction_not_physical_source"),
        }
    }
    pub(super) fn is_received(&self) -> bool {
        matches!(self, Self::Received(_))
    }
    pub(super) fn source(&self) -> kcoder_types::migration::MigrationSourceKind {
        match self {
            Self::Physical(root) => root.source(),
            Self::Received(root) => root.source,
        }
    }
    pub(super) fn portable_observations(
        &self,
        snapshot: &InstructionSourceSnapshot,
    ) -> Result<PortableRootObservations> {
        Ok(match self {
            Self::Physical(root) => (
                root.relative(root.cwd())?,
                snapshot
                    .directories
                    .iter()
                    .map(|(path, d)| (path.clone(), d.identity.is_some()))
                    .collect(),
                snapshot
                    .markers
                    .iter()
                    .map(|(path, d)| (path.clone(), d.identity.is_some()))
                    .collect(),
            ),
            Self::Received(root) => (
                root.relative_cwd.clone(),
                root.directories.clone(),
                root.markers.clone(),
            ),
        })
    }
    pub(super) fn validate_shape(&self, snapshot: &InstructionSourceSnapshot) -> Result<()> {
        if let Self::Received(root) = self {
            ensure!(
                snapshot.version == 2
                    && snapshot.directories.is_empty()
                    && snapshot.markers.is_empty()
                    && snapshot
                        .observations
                        .values()
                        .all(|file| file.identity.is_none())
                    && root.binding.source()? == root.source,
                "source_transfer_instruction_graph_invalid"
            );
            super::read::parts(&root.relative_cwd)?;
            ensure!(
                root.directories.len() <= super::model::MAX_DIRECTORIES
                    && root.markers.len() <= 1024,
                "source_transfer_instruction_graph_invalid"
            );
            let mut bytes = 0usize;
            for key in root.directories.keys().chain(root.markers.keys()) {
                super::read::parts(key)?;
                bytes = bytes.saturating_add(2 * key.len() + 256);
            }
            ensure!(
                bytes <= 2 * super::model::MAX_METADATA_BYTES,
                "source_transfer_instruction_graph_invalid"
            );
        }
        Ok(())
    }
    pub(super) fn verify_graph_identity(&self, snapshot: &InstructionSourceSnapshot) -> Result<()> {
        if let Self::Received(root) = self {
            root.binding
                .verify_bytes(&PortableInstructionGraph::from_snapshot(snapshot)?.encode()?)?;
        }
        Ok(())
    }
    pub(super) fn verify_received(
        &self,
        snapshot: &InstructionSourceSnapshot,
        check: impl FnMut(u64) -> bool,
    ) -> Result<()> {
        let Self::Received(root) = self else {
            anyhow::bail!("migration_instruction_not_received_source")
        };
        self.verify_graph_identity(snapshot)?;
        root.binding.verify_payload(check)
    }
}
