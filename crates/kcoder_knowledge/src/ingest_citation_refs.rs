//! Private model-output adapter. References select immutable host evidence;
//! explicit coordinates expand to raw quotes; literal text still passes the
//! authoritative source/quote checks and cannot choose a different source.
use super::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const MAX_SPANS_PER_CHUNK: usize = 8;
const TARGET_SPAN_BYTES: usize = 2048;
const PREVIEW_CHARACTERS: usize = 32;

// Validate the original private wire shape as well as the expanded public
// proposal. Deserializing through Value alone would erase duplicate JSON keys.
#[allow(dead_code)] // Used only to validate the original wire before expansion.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelProposal {
    pages: Vec<ModelPage>,
    #[serde(default, deserialize_with = "deserialize_review_notes")]
    review_notes: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_review_notes")]
    advisory_notes: Vec<String>,
    #[serde(default)]
    organization_proof: Option<ingest_organization::OrganizationProof>,
}
#[allow(dead_code)] // Used only to validate the original wire before expansion.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelPage {
    page_id: String,
    expected_revision: Option<String>,
    kind: KnowledgePageKind,
    title: String,
    markdown: String,
    #[serde(default)]
    citations: Vec<ModelCitation>,
    #[serde(default)]
    related_page_ids: Vec<String>,
}
#[allow(dead_code)] // Used only to validate the original wire before expansion.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelCitation {
    #[serde(rename = "ref")]
    reference: Option<String>,
    source_id: Option<String>,
    revision_id: Option<String>,
    chunk_id: Option<String>,
    quote: Option<String>,
    first_line: Option<usize>,
    last_line: Option<usize>,
    start_byte: Option<usize>,
    end_byte: Option<usize>,
    whole_chunk: Option<bool>,
    page: Option<u32>,
}

// Only deserialization is needed: conversion uses the small offered map after
// this rejects duplicate/unknown keys in every original model-output object.
pub(super) fn validate_wire(raw: &str) -> serde_json::Result<()> {
    serde_json::from_str::<ModelProposal>(raw).map(|_| ())
}

pub(super) struct CitationRefs {
    citations: BTreeMap<String, KnowledgeCitation>,
    metadata: Vec<Value>,
    source: String,
    revision: String,
    chunks: Vec<crate::SourceChunk>,
}

impl CitationRefs {
    pub(super) fn new(source: &str, revision: &str, chunks: &[crate::SourceChunk]) -> Self {
        let mut refs = Self {
            citations: BTreeMap::new(),
            metadata: Vec::new(),
            source: source.into(),
            revision: revision.into(),
            chunks: chunks.to_vec(),
        };
        for chunk in chunks {
            // A complete chunk remains selectable for facts crossing partition
            // boundaries. It is not the default and requires an explicit ref.
            for (start, end) in ranges(&chunk.text) {
                if start != 0 || end != chunk.text.len() {
                    refs.insert(source, revision, chunk, start, end);
                }
            }
            refs.insert(source, revision, chunk, 0, chunk.text.len());
        }
        refs
    }

    fn insert(
        &mut self,
        source: &str,
        revision: &str,
        chunk: &crate::SourceChunk,
        start: usize,
        end: usize,
    ) -> String {
        let quote = &chunk.text[start..end];
        // Bind the token to revision, identity, byte offsets AND exact text.
        // No lookup crosses this preparation's authorized chunk collection.
        let identity = serde_json::to_vec(&(source, revision, &chunk.chunk_id, start, end, quote))
            .expect("serializing a string tuple is infallible");
        let id = format!("span-{}", &crate::objects::digest(&identity)[..24]);
        let first_line =
            chunk.first_line + chunk.text[..start].bytes().filter(|b| *b == b'\n').count();
        let last_line = first_line
            + quote
                .trim_end_matches('\n')
                .bytes()
                .filter(|b| *b == b'\n')
                .count();
        if self.citations.contains_key(&id) {
            return id;
        }
        self.metadata.push(json!({
            "ref":id,"chunkId":chunk.chunk_id,"startByte":start,"endByte":end,
            "firstLine":first_line,"lastLine":last_line,"page":chunk.page,
            "wholeChunk":start == 0 && end == chunk.text.len(),
            "preview":quote.chars().take(PREVIEW_CHARACTERS).collect::<String>(),
        }));
        self.citations.insert(
            id.clone(),
            KnowledgeCitation {
                source_id: source.into(),
                revision_id: revision.into(),
                chunk_id: chunk.chunk_id.clone(),
                quote: quote.into(),
            },
        );
        id
    }

