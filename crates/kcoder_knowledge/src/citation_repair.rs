//! Repair model citation proposals against supplied immutable evidence only.
use crate::{SourceChunk, StoredPage, WikiProposal, ingest::WikiCandidateFailure};
use serde_json::{Value, json};
use std::ops::Range;

const MAX_QUOTE_BYTES: usize = 16 * 1024;

pub(crate) struct CitationErrors {
    pub repair: Vec<Value>,
    pub failure: Option<WikiCandidateFailure>,
}

pub(crate) fn errors(
    proposal: &WikiProposal,
    source: &str,
    revision: &str,
    chunks: &[SourceChunk],
    existing: &[StoredPage],
) -> CitationErrors {
    let mut errors = CitationErrors {
        repair: Vec::new(),
        failure: None,
    };
    for (page_index, page) in proposal.pages.iter().enumerate() {
        let previous = existing
            .iter()
            .find(|value| value.draft.page_id == page.page_id);
        if page.citations.is_empty() {
            errors.push(
                json!({"pageId":page.page_id,"reason":"Every page must cite supplied evidence"}),
                "wiki_evidence_citations_bounds",
                format!("/pages/{page_index}/citations"),
            );
        }
        for (index, citation) in page.citations.iter().enumerate() {
            // Old evidence may be retained exactly; never invent old quotations
            // from sources that were not supplied in this generation context.
            if previous.is_some_and(|value| value.draft.citations.contains(citation)) {
                continue;
            }
            let reason = if citation.source_id != source {
                Some((
                    "Use the exact supplied sourceId/revisionId, or preserve an existing citation unchanged",
                    "wiki_evidence_source_not_supplied",
                    "sourceId",
                ))
            } else if citation.revision_id != revision {
                Some((
                    "Use the exact supplied sourceId/revisionId, or preserve an existing citation unchanged",
                    "wiki_evidence_revision_not_supplied",
                    "revisionId",
                ))
            } else if let Some(chunk) = chunks
                .iter()
                .find(|chunk| chunk.chunk_id == citation.chunk_id)
            {
                if citation.quote.trim().is_empty() || citation.quote.len() > MAX_QUOTE_BYTES {
                    Some((
                        "Quote must be nonempty and at most 16 KiB",
                        "wiki_evidence_quote_bounds",
                        "quote",
                    ))
                } else if !chunk.text.contains(&citation.quote) {
                    Some((
                        "Quote must be an exact contiguous substring of this chunk, including PDF line breaks, spaces, hyphens and punctuation; never paraphrase or join separate spans",
                        "wiki_evidence_quote_span",
                        "quote",
                    ))
                } else {
                    None
                }
            } else {
                Some((
                    "chunkId must identify one of the supplied source chunks",
                    "wiki_evidence_chunk_not_supplied",
                    "chunkId",
                ))
            };
            if let Some((reason, code, field)) = reason {
                errors.push(json!({"pageId":page.page_id,"citationIndex":index,"sourceId":citation.source_id,"revisionId":citation.revision_id,"chunkId":citation.chunk_id,"reason":reason}),
                    code, format!("/pages/{page_index}/citations/{index}/{field}"));
            }
            if errors.repair.len() >= 32 {
                return errors;
            }
        }
    }
    errors
}

/// Canonicalize only new model quotations whose HTML character encoding or whitespace differs from a
/// unique span in the exact supplied immutable source/revision/chunk. This does
/// not verify the page's claims or grant publication; existing validation still
/// requires the resulting raw quote to be a contiguous substring of evidence.
///
/// Exact matches and prior citations are untouched. Whitespace boundaries remain
/// present: this cannot join digits/words, remove hyphens, fold case or paraphrase.
pub(crate) fn normalize_new_citation_quotes(
    proposal: &mut WikiProposal,
    source: &str,
    revision: &str,
    chunks: &[SourceChunk],
    existing: &[StoredPage],
) -> usize {
    let mut changed = 0;
    for page in &mut proposal.pages {
        let previous = existing
            .iter()
            .find(|value| value.draft.page_id == page.page_id);
        for citation in &mut page.citations {
            if citation.source_id != source
                || citation.revision_id != revision
                || citation.quote.trim().is_empty()
                || citation.quote.len() > MAX_QUOTE_BYTES
            {
                continue;
            }
            let mut supplied = chunks
                .iter()
                .filter(|chunk| chunk.chunk_id == citation.chunk_id);
            let Some(chunk) = supplied.next() else {
                continue;
            };
            // Duplicate supplied IDs are not authority to choose an evidence body.
            if supplied.next().is_some() || chunk.text.contains(&citation.quote) {
                continue;
            }
            let pattern: Vec<char> = whitespace_tokens(&citation.quote)
                .iter()
                .map(|token| token.character)
                .collect();
            // Also leave whitespace-altered copies of prior evidence unresolved;
            // only the author can restore a retained prior citation verbatim.
            if previous.is_some_and(|value| {
                value.draft.citations.iter().any(|prior| {
                    prior.source_id == citation.source_id
                        && prior.revision_id == citation.revision_id
                        && prior.chunk_id == citation.chunk_id
                        && whitespace_tokens(&prior.quote)
                            .iter()
                            .map(|token| token.character)
                            .eq(pattern.iter().copied())
                })
            }) {
                continue;
            }
            if let Some(span) = unique_whitespace_span(&chunk.text, &pattern)
                && span.len() <= MAX_QUOTE_BYTES
            {
                citation.quote = chunk.text[span].to_owned();
                changed += 1;
            }
        }
    }
    changed
}

