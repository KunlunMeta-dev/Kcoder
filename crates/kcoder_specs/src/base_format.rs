//! Guarded changes use required-field envelopes so older readers refuse to discard their proof.

use crate::project_knowledge::{ProjectKnowledgeSourceGuard, validate_source_guards};
use crate::{BaseSnapshot, ChangeMetadata, ChangeStatus, RequirementFingerprint};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

pub(crate) const GUARDED_BASE_FORMAT: &str = "project_knowledge_v2";

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct BaseSnapshotWire {
    requirements: RequirementsWire,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    knowledge_sources: Option<Vec<ProjectKnowledgeSourceGuard>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum RequirementsWire {
    Legacy(Vec<RequirementFingerprint>),
    Guarded(GuardedRequirements),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GuardedRequirements {
    format: String,
    entries: Vec<RequirementFingerprint>,
    knowledge_sources: Vec<ProjectKnowledgeSourceGuard>,
}

impl TryFrom<BaseSnapshotWire> for BaseSnapshot {
    type Error = anyhow::Error;

    fn try_from(wire: BaseSnapshotWire) -> Result<Self> {
        ensure!(
            wire.knowledge_sources
                .is_none_or(|sources| sources.is_empty()),
            "project_knowledge_unversioned_guarded_base: source guards require the guarded base format"
        );
        match wire.requirements {
            RequirementsWire::Legacy(requirements) => Ok(Self {
                requirements,
                knowledge_sources: Vec::new(),
            }),
            RequirementsWire::Guarded(guarded) => {
                ensure!(
                    guarded.format == GUARDED_BASE_FORMAT,
                    "project_knowledge_unknown_base_format: {}",
                    guarded.format
                );
                validate_source_guards(&guarded.knowledge_sources)?;
                Ok(Self {
                    requirements: guarded.entries,
                    knowledge_sources: guarded.knowledge_sources,
                })
            }
        }
    }
}

impl From<BaseSnapshot> for BaseSnapshotWire {
    fn from(snapshot: BaseSnapshot) -> Self {
        let requirements = if snapshot.knowledge_sources.is_empty() {
            RequirementsWire::Legacy(snapshot.requirements)
        } else {
            RequirementsWire::Guarded(GuardedRequirements {
                format: GUARDED_BASE_FORMAT.into(),
                entries: snapshot.requirements,
                knowledge_sources: snapshot.knowledge_sources,
            })
        };
        Self {
            requirements,
            knowledge_sources: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ChangeMetadataWire {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    schema: Option<SchemaWire>,
    created_at: String,
    #[serde(default)]
    status: ChangeStatus,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum SchemaWire {
    Legacy(String),
    Guarded(GuardedSchema),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GuardedSchema {
    name: String,
    required_base_format: String,
}

impl TryFrom<ChangeMetadataWire> for ChangeMetadata {
    type Error = anyhow::Error;

    fn try_from(wire: ChangeMetadataWire) -> Result<Self> {
        let (schema, requires_guarded_base) = match wire.schema {
            None => (None, false),
            Some(SchemaWire::Legacy(name)) => (Some(name), false),
            Some(SchemaWire::Guarded(guarded)) => {
                ensure!(
                    guarded.required_base_format == GUARDED_BASE_FORMAT,
                    "project_knowledge_unknown_required_base_format: {}",
                    guarded.required_base_format
                );
                (Some(guarded.name), true)
            }
        };
        Ok(Self {
            name: wire.name,
            title: wire.title,
            schema,
            created_at: wire.created_at,
            status: wire.status,
            requires_guarded_base,
        })
    }
}

impl From<ChangeMetadata> for ChangeMetadataWire {
    fn from(metadata: ChangeMetadata) -> Self {
        let schema = if metadata.requires_guarded_base {
            Some(SchemaWire::Guarded(GuardedSchema {
                name: metadata.schema.unwrap_or_else(|| "spec-driven".into()),
                required_base_format: GUARDED_BASE_FORMAT.into(),
            }))
        } else {
            metadata.schema.map(SchemaWire::Legacy)
        };
        Self {
            name: metadata.name,
            title: metadata.title,
            schema,
            created_at: metadata.created_at,
            status: metadata.status,
        }
    }
}

#[cfg(test)]
#[path = "project_knowledge_format_tests.rs"]
mod tests;