    pub(super) fn add_range(
        &mut self,
        source: &str,
        revision: &str,
        chunk: &crate::SourceChunk,
        start: usize,
        end: usize,
    ) -> Result<String> {
        structured_require(
            start < end
                && end <= chunk.text.len()
                && chunk.text.is_char_boundary(start)
                && chunk.text.is_char_boundary(end)
                && end - start <= 16 * 1024
                && !chunk.text[start..end].trim().is_empty(),
            "organization_validation",
            "wiki_organization_source_range",
            "/sourceInventory/units".into(),
        )?;
        Ok(self.insert(source, revision, chunk, start, end))
    }
    pub(super) fn resolve(&self, reference: &str) -> Option<&KnowledgeCitation> {
        self.citations.get(reference)
    }

    pub(super) fn metadata(&self) -> &[Value] {
        &self.metadata
    }

    /// Expand only the exact private `{ref}` variant; all public/literal
    /// citation objects are left for the authoritative normal deserializer.
    pub(super) fn expand(&self, value: &mut Value, stage: &'static str) -> Result<bool> {
        let mut expanded = false;
        let mut expanded_bytes = serde_json::to_vec(value)?.len();
        let Some(pages) = value.get_mut("pages").and_then(Value::as_array_mut) else {
            return Ok(false);
        };
        for (page_index, page) in pages.iter_mut().enumerate() {
            let Some(citations) = page.get_mut("citations").and_then(Value::as_array_mut) else {
                continue;
            };
            for (index, value) in citations.iter_mut().enumerate() {
                let Some(object) = value.as_object() else {
                    continue;
                };
                let base = format!("/pages/{page_index}/citations/{index}");
                let (citation, field) = if let Some(reference) = object.get("ref") {
                    let field = format!("{base}/ref");
                    // A quote remains a distinct literal choice; a reference
                    // cannot erase or override it, even when other metadata matches.
                    structured_require(
                        object.get("quote").is_none_or(Value::is_null),
                        stage,
                        "wiki_evidence_ref_conflict",
                        field.clone(),
                    )?;
                    let reference = reference.as_str().ok_or_else(|| WikiCandidateFailure {
                        stage,
                        code: "wiki_json_type",
                        field: field.clone(),
                    })?;
                    let (canonical, citation) =
                        self.reference(reference)
                            .ok_or_else(|| WikiCandidateFailure {
                                stage,
                                code: "wiki_evidence_ref_not_supplied",
                                field: field.clone(),
                            })?;
                    let actual = serde_json::to_value(citation)?;
                    let metadata = self
                        .metadata
                        .iter()
                        .find(|meta| meta["ref"] == canonical)
                        .expect("reference metadata exists");
                    for (key, value) in object
                        .iter()
                        .filter(|(key, value)| key.as_str() != "ref" && !value.is_null())
                    {
                        let expected = actual.get(key).or_else(|| metadata.get(key));
                        structured_require(
                            expected == Some(value),
                            stage,
                            "wiki_evidence_ref_conflict",
                            field.clone(),
                        )?;
                    }
                    (citation.clone(), field)
                } else {
                    let Some(citation) = super::ingest_citation_locator::literal(
                        object,
                        &self.source,
                        &self.revision,
                        &self.chunks,
                        stage,
                        &base,
                    )?
                    else {
                        continue;
                    };
                    (citation, base)
                };
                let literal = serde_json::to_value(&citation)?;
                expanded_bytes = expanded_bytes
                    .saturating_sub(serde_json::to_vec(value)?.len())
                    .saturating_add(serde_json::to_vec(&literal)?.len());
                structured_require(
                    expanded_bytes <= WIKI_MAX_PROPOSAL_BYTES,
                    stage,
                    "wiki_evidence_ref_expansion_bounds",
                    field,
                )?;
                *value = literal;
                expanded = true;
            }
        }
        Ok(expanded)
    }