struct WhitespaceToken {
    character: char,
    start: usize,
    end: usize,
}

fn whitespace_tokens(text: &str) -> Vec<WhitespaceToken> {
    let mut tokens: Vec<WhitespaceToken> = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let raw = text[start..].chars().next().unwrap();
        let (character, width) = if raw == '&' {
            html_character(&text[start..]).unwrap_or((raw, raw.len_utf8()))
        } else {
            (raw, raw.len_utf8())
        };
        let end = start + width;
        if character.is_whitespace() {
            if let Some(previous) = tokens.last_mut()
                && previous.character == ' '
            {
                previous.end = end;
                start = end;
                continue;
            }
            tokens.push(WhitespaceToken {
                character: ' ',
                start,
                end,
            });
        } else {
            tokens.push(WhitespaceToken {
                character,
                start,
                end,
            });
        }
        start = end;
    }
    tokens
}

/// Decode one explicit character entity, never tags, percent escapes, syntax,
/// Unicode compatibility folds, or repeatedly nested encodings. Byte offsets
/// continue to identify the original immutable text, not its rendered copy.
fn html_character(text: &str) -> Option<(char, usize)> {
    let end = text
        .as_bytes()
        .iter()
        .take(16)
        .position(|byte| *byte == b';')?;
    let entity = &text[1..end];
    let character = match entity {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{a0}',
        "ndash" => '\u{2013}',
        "mdash" => '\u{2014}',
        "lsquo" => '\u{2018}',
        "rsquo" => '\u{2019}',
        "ldquo" => '\u{201c}',
        "rdquo" => '\u{201d}',
        _ => {
            let numeric = entity.strip_prefix('#')?;
            let value = if let Some(hex) = numeric
                .strip_prefix('x')
                .or_else(|| numeric.strip_prefix('X'))
            {
                u32::from_str_radix(hex, 16).ok()?
            } else {
                numeric.parse::<u32>().ok()?
            };
            char::from_u32(value)?
        }
    };
    if character.is_control() && !character.is_whitespace() {
        return None;
    }
    Some((character, end + 1))
}

/// KMP keeps repeated quotations bounded to linear work and detects overlapping
/// matches too. Token offsets always address original UTF-8 byte boundaries.
fn unique_whitespace_span(text: &str, pattern: &[char]) -> Option<Range<usize>> {
    if pattern.is_empty() {
        return None;
    }
    let mut prefix = vec![0; pattern.len()];
    for index in 1..pattern.len() {
        let mut length = prefix[index - 1];
        while length > 0 && pattern[index] != pattern[length] {
            length = prefix[length - 1];
        }
        if pattern[index] == pattern[length] {
            length += 1
        }
        prefix[index] = length;
    }
    let tokens = whitespace_tokens(text);
    let mut matched = 0;
    let mut unique = None;
    for (index, token) in tokens.iter().enumerate() {
        while matched > 0 && token.character != pattern[matched] {
            matched = prefix[matched - 1];
        }
        if token.character == pattern[matched] {
            matched += 1
        }
        if matched == pattern.len() {
            if unique.is_some() {
                return None;
            }
            unique = Some(tokens[index + 1 - matched].start..token.end);
            matched = prefix[matched - 1];
        }
    }
    unique
}

