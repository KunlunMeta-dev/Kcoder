//! Distillation input bounds and the strict output contract (plan section 8).
//!
//! The model only summarizes evidence. Its output is parsed against a fixed
//! schema with unknown fields rejected; anything invalid is discarded as a
//! whole instead of being repaired. Support counts are recomputed by the
//! caller from the cited evidence; the model's own numbers are not trusted.

use kcoder_types::evolution::{
    LessonRevision, OutcomeCategory, ProposalChanges, ProposalExample, TargetKey,
    validate_evolution_id,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Evidence snippets sampled per category.
pub const DISTILL_EVIDENCE_PER_CATEGORY: usize = 8;
/// Total evidence bytes given to one distillation.
pub const DISTILL_EVIDENCE_MAX_BYTES: usize = 24 * 1024;
/// Patterns accepted from one distillation.
pub const DISTILL_MAX_PATTERNS: usize = 8;
const STATEMENT_MAX_CHARS: usize = 600;
const LESSON_MAX_CHARS: usize = 600;
const LIST_MAX_ITEMS: usize = 12;
const EXAMPLE_MAX_ITEMS: usize = 3;
const EXAMPLE_TEXT_MAX_CHARS: usize = 2000;
const NAME_MAX_CHARS: usize = 80;

/// One sampled evidence snippet offered to the distiller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceSample {
    pub evidence_id: String,
    /// Category label such as `correction:structure` or `procedure:failure`.
    pub category: String,
    pub text: String,
}

/// Pick at most [`DISTILL_EVIDENCE_PER_CATEGORY`] snippets per category and
/// at most [`DISTILL_EVIDENCE_MAX_BYTES`] in total, newest first within a
/// category and round-robin across categories so no category starves.
pub fn sample_evidence(mut candidates: Vec<EvidenceSample>) -> Vec<EvidenceSample> {
    use std::collections::BTreeMap;
    let mut by_category: BTreeMap<String, Vec<EvidenceSample>> = BTreeMap::new();
    // Callers pass oldest first; reverse so the newest is taken first.
    candidates.reverse();
    let mut seen = std::collections::HashSet::new();
    for sample in candidates {
        if !seen.insert(sample.evidence_id.clone()) {
            continue;
        }
        let bucket = by_category.entry(sample.category.clone()).or_default();
        if bucket.len() < DISTILL_EVIDENCE_PER_CATEGORY {
            bucket.push(sample);
        }
    }
    let mut selected = Vec::new();
    let mut bytes = 0usize;
    let mut round = 0usize;
    loop {
        let mut progressed = false;
        for bucket in by_category.values() {
            let Some(sample) = bucket.get(round) else {
                continue;
            };
            progressed = true;
            let size = sample.text.len() + sample.category.len() + sample.evidence_id.len();
            if bytes + size > DISTILL_EVIDENCE_MAX_BYTES {
                continue;
            }
            bytes += size;
            selected.push(sample.clone());
        }
        if !progressed {
            break;
        }
        round += 1;
    }
    selected
}

/// Where a distilled item is meant to go; the final scope is still decided
/// by code from the recomputed support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DistilledPatternKind {
    /// Concerns only this target (overlay lesson).
    Target,
    /// A procedure such as "run X before Y" (needs an adoption contrast).
    Procedure,
    /// A user habit that applies across targets (preference).
    Preference,
    /// A fact about the current project (project knowledge candidate).
    ProjectKnowledge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistilledSupport {
    pub usages: u32,
    pub sessions: u32,
    pub users: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistilledPattern {
    pub id: String,
    pub kind: DistilledPatternKind,
    pub categories: Vec<OutcomeCategory>,
    pub statement: String,
    /// Reported by the model; informational only.
    pub support: DistilledSupport,
    pub counter_evidence: u32,
    #[serde(default)]
    pub related_targets: Vec<TargetKey>,
    pub evidence_ids: Vec<String>,
    /// Procedure patterns: the evidence compares outcomes before and after
    /// adopting the procedure.
    #[serde(default)]
    pub adoption_contrast: bool,
}

/// A preference statement for `pref.<scope>.<category>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistilledPreference {
    pub pattern_id: String,
    /// `global` or a target domain.
    pub scope: String,
    pub category: String,
    pub value: String,
}

/// A project knowledge candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistilledKnowledge {
    pub pattern_id: String,
    pub title: String,
    pub content: String,
    pub category: String,
}

/// Overlay changes for the distilled target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistilledProposal {
    pub target_key: TargetKey,
    #[serde(default)]
    pub lessons_add: Vec<String>,
    #[serde(default)]
    pub lessons_revise: Vec<LessonRevision>,
    #[serde(default)]
    pub lessons_remove: Vec<String>,
    #[serde(default)]
    pub checklist_edits: Vec<String>,
    #[serde(default)]
    pub examples: Vec<ProposalExample>,
}