    fn reference(&self, reference: &str) -> Option<(&str, &KnowledgeCitation)> {
        let mut text = reference.trim();
        for _ in 0..4 {
            if let Some((key, citation)) = self.citations.get_key_value(text) {
                return Some((key, citation));
            }
            text = if let Some(inner) = text.strip_prefix('`').and_then(|s| s.strip_suffix('`')) {
                inner.trim()
            } else if let Some(inner) = text.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                inner.trim()
            } else if let Some(inner) = text.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
                inner.trim()
            } else {
                return None;
            };
        }
        None
    }
}

/// Prefer paragraph boundaries, then whole lines for long paragraphs/tables.
/// If many tiny lines would exceed the metadata cap, group adjacent lines.
/// Every original byte remains in a selectable span, including whitespace.
fn ranges(text: &str) -> Vec<(usize, usize)> {
    let mut ends = Vec::new();
    let mut cursor = 0;
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        let line_end = cursor + line.len();
        // Long unbroken Unicode/HTML/table lines still offer bounded spans.
        if line.len() <= TARGET_SPAN_BYTES && line_end - start > TARGET_SPAN_BYTES {
            ends.push(cursor);
            start = cursor;
        }
        while line_end - start > TARGET_SPAN_BYTES {
            let mut end = start + TARGET_SPAN_BYTES;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            ends.push(end);
            start = end;
        }
        cursor = line_end;
        if cursor - start >= TARGET_SPAN_BYTES || line.trim().is_empty() {
            ends.push(cursor);
            start = cursor;
        }
    }
    if ends.last().copied() != Some(text.len()) {
        ends.push(text.len());
    }
    // Keep locator overhead proportional to source size, including sources
    // with hundreds of very short paragraphs or table rows. The full text
    // remains readable; this groups adjacent original evidence, not facts.
    let limit = text
        .len()
        .div_ceil(TARGET_SPAN_BYTES)
        .clamp(3, MAX_SPANS_PER_CHUNK);
    let group = ends.len().div_ceil(limit).max(1);
    let mut result = Vec::new();
    let mut start = 0;
    for (index, end) in ends.iter().enumerate() {
        if ((index + 1) % group == 0 || index + 1 == ends.len())
            && !text[start..*end].trim().is_empty()
        {
            result.push((start, *end));
            start = *end;
        }
    }
    // Preserve trailing whitespace in the last selected segment too.
    if let Some(last) = result.last_mut() {
        last.1 = text.len();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn chunk(text: &str) -> crate::SourceChunk {
        crate::SourceChunk {
            ordinal: 1,
            chunk_id: "chunk".into(),
            first_line: 11,
            last_line: 30,
            page: Some(7),
            text: text.into(),
        }
    }
    pub(super) fn proposal(citations: Value) -> String {
        json!({"pages":[{"pageId":"p","title":"Topic","kind":"concept",
            "markdown":"Fact","citations":citations}],"reviewNotes":[]})
        .to_string()
    }
    #[test]
    fn spans_expand_original_whitespace_unicode_paragraphs_and_complete_cross_line_scope()
    -> Result<()> {
        let text = "前言\r\n\r\nTable header\t值\nport\t8192\n\nPDF-\nline with  two spaces.\n";
        let chunks = [chunk(text)];
        let refs = CitationRefs::new("s", "r", &chunks);
        let matching = refs
            .metadata()
            .iter()
            .find(|span| span["preview"] == "Table header\t值\nport\t8192\n\n")
            .unwrap();
        let parsed: WikiProposal = parse_model_json(
            &proposal(json!([{"ref":matching["ref"]}])),
            Some(&refs),
            "generation",
        )?;
        assert_eq!(
            parsed.pages[0].citations[0].quote,
            "Table header\t值\nport\t8192\n\n"
        );
        assert_eq!(matching["firstLine"], 13);
        assert_eq!(matching["lastLine"], 14);
        assert_eq!(matching["page"], 7);
        assert!(
            crate::citation_repair::errors(&parsed, "s", "r", &chunks, &[])
                .repair
                .is_empty()
        );
        let whole = refs.metadata().last().unwrap();
        assert_eq!(whole["wholeChunk"], true);
        let parsed: WikiProposal = parse_model_json(
            &proposal(json!([{"ref":whole["ref"]}])),
            Some(&refs),
            "generation",
        )?;
        assert_eq!(parsed.pages[0].citations[0].quote, text);
        assert!(
            serde_json::from_str::<WikiProposal>(&proposal(json!([{"ref":whole["ref"]}]))).is_err(),
            "public tool contract remains literal-only"
        );
        Ok(())
    }
    #[test]
    fn explicit_locations_and_missing_identity_expand_only_actual_batch_evidence() -> Result<()> {
        let chunks = [chunk("第一行\n第二行\n末尾")];
        let refs = CitationRefs::new("s", "r", &chunks);
        for citation in [
            json!({"chunkId":"chunk","firstLine":"12","lastLine":"12"}),
            json!({"sourceId":null,"revisionId":null,"chunkId":"chunk","startByte":"10","endByte":"20"}),
        ] {
            let parsed: WikiProposal =
                parse_model_json(&proposal(json!([citation])), Some(&refs), "generation")?;
            assert_eq!(parsed.pages[0].citations[0].quote, "第二行\n");
            assert_eq!(parsed.pages[0].citations[0].source_id, "s");
            assert_eq!(parsed.pages[0].citations[0].revision_id, "r");
            assert!(
                crate::citation_repair::errors(&parsed, "s", "r", &chunks, &[])
                    .repair
                    .is_empty()
            );
        }
        for citation in [
            json!({"chunkId":"chunk","wholeChunk":true}),
            json!({"sourceId":null,"revisionId":null,"chunkId":"chunk","quote":"第一行"}),
        ] {
            let parsed: WikiProposal =
                parse_model_json(&proposal(json!([citation])), Some(&refs), "generation")?;
            assert!(
                crate::citation_repair::errors(&parsed, "s", "r", &chunks, &[])
                    .repair
                    .is_empty()
            );
        }
        let parsed: WikiProposal = parse_model_json(
            &proposal(json!([{"chunkId":"chunk","quote":"INVENTED_FACT"}])),
            Some(&refs),
            "generation",
        )?;
        assert_eq!(
            crate::citation_repair::errors(&parsed, "s", "r", &chunks, &[])
                .failure
                .unwrap()
                .code,
            "wiki_evidence_quote_span"
        );
        Ok(())
    }

    #[test]
    fn copied_reference_metadata_is_checked_and_format_wrappers_are_unambiguous() -> Result<()> {
        let chunks = [chunk("actual source")];
        let refs = CitationRefs::new("s", "r", &chunks);
        let mut copied = refs.metadata()[0].clone();
        copied["sourceId"] = Value::Null;
        copied["revisionId"] = Value::Null;
        copied["quote"] = Value::Null;
        copied["ref"] = format!(" `[{}]` ", copied["ref"].as_str().unwrap()).into();
        let parsed: WikiProposal = parse_model_json(
            &proposal(json!([copied.clone()])),
            Some(&refs),
            "generation",
        )?;
        assert_eq!(parsed.pages[0].citations[0].quote, "actual source");
        for (field, bad) in [
            ("chunkId", json!("foreign")),
            ("sourceId", json!("foreign")),
            ("endByte", json!(1000)),
            ("quote", json!("forged")),
        ] {
            let mut conflicting = copied.clone();
            conflicting[field] = bad;
            let error = parse_model_json::<WikiProposal>(
                &proposal(json!([conflicting])),
                Some(&refs),
                "generation",
            )
            .unwrap_err();
            assert_eq!(
                error.downcast_ref::<WikiCandidateFailure>().unwrap().code,
                "wiki_evidence_ref_conflict"
            );
        }
        Ok(())
    }

    #[test]
    fn source_locators_cannot_cross_identity_bounds_or_utf8_boundaries() {
        let chunks = [chunk("甲\n乙")];
        let refs = CitationRefs::new("s", "r", &chunks);
        for citation in [
            json!({"chunkId":"unknown","wholeChunk":true}),
            json!({"sourceId":"other","chunkId":"chunk","wholeChunk":true}),
            json!({"revisionId":"old","chunkId":"chunk","wholeChunk":true}),
            json!({"chunkId":"chunk","startByte":1,"endByte":3}),
            json!({"chunkId":"chunk","firstLine":0,"lastLine":1}),
            json!({"chunkId":"chunk","firstLine":1,"lastLine":3}),
            json!({"chunkId":"chunk","startByte":"-1","endByte":"3"}),
            json!({"chunkId":"chunk","startByte":"1.5","endByte":"3"}),
            json!({"chunkId":"chunk","startByte":0,"endByte":3,"firstLine":2,"lastLine":2}),
            json!({"chunkId":"chunk"}),
        ] {
            assert!(
                parse_model_json::<WikiProposal>(
                    &proposal(json!([citation])),
                    Some(&refs),
                    "generation"
                )
                .is_err()
            );
        }
        let repeated = [chunk("first"), chunk("different")];
        let refs = CitationRefs::new("s", "r", &repeated);
        assert!(
            parse_model_json::<WikiProposal>(
                &proposal(json!([{"chunkId":"chunk","wholeChunk":true}])),
                Some(&refs),
                "generation"
            )
            .is_err()
        );
    }

    #[test]
    fn references_bind_exact_revision_chunk_offsets_and_text_without_default_fallback() {
        let chunks = [chunk("first\n\nsecond")];
        let refs = CitationRefs::new("s", "r", &chunks);
        let original = refs.metadata()[0]["ref"].clone();
        assert_eq!(
            refs.metadata(),
            CitationRefs::new("s", "r", &chunks).metadata()
        );
        for other in [
            CitationRefs::new("s", "new-r", &chunks),
            CitationRefs::new("foreign-s", "r", &chunks),
            CitationRefs::new("s", "r", &[chunk("first\n\nchanged")]),
            CitationRefs::new(
                "s",
                "r",
                &[crate::SourceChunk {
                    chunk_id: "other".into(),
                    ..chunk("first\n\nsecond")
                }],
            ),
        ] {
            // Whole-chunk identity always changes; unchanged individual spans
            // may remain identical only within the same immutable revision.
            let whole = refs.metadata().last().unwrap()["ref"].clone();
            let error = parse_model_json::<WikiProposal>(
                &proposal(json!([{"ref":whole}])),
                Some(&other),
                "generation",
            )
            .unwrap_err();
            let error = error.downcast_ref::<WikiCandidateFailure>().unwrap();
            assert_eq!(error.code, "wiki_evidence_ref_not_supplied");
            assert_eq!(error.field, "/pages/0/citations/0/ref");
        }
        for citation in [
            json!({"ref":"PRIVATE_UNKNOWN"}),
            json!({"ref":original,"quote":"forged"}),
            json!({"ref":original,"sourceId":"s","revisionId":"r","chunkId":"chunk","quote":"first\n\n"}),
            json!({"ref":null}),
        ] {
            let mixed = citation.as_object().unwrap().len() > 1;
            let error = parse_model_json::<WikiProposal>(
                &proposal(json!([citation])),
                Some(&refs),
                "citation_repair",
            )
            .unwrap_err();
            let error = error.downcast_ref::<WikiCandidateFailure>().unwrap();
            assert_eq!(error.stage, "citation_repair");
            assert_eq!(error.field, "/pages/0/citations/0/ref");
            assert_eq!(
                error.code,
                if mixed {
                    "wiki_evidence_ref_conflict"
                } else if citation["ref"].is_null() {
                    "wiki_json_type"
                } else {
                    "wiki_evidence_ref_not_supplied"
                }
            );
            assert!(!error.to_string().contains("PRIVATE_UNKNOWN"));
            assert!(!error.to_string().contains("forged"));
        }
    }
    #[test]
    fn literal_quote_is_untouched_and_duplicate_keys_are_never_erased() -> Result<()> {
        let chunks = [chunk("PDF-\nline")];
        let refs = CitationRefs::new("s", "r", &chunks);
        let raw = proposal(
            json!([{"sourceId":"s","revisionId":"r","chunkId":"chunk","quote":"PDF-line"}, {"ref":refs.metadata()[0]["ref"]}]),
        );
        let parsed: WikiProposal = parse_model_json(&raw, Some(&refs), "generation")?;
        assert_eq!(parsed.pages[0].citations[0].quote, "PDF-line");
        assert_eq!(
            crate::citation_repair::errors(&parsed, "s", "r", &chunks, &[])
                .failure
                .unwrap()
                .code,
            "wiki_evidence_quote_span"
        );
        let duplicate = raw.replacen(
            "\"pageId\":\"p\"",
            "\"pageId\":\"p\",\"pageId\":\"second\"",
            1,
        );
        assert_eq!(
            parse_model_json::<WikiProposal>(&duplicate, Some(&refs), "generation")
                .unwrap_err()
                .downcast_ref::<WikiCandidateFailure>()
                .unwrap()
                .code,
            "wiki_json_schema"
        );
        let duplicate_ref = raw.replace("\"ref\":", "\"ref\":\"PRIVATE_FIRST\",\"ref\":");
        assert_eq!(
            parse_model_json::<WikiProposal>(&duplicate_ref, Some(&refs), "generation")
                .unwrap_err()
                .downcast_ref::<WikiCandidateFailure>()
                .unwrap()
                .code,
            "wiki_json_schema"
        );
        let escaped = raw.replace("\"ref\":", "\"\\u0072ef\":");
        assert!(parse_model_json::<WikiProposal>(&escaped, Some(&refs), "generation").is_ok());
        Ok(())
    }
    #[test]
    fn expansion_cannot_bypass_private_proposal_byte_budget() {
        let refs = CitationRefs::new("s", "r", &[chunk(&"x".repeat(16 * 1024))]);
        let whole = refs.metadata().last().unwrap()["ref"].clone();
        let raw = proposal(json!(
            (0..600).map(|_| json!({"ref":whole})).collect::<Vec<_>>()
        ));
        assert!(raw.len() < WIKI_MAX_OUTPUT_BYTES);
        let error = parse_model_json::<WikiProposal>(&raw, Some(&refs), "generation").unwrap_err();
        let error = error.downcast_ref::<WikiCandidateFailure>().unwrap();
        assert_eq!(error.code, "wiki_evidence_ref_expansion_bounds");
        assert!(error.field.starts_with("/pages/0/citations/"));
        assert!(error.field.ends_with("/ref"));
    }

    #[test]
    fn bounded_metadata_covers_every_byte_without_repeating_complete_source() {
        for text in [
            "字".repeat(5461),
            (0..500)
                .map(|n| format!("row{n}\tvalue\n\n"))
                .collect::<String>(),
        ] {
            let chunks = [chunk(&text)];
            let refs = CitationRefs::new("s", "r", &chunks);
            assert!(refs.metadata().len() <= MAX_SPANS_PER_CHUNK + 1);
            let mut through = 0;
            for span in refs
                .metadata()
                .iter()
                .filter(|span| span["wholeChunk"] == false)
            {
                let start = span["startByte"].as_u64().unwrap() as usize;
                let end = span["endByte"].as_u64().unwrap() as usize;
                assert_eq!(start, through);
                assert!(text.is_char_boundary(start) && text.is_char_boundary(end));
                assert!(span["preview"].as_str().unwrap().chars().count() <= PREVIEW_CHARACTERS);
                through = end;
            }
            assert_eq!(through, text.len());
            assert!(serde_json::to_vec(refs.metadata()).unwrap().len() <= 4 * 1024);
            assert!(
                refs.citations
                    .values()
                    .all(|c| c.quote.len() <= 16 * 1024 && text.contains(&c.quote))
            );
        }
    }
}

