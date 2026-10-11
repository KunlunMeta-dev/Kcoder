//! Host-owned source prose keeps the immutable extracted scope and ordering.
use super::*;

/// Validated ingestion chunks are at most 16KiB. Eight full chunks plus join
/// delimiters fit below 1MiB; the body keeps every byte, while citations need not
/// serialize the full raw source a second time.
pub(super) fn short_quote(text: &str) -> String {
    text.trim_start().chars().take(160).collect()
}

pub(super) fn preserve_source_pages(
    proposal: &mut WikiProposal,
    chunks: &[crate::SourceChunk],
    source: &str,
    revision: &str,
    title: &str,
) -> Result<()> {
    let body = chunks
        .iter()
        .map(|chunk| chunk.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    ensure!(
        body.len() <= WIKI_MAX_PAGE_BYTES,
        "extractive source page exceeds budget"
    );
    ensure!(
        chunks.iter().all(|chunk| chunk.text.len() <= 16 * 1024),
        "extractive source citation exceeds budget"
    );
    for page in &mut proposal.pages {
        if page.kind == KnowledgePageKind::Source && page.expected_revision.is_none() {
            page.title = format!(
                "{} · {}–{}",
                title.chars().take(210).collect::<String>(),
                chunks[0].ordinal,
                chunks.last().unwrap().ordinal
            );
            page.markdown = body.clone();
            page.citations = chunks
                .iter()
                .filter(|chunk| !chunk.text.trim().is_empty())
                .map(|chunk| KnowledgeCitation {
                    source_id: source.into(),
                    revision_id: revision.into(),
                    chunk_id: chunk.chunk_id.clone(),
                    quote: short_quote(&chunk.text),
                })
                .collect();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blank_physical_page_is_preserved_without_an_empty_citation() -> Result<()> {
        let chunks = vec![
            crate::SourceChunk {
                ordinal: 1,
                chunk_id: "chunk-1".into(),
                first_line: 1,
                last_line: 1,
                page: Some(1),
                text: "First page evidence.".into(),
            },
            crate::SourceChunk {
                ordinal: 2,
                chunk_id: "chunk-2".into(),
                first_line: 2,
                last_line: 3,
                page: Some(2),
                text: " \n".into(),
            },
            crate::SourceChunk {
                ordinal: 3,
                chunk_id: "chunk-3".into(),
                first_line: 4,
                last_line: 4,
                page: Some(3),
                text: "Third page evidence.".into(),
            },
        ];
        let mut proposal = WikiProposal {
            pages: vec![page(KnowledgePageKind::Source, None)],
            review_notes: vec![],
            advisory_notes: vec![],
            organization_proof: None,
        };
        preserve_source_pages(&mut proposal, &chunks, "s", "r", "Original")?;
        assert_eq!(
            proposal.pages[0].markdown,
            "First page evidence.\n\n \n\n\nThird page evidence."
        );
        assert_eq!(
            proposal.pages[0]
                .citations
                .iter()
                .map(|citation| citation.chunk_id.as_str())
                .collect::<Vec<_>>(),
            ["chunk-1", "chunk-3"]
        );
        assert!(
            proposal.pages[0]
                .citations
                .iter()
                .all(|citation| !citation.quote.trim().is_empty())
        );
        Ok(())
    }
    fn page(kind: KnowledgePageKind, revision: Option<&str>) -> KnowledgePageDraft {
        KnowledgePageDraft {
            page_id: "p".into(),
            expected_revision: revision.map(String::from),
            kind,
            title: "Source".into(),
            markdown: "P100/12h belongs to Abstract BLEU experiments".into(),
            citations: vec![],
            related_page_ids: vec![],
        }
    }
    #[test]
    fn complete_original_scope_replaces_only_new_source_prose() -> Result<()> {
        let chunks = vec![
            crate::SourceChunk {
                ordinal: 1,
                chunk_id: "a".into(),
                first_line: 1,
                last_line: 2,
                page: Some(1),
                text: "Abstract\nFrench BLEU 41.8; eight GPUs, 3.5 days.".into(),
            },
            crate::SourceChunk {
                ordinal: 2,
                chunk_id: "b".into(),
                first_line: 3,
                last_line: 4,
                page: Some(2),
                text: "Introduction\nEight P100 GPUs, 12 hours.".into(),
            },
        ];
        let old = page(KnowledgePageKind::Source, Some("human-revision"));
        let mut proposal = WikiProposal {
            pages: vec![page(KnowledgePageKind::Source, None), old.clone()],
            review_notes: vec!["blocking".into()],
            advisory_notes: vec![],
            organization_proof: None,
        };
        preserve_source_pages(&mut proposal, &chunks, "s", "immutable-r", "Original")?;
        assert_eq!(
            proposal.pages[0].markdown,
            "Abstract\nFrench BLEU 41.8; eight GPUs, 3.5 days.\n\nIntroduction\nEight P100 GPUs, 12 hours."
        );
        assert_eq!(proposal.pages[0].citations.len(), 2);
        assert!(
            proposal.pages[0]
                .citations
                .iter()
                .all(|citation| citation.revision_id == "immutable-r")
        );
        assert_eq!(proposal.pages[1], old);
        assert_eq!(proposal.review_notes, vec!["blocking"]);
        Ok(())
    }
    #[test]
    fn source_expansion_rejects_oversized_quote_instead_of_truncating_it() {
        let chunk = crate::SourceChunk {
            ordinal: 1,
            chunk_id: "a".into(),
            first_line: 1,
            last_line: 1,
            page: None,
            text: "x".repeat(16 * 1024 + 1),
        };
        let mut proposal = WikiProposal {
            pages: vec![page(KnowledgePageKind::Source, None)],
            review_notes: vec![],
            advisory_notes: vec![],
            organization_proof: None,
        };
        assert!(preserve_source_pages(&mut proposal, &[chunk], "s", "r", "Original").is_err());
        assert_eq!(
            proposal.pages[0].markdown,
            "P100/12h belongs to Abstract BLEU experiments"
        );
    }
    #[test]
    fn long_complete_topics_and_existing_updates_share_the_real_page_byte_limit() -> Result<()> {
        let mut long = page(KnowledgePageKind::Concept, None);
        long.markdown = "中".repeat(2001);
        let mut proposal = WikiProposal {
            pages: vec![long.clone()],
            review_notes: vec![],
            advisory_notes: vec![],
            organization_proof: None,
        };
        validate_candidate(&proposal, &[], &["p".into()], "overview")?;
        proposal.pages[0].markdown = "x".repeat(WIKI_MAX_PAGE_BYTES + 1);
        let error = validate_candidate(&proposal, &[], &["p".into()], "overview").unwrap_err();
        assert_eq!(
            error.downcast_ref::<WikiCandidateFailure>().unwrap().code,
            "wiki_candidate_page_bounds"
        );
        long.expected_revision = Some("base".into());
        let prior = StoredPage {
            revision_id: "base".into(),
            human_edited: false,
            draft: long.clone(),
        };
        proposal.pages = vec![long];
        validate_candidate(&proposal, &[prior], &[], "overview")?;
        proposal.pages = (0..3)
            .map(|index| {
                let mut value = page(KnowledgePageKind::Concept, None);
                value.page_id = format!("p{index}");
                value
            })
            .collect();
        let error = validate_candidate(&proposal, &[], &[], "overview").unwrap_err();
        assert_eq!(
            error.downcast_ref::<WikiCandidateFailure>().unwrap().code,
            "wiki_candidate_new_topic_count"
        );
        Ok(())
    }
}
