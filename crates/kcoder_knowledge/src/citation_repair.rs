//! Repair model citation proposals against supplied immutable evidence only.
use crate::{SourceChunk, StoredPage, WikiProposal};
use serde_json::{Value, json};

pub(crate) fn errors(
    proposal: &WikiProposal,
    source: &str,
    revision: &str,
    chunks: &[SourceChunk],
    existing: &[StoredPage],
) -> Vec<Value> {
    let mut errors = Vec::new();
    for page in &proposal.pages {
        let previous = existing
            .iter()
            .find(|value| value.draft.page_id == page.page_id);
        if page.citations.is_empty() {
            errors.push(
                json!({"pageId":page.page_id,"reason":"Every page must cite supplied evidence"}),
            );
        }
        for (index, citation) in page.citations.iter().enumerate() {
            // Old evidence may be retained exactly; never invent old quotations
            // from sources that were not supplied in this generation context.
            if previous.is_some_and(|value| value.draft.citations.contains(citation)) {
                continue;
            }
            let reason = if citation.source_id != source || citation.revision_id != revision {
                Some(
                    "Use the exact supplied sourceId/revisionId, or preserve an existing citation unchanged",
                )
            } else if let Some(chunk) = chunks
                .iter()
                .find(|chunk| chunk.chunk_id == citation.chunk_id)
            {
                if citation.quote.trim().is_empty() || citation.quote.len() > 16 * 1024 {
                    Some("Quote must be nonempty and at most 16 KiB")
                } else if !chunk.text.contains(&citation.quote) {
                    Some(
                        "Quote must be an exact contiguous substring of this chunk, including PDF line breaks, spaces, hyphens and punctuation; never paraphrase or join separate spans",
                    )
                } else {
                    None
                }
            } else {
                Some("chunkId must identify one of the supplied source chunks")
            };
            if let Some(reason) = reason {
                errors.push(json!({"pageId":page.page_id,"citationIndex":index,"sourceId":citation.source_id,"revisionId":citation.revision_id,"chunkId":citation.chunk_id,"reason":reason}));
            }
            if errors.len() >= 32 {
                return errors;
            }
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
    #[test]
    fn pdf_whitespace_and_wrong_identity_fail_without_rewriting_quotes() {
        let citation = KnowledgeCitation {
            source_id: "s".into(),
            revision_id: "r".into(),
            chunk_id: "chunk-1".into(),
            quote: "incremental consistency".into(),
        };
        let mut proposal = WikiProposal {
            pages: vec![KnowledgePageDraft {
                page_id: "p".into(),
                expected_revision: None,
                kind: KnowledgePageKind::Concept,
                title: "Topic".into(),
                markdown: "Meaning".into(),
                citations: vec![citation],
                related_page_ids: vec![],
            }],
            review_notes: vec![],
        };
        let chunks = vec![SourceChunk {
            ordinal: 1,
            chunk_id: "chunk-1".into(),
            first_line: 1,
            last_line: 2,
            text: "incremental\nconsistency".into(),
            page: Some(1),
        }];
        assert_eq!(errors(&proposal, "s", "r", &chunks, &[]).len(), 1);
        assert_eq!(
            proposal.pages[0].citations[0].quote,
            "incremental consistency"
        );
        proposal.pages[0].citations[0].quote = "incremental\nconsistency".into();
        assert!(errors(&proposal, "s", "r", &chunks, &[]).is_empty());
        proposal.pages[0].citations[0].revision_id = "other".into();
        assert_eq!(errors(&proposal, "s", "r", &chunks, &[]).len(), 1);
    }
}
