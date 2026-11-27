//! Public, host-authored Wiki verification findings and pending source units.
//! These records never contain source text, model responses or credentials.
//! An unverified range is published content whose support was not confirmed;
//! it is never counted as verified.
use serde::{Deserialize, Serialize};

/// Why a published line range is not counted as verified.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WikiUnverifiedVerdict {
    /// The independent verification judged the range unsupported by its evidence.
    Unsupported,
    /// The independent verification could not decide.
    Uncertain,
    /// No usable verification verdict exists (budget, size or format limits).
    Unassessed,
}

/// One unverified range of a page body, in 1-based body line numbers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiUnverifiedRange {
    pub page_id: String,
    pub verdict: WikiUnverifiedVerdict,
    /// 0 denotes the page title; body ranges start at 1.
    pub first_line: usize,
    pub last_line: usize,
    /// Hash of the complete proposed body the range belongs to.
    pub body_hash: String,
    pub code: String,
}

/// A required source unit that no published topic page organizes yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiPendingUnitRecord {
    pub source_id: String,
    pub source_revision: String,
    pub unit_id: String,
    pub chunk_ids: Vec<String>,
    /// Absolute source line range covered by the unit.
    pub first_line: usize,
    pub last_line: usize,
    pub reason_code: String,
}

/// An update of an existing page that was not published; its revision stays current.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiWithheldUpdate {
    pub page_id: String,
    pub expected_revision: String,
    pub code: String,
}

/// Private per-batch publication facts saved beside the checkpoint and written
/// in the same transaction as the page commit.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiPublicationFindings {
    #[serde(default)]
    pub verified_units: usize,
    #[serde(default)]
    pub unverified: Vec<WikiUnverifiedRange>,
    #[serde(default)]
    pub pending: Vec<WikiPendingUnitRecord>,
    #[serde(default)]
    pub withheld: Vec<WikiWithheldUpdate>,
    #[serde(default)]
    pub tool_turns: u32,
    #[serde(default)]
    pub tool_calls: u32,
    /// Why the tool loop ended (for example `wiki_tool_turn_limit`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_end: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiUnverifiedCounts {
    pub unsupported: u32,
    pub uncertain: u32,
    pub unassessed: u32,
}

/// Aggregated committed outcome of a file-contract job. Unverified units are
/// reported separately and never included in `verified_units`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiJobOutcome {
    pub published_pages: u32,
    pub verified_units: u32,
    pub unverified: WikiUnverifiedCounts,
    pub pending_units: u32,
    pub withheld_updates: u32,
    pub tool_turns: u32,
    pub tool_calls: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WikiFindingDecisionKind {
    /// A person reviewed the range and confirms it is acceptable.
    Confirmed,
    /// A person dismissed the finding (for example after editing elsewhere).
    Dismissed,
}

/// A durable verification finding bound to one immutable page revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiVerificationFinding {
    pub finding_id: String,
    pub page_id: String,
    pub revision_id: String,
    pub job_id: String,
    pub verdict: WikiUnverifiedVerdict,
    pub code: String,
    pub first_line: usize,
    pub last_line: usize,
    pub body_hash: String,
    /// True while the finding's revision is still the page's current revision.
    pub current: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<WikiFindingDecisionKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at_ms: Option<u64>,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WikiPendingStatus {
    Open,
    /// An explicit organize job is processing this unit.
    Organizing,
    /// A later committed batch of an explicit organize job covered the unit.
    Resolved,
    Dismissed,
}

/// A durable pending unit. Pending units are never reorganized automatically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiPendingUnit {
    pub pending_id: String,
    pub job_id: String,
    pub source_id: String,
    pub source_revision: String,
    pub unit_id: String,
    pub chunk_ids: Vec<String>,
    pub first_line: usize,
    pub last_line: usize,
    pub reason_code: String,
    pub status: WikiPendingStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organize_job_id: Option<String>,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WikiPageVerificationStatus {
    /// Every assessed range of this revision was verified.
    Verified,
    /// Some ranges are unsupported/uncertain/unassessed and not yet confirmed.
    Partial,
    /// The revision was produced by the file contract but has no assessment.
    Unassessed,
    /// Revision predates verification findings (or was imported).
    Legacy,
    /// A person edited this revision; generated findings do not apply to it.
    HumanEdited,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiPageUnverifiedLines {
    pub first_line: usize,
    pub last_line: usize,
    pub verdict: WikiUnverifiedVerdict,
}

/// Page-read projection of the revision's open findings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiPageVerification {
    pub status: WikiPageVerificationStatus,
    #[serde(default)]
    pub unverified: Vec<WikiPageUnverifiedLines>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_are_conservative_and_unknown_fields_are_rejected() {
        let empty: WikiPublicationFindings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, WikiPublicationFindings::default());
        assert!(serde_json::from_str::<WikiPublicationFindings>(r#"{"verified":3}"#).is_err());
        let range = WikiUnverifiedRange {
            page_id: "p".into(),
            verdict: WikiUnverifiedVerdict::Unassessed,
            first_line: 2,
            last_line: 4,
            body_hash: "h".into(),
            code: "wiki_support_unassessed".into(),
        };
        let value = serde_json::to_value(&range).unwrap();
        assert_eq!(value["verdict"], "unassessed");
        assert_eq!(value["firstLine"], 2);
    }
}