impl DistilledProposal {
    pub fn changes(&self) -> ProposalChanges {
        ProposalChanges {
            lessons_add: self.lessons_add.clone(),
            lessons_revise: self.lessons_revise.clone(),
            lessons_remove: self.lessons_remove.clone(),
            checklist_edits: self.checklist_edits.clone(),
            examples: self.examples.clone(),
            diff: None,
        }
    }

    /// Every learned text this proposal would introduce.
    pub fn introduced_texts(&self) -> Vec<&str> {
        let mut texts: Vec<&str> = self.lessons_add.iter().map(String::as_str).collect();
        texts.extend(self.lessons_revise.iter().map(|item| item.to.as_str()));
        texts.extend(self.checklist_edits.iter().map(String::as_str));
        texts.extend(self.examples.iter().map(|item| item.text.as_str()));
        texts
    }
}

/// The complete distiller output.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistillOutput {
    pub patterns: Vec<DistilledPattern>,
    #[serde(default)]
    pub proposal: Option<DistilledProposal>,
    #[serde(default)]
    pub preferences: Vec<DistilledPreference>,
    #[serde(default)]
    pub project_knowledge: Vec<DistilledKnowledge>,
}

/// Why an output was discarded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DistillRejection(pub String);

impl std::fmt::Display for DistillRejection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn reject(reason: impl Into<String>) -> DistillRejection {
    DistillRejection(reason.into())
}

fn bounded_text(field: &str, value: &str, max_chars: usize) -> Result<(), DistillRejection> {
    let trimmed = value.trim();
    if trimmed.is_empty() || value.chars().count() > max_chars {
        return Err(reject(format!(
            "{field} must be non-empty and at most {max_chars} characters"
        )));
    }
    if value
        .chars()
        .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
    {
        return Err(reject(format!(
            "{field} must not contain control characters"
        )));
    }
    Ok(())
}

fn label(field: &str, value: &str) -> Result<(), DistillRejection> {
    validate_evolution_id("label", value)
        .map_err(|_| reject(format!("{field} must use the record id alphabet")))?;
    if value.len() > 64 {
        return Err(reject(format!("{field} must be at most 64 bytes")));
    }
    Ok(())
}

/// Parse and validate distiller output. `expected_target` is the target
/// being distilled; a proposal for any other key is out of bounds.
pub fn parse_distill_output(
    value: Value,
    expected_target: &TargetKey,
    offered_evidence: &[String],
) -> Result<DistillOutput, DistillRejection> {
    let output: DistillOutput =
        serde_json::from_value(value).map_err(|error| reject(format!("schema: {error}")))?;
    if output.patterns.len() > DISTILL_MAX_PATTERNS {
        return Err(reject(format!("at most {DISTILL_MAX_PATTERNS} patterns")));
    }
    let mut pattern_ids = std::collections::HashSet::new();
    for pattern in &output.patterns {
        if !pattern.id.starts_with("P-") {
            return Err(reject("pattern ids start with `P-`"));
        }
        label("patterns.id", &pattern.id)?;
        if !pattern_ids.insert(pattern.id.clone()) {
            return Err(reject("pattern ids must be unique"));
        }
        bounded_text(
            "patterns.statement",
            &pattern.statement,
            STATEMENT_MAX_CHARS,
        )?;
        if pattern.categories.is_empty() || pattern.categories.len() > 4 {
            return Err(reject("patterns.categories needs 1..=4 generic categories"));
        }
        if pattern.evidence_ids.is_empty() || pattern.evidence_ids.len() > 64 {
            return Err(reject("patterns.evidenceIds needs 1..=64 ids"));
        }
        if let Some(unknown) = pattern
            .evidence_ids
            .iter()
            .find(|id| !offered_evidence.contains(id))
        {
            return Err(reject(format!(
                "pattern {} cites evidence {unknown} that was not offered",
                pattern.id
            )));
        }
        if pattern.related_targets.len() > 16 {
            return Err(reject("patterns.relatedTargets has at most 16 keys"));
        }
    }
    if let Some(proposal) = &output.proposal {
        if &proposal.target_key != expected_target {
            return Err(reject(format!(
                "proposal targets {} but {} is being distilled",
                proposal.target_key, expected_target
            )));
        }
        for (field, items) in [
            ("lessonsAdd", &proposal.lessons_add),
            ("lessonsRemove", &proposal.lessons_remove),
            ("checklistEdits", &proposal.checklist_edits),
        ] {
            if items.len() > LIST_MAX_ITEMS {
                return Err(reject(format!(
                    "{field} has at most {LIST_MAX_ITEMS} items"
                )));
            }
            for item in items {
                bounded_text(field, item, LESSON_MAX_CHARS)?;
            }
        }
        if proposal.lessons_revise.len() > LIST_MAX_ITEMS {
            return Err(reject("lessonsRevise has at most 12 items"));
        }
        for revision in &proposal.lessons_revise {
            bounded_text("lessonsRevise.from", &revision.from, LESSON_MAX_CHARS)?;
            bounded_text("lessonsRevise.to", &revision.to, LESSON_MAX_CHARS)?;
        }
        if proposal.examples.len() > EXAMPLE_MAX_ITEMS {
            return Err(reject("examples has at most 3 items"));
        }
        for example in &proposal.examples {
            bounded_text("examples.name", &example.name, NAME_MAX_CHARS)?;
            bounded_text("examples.text", &example.text, EXAMPLE_TEXT_MAX_CHARS)?;
        }
    }
    if output.preferences.len() > DISTILL_MAX_PATTERNS
        || output.project_knowledge.len() > DISTILL_MAX_PATTERNS
    {
        return Err(reject("at most 8 preferences and 8 knowledge items"));
    }
    for preference in &output.preferences {
        if !pattern_ids.contains(&preference.pattern_id) {
            return Err(reject("preferences.patternId must name a pattern"));
        }
        label("preferences.scope", &preference.scope)?;
        label("preferences.category", &preference.category)?;
        bounded_text("preferences.value", &preference.value, STATEMENT_MAX_CHARS)?;
    }
    for knowledge in &output.project_knowledge {
        if !pattern_ids.contains(&knowledge.pattern_id) {
            return Err(reject("projectKnowledge.patternId must name a pattern"));
        }
        bounded_text("projectKnowledge.title", &knowledge.title, NAME_MAX_CHARS)?;
        bounded_text(
            "projectKnowledge.content",
            &knowledge.content,
            STATEMENT_MAX_CHARS,
        )?;
        label("projectKnowledge.category", &knowledge.category)?;
    }
    Ok(output)
}

