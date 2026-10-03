//! Validate model-proposed Wiki changes before any filesystem or database mutation.
use anyhow::{Result, ensure};
use kcoder_types::knowledge::KnowledgePageDraft;
use std::collections::{BTreeMap, BTreeSet};

/// Loaded by the host from the authorized library, not supplied by the model.
pub struct ExistingPage {
    pub revision: String,
    pub human_edited: bool,
}

/// Immutable, library-scoped source evidence resolved by the host.
pub struct EvidenceChunk {
    pub source_id: String,
    pub revision_id: String,
    pub chunk_id: String,
    pub text: String,
}

pub struct ValidatedChanges {
    pages: Vec<KnowledgePageDraft>,
    requires_review: bool,
}
impl ValidatedChanges {
    pub fn pages(&self) -> &[KnowledgePageDraft] {
        &self.pages
    }
    pub fn requires_review(&self) -> bool {
        self.requires_review
    }
}

/// Validation proves reference existence and optimistic concurrency, not factual
/// correctness. The commit must recheck base revisions in its write transaction.
pub fn validate_generated_changes(
    pages: Vec<KnowledgePageDraft>,
    existing: &BTreeMap<String, ExistingPage>,
    evidence: &[EvidenceChunk],
) -> Result<ValidatedChanges> {
    ensure!(
        !pages.is_empty() && pages.len() <= 32,
        "changeset must contain 1..32 pages"
    );
    let mut proposed = BTreeSet::new();
    let mut total_bytes = 0usize;
    for page in &pages {
        ensure!(
            uuid::Uuid::parse_str(&page.page_id).is_ok(),
            "invalid page id"
        );
        ensure!(proposed.insert(page.page_id.as_str()), "duplicate page id");
        ensure!(
            !page.title.trim().is_empty() && page.title.chars().count() <= 240,
            "invalid page title"
        );
        ensure!(
            !page.markdown.trim().is_empty() && page.markdown.len() <= crate::WIKI_MAX_PAGE_BYTES,
            "invalid page content size"
        );
        total_bytes = total_bytes.saturating_add(page.markdown.len());
        ensure!(
            total_bytes <= crate::WIKI_MAX_OUTPUT_BYTES,
            "changeset too large"
        );
    }
    let evidence: BTreeMap<_, _> = evidence
        .iter()
        .map(|chunk| {
            (
                (
                    chunk.source_id.as_str(),
                    chunk.revision_id.as_str(),
                    chunk.chunk_id.as_str(),
                ),
                chunk.text.as_str(),
            )
        })
        .collect();
    let mut requires_review = false;
    for page in &pages {
        match (
            existing.get(&page.page_id),
            page.expected_revision.as_deref(),
        ) {
            (None, None) => {}
            (Some(current), Some(expected)) if current.revision == expected => {
                requires_review |= current.human_edited
            }
            _ => anyhow::bail!("revision conflict"),
        }
        ensure!(
            !page.citations.is_empty() && page.citations.len() <= 128,
            "generated knowledge requires bounded source citations"
        );
        for citation in &page.citations {
            let text = evidence
                .get(&(
                    citation.source_id.as_str(),
                    citation.revision_id.as_str(),
                    citation.chunk_id.as_str(),
                ))
                .ok_or_else(|| anyhow::anyhow!("source citation not found"))?;
            ensure!(
                !citation.quote.trim().is_empty() && citation.quote.len() <= 16 * 1024,
                "invalid citation quote"
            );
            ensure!(
                text.contains(&citation.quote),
                "citation quote does not match source revision"
            );
        }
        ensure!(page.related_page_ids.len() <= 128, "too many related pages");
        for target in &page.related_page_ids {
            ensure!(
                target != &page.page_id,
                "self reference is not a related page"
            );
            ensure!(
                existing.contains_key(target) || proposed.contains(target.as_str()),
                "related page not found"
            );
        }
    }
    Ok(ValidatedChanges {
        pages,
        requires_review,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageKind};
    fn fixture() -> (KnowledgePageDraft, Vec<EvidenceChunk>) {
        (
            KnowledgePageDraft {
                page_id: uuid::Uuid::new_v4().to_string(),
                expected_revision: None,
                kind: KnowledgePageKind::Concept,
                title: "知识整理".into(),
                markdown: "保留原始证据。".into(),
                citations: vec![KnowledgeCitation {
                    source_id: "s1".into(),
                    revision_id: "v1".into(),
                    chunk_id: "c1".into(),
                    quote: "保留原始证据".into(),
                }],
                related_page_ids: vec![],
            },
            vec![EvidenceChunk {
                source_id: "s1".into(),
                revision_id: "v1".into(),
                chunk_id: "c1".into(),
                text: "知识整理应保留原始证据。".into(),
            }],
        )
    }
    #[test]
    fn stale_versions_and_fabricated_evidence_never_validate() {
        let (page, evidence) = fixture();
        assert!(
            validate_generated_changes(vec![page.clone()], &BTreeMap::new(), &evidence).is_ok()
        );
        let mut invalid = page.clone();
        invalid.citations[0].revision_id = "v2".into();
        assert!(validate_generated_changes(vec![invalid], &BTreeMap::new(), &evidence).is_err());
        let mut invalid = page.clone();
        invalid.citations[0].quote = "不存在的结论".into();
        assert!(validate_generated_changes(vec![invalid], &BTreeMap::new(), &evidence).is_err());
        let existing = BTreeMap::from([(
            page.page_id.clone(),
            ExistingPage {
                revision: "current".into(),
                human_edited: true,
            },
        )]);
        assert!(validate_generated_changes(vec![page.clone()], &existing, &evidence).is_err());
        let mut update = page;
        update.expected_revision = Some("current".into());
        assert!(
            validate_generated_changes(vec![update], &existing, &evidence)
                .unwrap()
                .requires_review()
        );
    }
    #[test]
    fn proposed_links_must_resolve_and_duplicate_writes_are_rejected() {
        let (mut page, evidence) = fixture();
        assert!(
            validate_generated_changes(
                vec![page.clone(), page.clone()],
                &BTreeMap::new(),
                &evidence
            )
            .is_err()
        );
        page.related_page_ids.push(uuid::Uuid::new_v4().to_string());
        assert!(validate_generated_changes(vec![page], &BTreeMap::new(), &evidence).is_err());
    }
}
