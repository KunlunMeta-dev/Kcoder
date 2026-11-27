//! Host-authored pages that complete every batch: the extractive source page
//! and, for a library without one, a deterministic navigation overview. Neither
//! adds factual synthesis, and neither runs over an existing overview.
use super::*;

pub(super) struct Window<'a> {
    pub source_id: &'a str,
    pub revision_id: &'a str,
    pub chunks: &'a [crate::SourceChunk],
    pub source_title: &'a str,
    pub batch_identity: &'a [u8],
    pub through_chunk: usize,
}

fn window_citations(window: &Window<'_>) -> Vec<KnowledgeCitation> {
    window
        .chunks
        .iter()
        .map(|chunk| KnowledgeCitation {
            source_id: window.source_id.into(),
            revision_id: window.revision_id.into(),
            chunk_id: chunk.chunk_id.clone(),
            quote: ingest_source::short_quote(&chunk.text),
        })
        .collect()
}

/// Missing summaries must not discard the original evidence. A bounded
/// extractive source page is honest about its content, unlike treating an
/// unverified analysis summary as a supported fact.
pub(super) fn add_source_page(proposal: &mut WikiProposal, window: &Window<'_>) -> Result<()> {
    let has_source_summary = proposal.pages.iter().any(|page| {
        page.kind == KnowledgePageKind::Source
            && window.chunks.iter().all(|chunk| {
                page.citations.iter().any(|citation| {
                    citation.source_id == window.source_id
                        && citation.revision_id == window.revision_id
                        && citation.chunk_id == chunk.chunk_id
                        && !citation.quote.trim().is_empty()
                        && chunk.text.contains(&citation.quote)
                })
            })
    });
    if has_source_summary {
        return Ok(());
    }
    proposal.pages.push(KnowledgePageDraft {
        page_id: {
            let mut bytes = window.batch_identity.to_vec();
            bytes.push(9);
            uuid::Uuid::parse_str(&crate::objects::digest(&bytes)[..32])?.to_string()
        },
        expected_revision: None,
        kind: KnowledgePageKind::Source,
        title: format!(
            "{} · {}–{}",
            window.source_title.chars().take(210).collect::<String>(),
            window.chunks[0].ordinal,
            window.through_chunk
        ),
        markdown: window
            .chunks
            .iter()
            .map(|chunk| chunk.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
        citations: window_citations(window),
        related_page_ids: proposal
            .pages
            .iter()
            .map(|page| page.page_id.clone())
            .collect(),
    });
    Ok(())
}

fn escaped_title(title: &str) -> String {
    let mut escaped = String::new();
    for ch in title.chars() {
        if matches!(ch, '\n' | '\r') {
            escaped.push(' ');
        } else {
            if matches!(
                ch,
                '\\' | '[' | ']' | '`' | '*' | '_' | '~' | '<' | '>' | '#' | '!' | '|' | '(' | ')'
            ) {
                escaped.push('\\');
            }
            escaped.push(ch);
        }
    }
    escaped
}

/// Concurrent first batches reserve the same overview identity; the create-only
/// commit CAS rejects the losing batch instead of publishing a second overview.
pub(super) fn add_overview(
    proposal: &mut WikiProposal,
    window: &Window<'_>,
    overview_page_id: String,
) {
    if proposal
        .pages
        .iter()
        .any(|page| page.page_id == overview_page_id)
    {
        return;
    }
    let titles = proposal
        .pages
        .iter()
        .map(|page| format!("- {}", escaped_title(&page.title)))
        .collect::<Vec<_>>()
        .join("\n");
    proposal.pages.push(KnowledgePageDraft {
        page_id: overview_page_id,
        expected_revision: None,
        kind: KnowledgePageKind::Overview,
        title: "Wiki".into(),
        markdown: format!("# Wiki\n\n{titles}\n"),
        citations: window_citations(window),
        related_page_ids: proposal
            .pages
            .iter()
            .map(|page| page.page_id.clone())
            .collect(),
    });
}