/// JSON schema of [`DistillOutput`] for tool input and structured output.
pub fn distill_output_schema() -> Value {
    let categories = json!({
        "type": "array",
        "minItems": 1,
        "maxItems": 4,
        "items": {"enum": ["accuracy","missing","extra","structure","style","length","format","step","scope","other"]}
    });
    let text = |max: usize| json!({"type": "string", "minLength": 1, "maxLength": max});
    let list =
        |max: usize| json!({"type": "array", "maxItems": LIST_MAX_ITEMS, "items": text(max)});
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["patterns"],
        "properties": {
            "patterns": {
                "type": "array",
                "maxItems": DISTILL_MAX_PATTERNS,
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["id","kind","categories","statement","support","counterEvidence","evidenceIds"],
                    "properties": {
                        "id": {"type": "string", "pattern": "^P-[A-Za-z0-9_.:-]{1,62}$"},
                        "kind": {"enum": ["target","procedure","preference","project_knowledge"]},
                        "categories": categories,
                        "statement": text(STATEMENT_MAX_CHARS),
                        "support": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["usages","sessions","users"],
                            "properties": {
                                "usages": {"type": "integer", "minimum": 0},
                                "sessions": {"type": "integer", "minimum": 0},
                                "users": {"type": "integer", "minimum": 0}
                            }
                        },
                        "counterEvidence": {"type": "integer", "minimum": 0},
                        "relatedTargets": {"type": "array", "maxItems": 16, "items": {"type": "string"}},
                        "evidenceIds": {"type": "array", "minItems": 1, "maxItems": 64, "items": {"type": "string"}},
                        "adoptionContrast": {"type": "boolean"}
                    }
                }
            },
            "proposal": {
                "type": ["object", "null"],
                "additionalProperties": false,
                "required": ["targetKey"],
                "properties": {
                    "targetKey": {"type": "string"},
                    "lessonsAdd": list(LESSON_MAX_CHARS),
                    "lessonsRevise": {
                        "type": "array",
                        "maxItems": LIST_MAX_ITEMS,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["from","to"],
                            "properties": {"from": text(LESSON_MAX_CHARS), "to": text(LESSON_MAX_CHARS)}
                        }
                    },
                    "lessonsRemove": list(LESSON_MAX_CHARS),
                    "checklistEdits": list(LESSON_MAX_CHARS),
                    "examples": {
                        "type": "array",
                        "maxItems": EXAMPLE_MAX_ITEMS,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["name","text"],
                            "properties": {"name": text(NAME_MAX_CHARS), "text": text(EXAMPLE_TEXT_MAX_CHARS)}
                        }
                    }
                }
            },
            "preferences": {
                "type": "array",
                "maxItems": DISTILL_MAX_PATTERNS,
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["patternId","scope","category","value"],
                    "properties": {
                        "patternId": {"type": "string"},
                        "scope": {"type": "string"},
                        "category": {"type": "string"},
                        "value": text(STATEMENT_MAX_CHARS)
                    }
                }
            },
            "projectKnowledge": {
                "type": "array",
                "maxItems": DISTILL_MAX_PATTERNS,
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["patternId","title","content","category"],
                    "properties": {
                        "patternId": {"type": "string"},
                        "title": text(NAME_MAX_CHARS),
                        "content": text(STATEMENT_MAX_CHARS),
                        "category": {"type": "string"}
                    }
                }
            }
        }
    })
}