#[cfg(test)]
mod repair_tests {
    use super::*;
    use std::sync::{
        Mutex,
        atomic::{AtomicU32, Ordering},
    };

    struct RepairModel {
        calls: AtomicU32,
        original: Value,
        reference: Value,
        repeat_invalid: bool,
    }
    #[async_trait]
    impl WikiModel for RepairModel {
        async fn complete(&self, request: WikiModelRequest) -> Result<String> {
            let call = self.calls.fetch_add(1, Ordering::Relaxed);
            if call == 0 {
                return Ok("{unfinished".into());
            }
            assert_eq!(request.stage, "format_repair");
            let input: Value = serde_json::from_str(&request.user)?;
            assert_eq!(input["originalInput"], self.original);
            Ok(if self.repeat_invalid {
                super::tests::proposal(json!([{"ref":"PRIVATE_FOREIGN"}]))
            } else {
                super::tests::proposal(json!([{"ref":self.reference}]))
            })
        }
    }
    #[tokio::test]
    async fn formatter_repair_uses_original_registry_and_unknown_refs_stay_typed() -> Result<()> {
        let chunks = [super::tests::chunk("PDF-\nline\n\n值\t8192")];
        let refs = CitationRefs::new("s", "r", &chunks);
        let original = json!({"source":{"sourceId":"s","revisionId":"r","chunks":chunks},"citationSpans":refs.metadata()});
        for repeat_invalid in [false, true] {
            let model = RepairModel {
                calls: AtomicU32::new(0),
                original: original.clone(),
                reference: refs.metadata()[0]["ref"].clone(),
                repeat_invalid,
            };
            let request = WikiModelRequest {
                stage: "generation",
                system: "private proposal contract".into(),
                user: original.to_string(),
                max_output_tokens: 2048,
            };
            let repairs = AtomicU32::new(0);
            let result: Result<WikiProposal> = call_json_with_refs(
                &model,
                request,
                64000,
                &CancellationToken::new(),
                &repairs,
                Some(&refs),
            )
            .await;
            if repeat_invalid {
                let error = result.unwrap_err();
                let error = error.downcast_ref::<WikiCandidateFailure>().unwrap();
                assert_eq!(error.code, "wiki_evidence_ref_not_supplied");
                assert_eq!(error.stage, "format_repair");
                assert!(!error.to_string().contains("PRIVATE_FOREIGN"));
            } else {
                let parsed = result?;
                assert_eq!(parsed.pages[0].citations[0].quote, "PDF-\nline\n\n");
            }
            assert_eq!(model.calls.load(Ordering::Relaxed), 2);
            assert_eq!(repairs.load(Ordering::Relaxed), 1);
        }
        Ok(())
    }