impl CitationErrors {
    fn push(&mut self, repair: Value, code: &'static str, field: String) {
        self.failure.get_or_insert(WikiCandidateFailure {
            stage: "citation_repair",
            code,
            field,
        });
        self.repair.push(repair);
    }
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
            advisory_notes: vec![],
            organization_proof: None,
        };
        let chunks = vec![SourceChunk {
            ordinal: 1,
            chunk_id: "chunk-1".into(),
            first_line: 1,
            last_line: 2,
            text: "incremental\nconsistency".into(),
            page: Some(1),
        }];
        assert_eq!(errors(&proposal, "s", "r", &chunks, &[]).repair.len(), 1);
        assert_eq!(
            proposal.pages[0].citations[0].quote,
            "incremental consistency"
        );
        proposal.pages[0].citations[0].quote = "incremental\nconsistency".into();
        assert!(errors(&proposal, "s", "r", &chunks, &[]).repair.is_empty());
        proposal.pages[0].citations[0].revision_id = "other".into();
        assert_eq!(errors(&proposal, "s", "r", &chunks, &[]).repair.len(), 1);
    }

    fn normalization_fixture(quote: &str, source_text: &str) -> (WikiProposal, Vec<SourceChunk>) {
        (
            WikiProposal {
                pages: vec![KnowledgePageDraft {
                    page_id: "p".into(),
                    expected_revision: None,
                    kind: KnowledgePageKind::Concept,
                    title: "Topic".into(),
                    markdown: "Unchanged page text".into(),
                    citations: vec![KnowledgeCitation {
                        source_id: "s".into(),
                        revision_id: "r".into(),
                        chunk_id: "chunk-1".into(),
                        quote: quote.into(),
                    }],
                    related_page_ids: vec![],
                }],
                review_notes: vec![],
                advisory_notes: vec![],
                organization_proof: None,
            },
            vec![SourceChunk {
                ordinal: 1,
                chunk_id: "chunk-1".into(),
                first_line: 1,
                last_line: 8,
                text: source_text.into(),
                page: Some(1),
            }],
        )
    }

    #[test]
    fn html_character_encoding_restores_unique_original_bytes_without_folding_facts() {
        for (quote, original) in [
            ("A & B < 3", "A &amp; B &lt; 3"),
            ("A &#38; B", "A & B"),
            ("甲 乙", "甲&#160;乙"),
            ("Revenue — unchanged", "Revenue &mdash; unchanged"),
        ] {
            let (mut proposal, chunks) = normalization_fixture(quote, original);
            assert_eq!(
                normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
                1
            );
            assert_eq!(proposal.pages[0].citations[0].quote, original);
            assert!(errors(&proposal, "s", "r", &chunks, &[]).repair.is_empty());
        }
        for (quote, original) in [
            ("A & B", "A & B; A &amp; B"),
            ("value < 2", "value &lt; 3"),
            ("Revenue - unchanged", "Revenue &mdash; unchanged"),
            ("A &amp;amp; B", "A & B"),
            ("a & B", "A &amp; B"),
        ] {
            let (mut proposal, chunks) = normalization_fixture(quote, original);
            assert_eq!(
                normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
                0
            );
            assert_eq!(proposal.pages[0].citations[0].quote, quote);
        }
    }

    #[test]
    fn unique_pdf_wrap_and_unicode_whitespace_restore_original_utf8_span() {
        let original = "甲\u{a0}\n\t乙\u{2009}结果 10.5\n单位";
        let (mut proposal, chunks) =
            normalization_fixture("甲 乙 结果 10.5 单位", &format!("前缀: {original} 后缀"));
        assert_eq!(
            normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
            1
        );
        let citation = &proposal.pages[0].citations[0];
        assert_eq!(citation.quote.as_bytes(), original.as_bytes());
        assert_eq!(
            (
                &*citation.source_id,
                &*citation.revision_id,
                &*citation.chunk_id
            ),
            ("s", "r", "chunk-1")
        );
        assert_eq!(proposal.pages[0].markdown, "Unchanged page text");
        assert!(errors(&proposal, "s", "r", &chunks, &[]).repair.is_empty());
        assert_eq!(
            normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
            0
        );
    }

    #[test]
    fn exact_match_is_preserved_even_if_other_whitespace_equivalent_spans_exist() {
        let (mut proposal, chunks) =
            normalization_fixture("alpha beta", "alpha beta / alpha\nbeta");
        assert_eq!(
            normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
            0
        );
        assert_eq!(proposal.pages[0].citations[0].quote, "alpha beta");
        assert!(errors(&proposal, "s", "r", &chunks, &[]).repair.is_empty());
    }

    #[test]
    fn ambiguous_and_overlapping_matches_are_not_chosen() {
        for (quote, text) in [
            ("alpha\tbeta", "alpha\nbeta / alpha  beta"),
            ("a\ta", "a\na a"),
        ] {
            let (mut proposal, chunks) = normalization_fixture(quote, text);
            assert_eq!(
                normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
                0
            );
            assert_eq!(proposal.pages[0].citations[0].quote, quote);
            assert_eq!(errors(&proposal, "s", "r", &chunks, &[]).repair.len(), 1);
        }
    }

    #[test]
    fn explicit_wrong_source_revision_or_chunk_cannot_be_repaired() {
        for field in ["source", "revision", "chunk"] {
            let (mut proposal, chunks) = normalization_fixture("alpha beta", "alpha\nbeta");
            let citation = &mut proposal.pages[0].citations[0];
            match field {
                "source" => citation.source_id = "other".into(),
                "revision" => citation.revision_id = "other".into(),
                _ => citation.chunk_id = "other".into(),
            }
            let before = citation.clone();
            assert_eq!(
                normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
                0
            );
            assert_eq!(proposal.pages[0].citations[0], before);
        }
        let (mut proposal, mut chunks) =
            normalization_fixture("alpha beta", "unrelated target chunk");
        let mut other = chunks[0].clone();
        other.chunk_id = "other".into();
        other.text = "alpha\nbeta".into();
        chunks.push(other);
        assert_eq!(
            normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
            0
        );
    }

    #[test]
    fn numbers_facts_hyphens_and_word_boundaries_are_never_fuzzed() {
        for (quote, text) in [
            ("rate 10.5", "rate\n10.6"),
            ("eight units", "8\nunits"),
            ("model 1 0", "model\n10"),
            ("version 1.0", "version 1 .0"),
            ("consistency", "consis-\ntency"),
            ("Alpha beta", "alpha\nbeta"),
            ("important alpha beta", "alpha\nbeta"),
            ("é value", "e\u{301}\nvalue"),
        ] {
            let (mut proposal, chunks) = normalization_fixture(quote, text);
            assert_eq!(
                normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
                0
            );
            assert_eq!(proposal.pages[0].citations[0].quote, quote);
        }
    }

    #[test]
    fn boundary_whitespace_is_mapped_without_trimming_nonwhitespace_content() {
        let (mut proposal, chunks) =
            normalization_fixture("\talpha beta\t", "before \nalpha\r\nbeta \u{85}after");
        assert_eq!(
            normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
            1
        );
        assert_eq!(
            proposal.pages[0].citations[0].quote,
            " \nalpha\r\nbeta \u{85}"
        );
    }

    #[test]
    fn retained_prior_evidence_is_not_rewritten_as_a_new_citation() {
        let (mut proposal, chunks) =
            normalization_fixture("first span", "first\nspan then second \nspan");
        let mut prior = proposal.pages[0].clone();
        prior.citations[0].quote = "first\nspan".into();
        let existing = vec![StoredPage {
            revision_id: "page-v1".into(),
            human_edited: false,
            draft: prior,
        }];
        let before = existing[0].draft.citations.clone();
        assert_eq!(
            normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &existing),
            0
        );
        assert_eq!(proposal.pages[0].citations[0].quote, "first span");
        assert_eq!(existing[0].draft.citations, before);
        proposal.pages[0].citations[0].quote = "second span".into();
        assert_eq!(
            normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &existing),
            1
        );
        assert_eq!(proposal.pages[0].citations[0].quote, "second \nspan");
        assert_eq!(existing[0].draft.citations, before);
    }

    #[test]
    fn normalization_keeps_quote_bounds_and_rejects_duplicate_chunk_authority() {
        for quote in [" \n\u{2009}".to_owned(), "x".repeat(MAX_QUOTE_BYTES + 1)] {
            let (mut proposal, chunks) = normalization_fixture(&quote, "unrelated");
            assert_eq!(
                normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
                0
            );
            assert_eq!(proposal.pages[0].citations[0].quote, quote);
        }
        let (mut proposal, chunks) = normalization_fixture(
            "left\tright",
            &format!("left{}right", " ".repeat(MAX_QUOTE_BYTES)),
        );
        assert_eq!(
            normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
            0
        );
        let (mut proposal, mut chunks) = normalization_fixture("alpha beta", "alpha\nbeta");
        chunks.push(chunks[0].clone());
        assert_eq!(
            normalize_new_citation_quotes(&mut proposal, "s", "r", &chunks, &[]),
            0
        );
    }
}
