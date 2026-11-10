use super::KnowledgeOwner;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeVisibility {
    Personal,
    Project,
    Department,
    Organization,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationSource {
    pub library_id: String,
    pub page_id: String,
    pub page_revision: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationDraft {
    pub publication_id: String,
    pub title: String,
    #[serde(default)]
    pub purpose: Option<String>,
    /// Publisher-provided review notes; this is not an independent approval or authority grant.
    #[serde(default)]
    pub review_conclusion: Option<String>,
    pub visibility: KnowledgeVisibility,
    pub audience_id: Option<String>,
    pub sources: Vec<PublicationSource>,
    pub valid_from_ms: Option<u64>,
    pub valid_until_ms: Option<u64>,
    pub unresolved: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishedKnowledgePage {
    pub source: PublicationSource,
    pub title: String,
    pub markdown: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgePublication {
    pub owner: KnowledgeOwner,
    /// Native permission context observed at publication, never a client-selected role.
    #[serde(default)]
    pub publisher_role: Option<String>,
    pub version: u64,
    pub draft: PublicationDraft,
    pub pages: Vec<PublishedKnowledgePage>,
    pub published_at_ms: u64,
    pub revoked: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationHit {
    pub publication_id: String,
    pub version: u64,
    pub source: PublicationSource,
    pub title: String,
    pub excerpt: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeRetrievalOutcome {
    Matched,
    NoMatch,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeRetrieval {
    pub outcome: KnowledgeRetrievalOutcome,
    pub hits: Vec<PublicationHit>,
    pub observed_at_ms: u64,
}

/// A user's explicit fixed-version selection; it never preserves a revoked source read grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeAdoption {
    pub id: String,
    pub owner: KnowledgeOwner,
    pub revision: u64,
    pub publication_owner: KnowledgeOwner,
    pub publication_id: String,
    pub publication_version: u64,
    pub enabled: bool,
    pub adopted_at_ms: u64,
    pub updated_at_ms: u64,
}

/// Owner management metadata only; expired or revoked versions never expose page bodies here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgePublicationSummary {
    pub owner: KnowledgeOwner,
    pub publication_id: String,
    pub version: u64,
    pub title: String,
    pub purpose: Option<String>,
    pub publisher_role: Option<String>,
    pub published_at_ms: u64,
    pub valid_from_ms: Option<u64>,
    pub valid_until_ms: Option<u64>,
    pub revoked: bool,
}

/// Current lifecycle observation of a fixed source; it never rewrites publication contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeSourceObservation {
    pub source: PublicationSource,
    pub available: bool,
    pub removed: bool,
    pub archived: bool,
    pub observed_at_ms: u64,
}