    struct UnknownRefModel(AtomicU32);
    #[async_trait]
    impl WikiModel for UnknownRefModel {
        async fn complete(&self, _: WikiModelRequest) -> Result<String> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(super::tests::proposal(json!([{"ref":"PRIVATE_FOREIGN"}])))
        }
    }
    #[tokio::test]
    async fn exhausted_shared_repair_budget_keeps_ref_cause_without_another_call() {
        let refs = CitationRefs::new("s", "r", &[super::tests::chunk("Evidence")]);
        let model = UnknownRefModel(AtomicU32::new(0));
        let request = WikiModelRequest {
            stage: "generation",
            system: String::new(),
            user: "{}".into(),
            max_output_tokens: 2048,
        };
        let error = call_json_with_refs::<WikiProposal>(
            &model,
            request,
            8192,
            &CancellationToken::new(),
            &AtomicU32::new(3),
            Some(&refs),
        )
        .await
        .unwrap_err();
        let cause = error.downcast_ref::<WikiCandidateFailure>().unwrap();
        assert_eq!(cause.code, "wiki_evidence_ref_not_supplied");
        assert_eq!(cause.stage, "generation");
        assert_eq!(cause.field, "/pages/0/citations/0/ref");
        assert!(!format!("{error:?}").contains("PRIVATE_FOREIGN"));
        assert_eq!(model.0.load(Ordering::Relaxed), 1);
    }

    struct SupportModel {
        stages: Mutex<Vec<String>>,
        unsupported: bool,
    }
    #[async_trait]
    impl WikiModel for SupportModel {
        async fn complete(&self, request: WikiModelRequest) -> Result<String> {
            self.stages.lock().unwrap().push(request.stage.into());
            let input: Value = serde_json::from_str(&request.user)?;
            if request.stage == "analysis" {
                return Ok(organization_fixture::with_plan(
                    &input,
                    json!({"summary":"Evidence","queries":[]}),
                )
                .to_string());
            }
            if request.stage == "source_support" {
                assert_eq!(
                    input["citationBindings"][0]["citations"][0]["quote"],
                    "P100\t12 hours\nPDF-\nline"
                );
                return Ok(organization_fixture::with_organization_support(&input,json!({"sourceCoverage":"complete","units":input["units"].as_array().unwrap().iter().map(|unit| json!({"pageId":unit["pageId"],"unit":unit["unit"],"verdict":if self.unsupported {"unsupported"} else {"supported"},"citationIndices":[0]})).collect::<Vec<_>>()} )).to_string());
            }
            assert_eq!(request.stage, "generation");
            let span = input["citationSpans"]
                .as_array()
                .unwrap()
                .iter()
                .find(|span| span["wholeChunk"] == true)
                .unwrap();
            Ok(organization_fixture::with_proof(&input,json!({"pages":[{"pageId":input["newPageIds"][0],"kind":"concept","title":"Topic","markdown":"A claim requiring semantic assessment.","citations":[{"ref":span["ref"]}]}],"reviewNotes":[]})).to_string())
        }
    }
    #[tokio::test]
    async fn successful_ref_still_requires_source_support_and_original_evidence_commit()
    -> Result<()> {
        for unsupported in [false, true] {
            let temp = tempfile::tempdir()?;
            let mut catalog = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
            let scope = KnowledgeScope::from_authenticated_host("alice", "host")?;
            let library = catalog.create(&scope, "create", "Wiki", "")?;
            let source = catalog.import_text(
                &scope,
                &library.id,
                "source",
                "Original",
                "P100\t12 hours\nPDF-\nline",
            )?;
            let model = SupportModel {
                stages: Mutex::new(Vec::new()),
                unsupported,
            };
            let prepared = catalog
                .prepare_wiki_update(
                    &scope,
                    WikiIngestRequest {
                        library_id: &library.id,
                        source_id: &source.source_id,
                        source_revision: &source.revision_id,
                        after_chunk: 0,
                        output_language: "en",
                        context_tokens: 64000,
                    },
                    &model,
                    &CancellationToken::new(),
                )
                .await?;
            assert_eq!(
                model.stages.lock().unwrap().as_slice(),
                ["analysis", "generation", "source_support"]
            );
            assert_eq!(!prepared.proposal.review_notes.is_empty(), unsupported);
            assert_eq!(
                prepared.proposal.pages[0].citations[0].quote,
                "P100\t12 hours\nPDF-\nline"
            );
            assert!(
                catalog
                    .list_pages(&scope, &library.id, None, 100)?
                    .is_empty()
            );
            if !unsupported {
                catalog.commit_generated_pages(
                    &scope,
                    &library.id,
                    "commit",
                    prepared.proposal.pages,
                )?;
                assert!(
                    !catalog
                        .list_pages(&scope, &library.id, None, 100)?
                        .is_empty()
                );
            }
        }
        Ok(())
    }
}
