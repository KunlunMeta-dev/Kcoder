//! Convert delivered draft files into a `WikiProposal` and map host validation
//! failures back to `file:line`. Prior citations of existing pages are always
//! retained first; new citations are appended without duplicates.
use super::draft_format::{CitationDef, CitationSpec, DraftDiagnostic, parse_draft, parse_review};
use super::tree::WikiTree;
use crate::StoredPage;
use crate::ingest::ingest_organization::{Inventory, OrganizationProof};
use crate::ingest::{
    MAX_REVIEW_NOTE_BYTES, MAX_REVIEW_NOTES, MAX_TITLE_BYTES, MAX_TITLE_CHARACTERS,
    WIKI_MAX_PAGE_BYTES, WikiProposal,
};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
use std::collections::{BTreeMap, BTreeSet};

/// Immutable facts needed to check a draft. `existing` holds every offered
/// and admitted existing page.
pub(in crate::ingest) struct DraftContext<'a> {
    pub source_id: &'a str,
    pub revision_id: &'a str,
    pub chunks: &'a [crate::SourceChunk],
    pub refs: &'a crate::ingest::ingest_citation_refs::CitationRefs,
    pub existing: &'a [StoredPage],
    pub new_ids: &'a [String],
    pub overview_id: &'a str,
    pub unit_ids: &'a [String],
    pub inventory: Option<&'a Inventory>,
}

impl DraftContext<'_> {
    fn base_revision(&self, page_id: &str, tree: &WikiTree) -> Option<String> {
        self.existing
            .iter()
            .find(|page| page.draft.page_id == page_id)
            .map(|page| page.revision_id.clone())
            .or_else(|| tree.admitted.get(page_id).cloned())
    }
    fn prior(&self, page_id: &str) -> Option<&StoredPage> {
        self.existing
            .iter()
            .find(|page| page.draft.page_id == page_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::ingest) struct Located {
    pub path: String,
    pub line: usize,
    pub code: String,
}

impl std::fmt::Display for Located {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:L{} {}", self.path, self.line, self.code)
    }
}

#[derive(Debug, Clone, Default)]
pub(in crate::ingest) struct PageMap {
    pub path: String,
    pub page_id: String,
    pub frontmatter_lines: usize,
    pub field_lines: BTreeMap<&'static str, usize>,
    pub prior_citations: usize,
    /// File line of each new citation, in proposal citation order after the prior ones.
    pub citation_lines: Vec<usize>,
    /// Body line to proposal citation indices marked on that line.
    pub marked: BTreeMap<usize, Vec<usize>>,
}

#[derive(Debug, Default)]
pub(in crate::ingest) struct Delivery {
    pub proposal: WikiProposal,
    pub maps: Vec<PageMap>,
    pub errors: Vec<Located>,
    /// Pages with located problems; they are withheld if problems remain.
    pub failing_pages: BTreeSet<String>,
}

fn expand(
    spec: &CitationSpec,
    context: &DraftContext<'_>,
) -> std::result::Result<KnowledgeCitation, &'static str> {
    let mut value = serde_json::json!({"pages":[{"citations":[spec.wire()]}]});
    match context.refs.expand(&mut value, "generation") {
        Ok(_) => serde_json::from_value(value["pages"][0]["citations"][0].clone())
            .map_err(|_| "wiki_draft_citation_syntax"),
        Err(error) => Err(error
            .downcast_ref::<crate::ingest::WikiCandidateFailure>()
            .map_or("wiki_draft_citation_syntax", |failure| failure.code)),
    }
}

/// Exact-substring check including the host's bounded quote normalization.
fn exact(citation: &mut KnowledgeCitation, context: &DraftContext<'_>) -> Option<&'static str> {
    let mut proposal = WikiProposal {
        pages: vec![KnowledgePageDraft {
            page_id: String::new(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: String::new(),
            markdown: String::new(),
            citations: vec![citation.clone()],
            related_page_ids: vec![],
        }],
        ..WikiProposal::default()
    };
    crate::citation_repair::normalize_new_citation_quotes(
        &mut proposal,
        context.source_id,
        context.revision_id,
        context.chunks,
        &[],
    );
    let errors = crate::citation_repair::errors(
        &proposal,
        context.source_id,
        context.revision_id,
        context.chunks,
        &[],
    );
    *citation = proposal.pages.remove(0).citations.remove(0);
    errors.failure.map(|failure| failure.code)
}

fn diag(line: usize, code: &'static str) -> DraftDiagnostic {
    DraftDiagnostic { line, code }
}

/// Build one page and its line map. Returns None when required identity
/// fields are missing; diagnostics always explain why.
fn page_from_draft(
    path: &str,
    text: &str,
    tree: &WikiTree,
    context: &DraftContext<'_>,
    diagnostics: &mut Vec<DraftDiagnostic>,
) -> Option<(KnowledgePageDraft, PageMap)> {
    let page_id = path.strip_prefix("draft/")?.strip_suffix(".md")?.to_owned();
    let parsed = parse_draft(text);
    diagnostics.extend(parsed.diagnostics.iter().cloned());
    if parsed.frontmatter_lines == 0 {
        return None;
    }
    let line = |key| parsed.field_lines.get(key).copied().unwrap_or(1);
    match &parsed.page_id {
        None => diagnostics.push(diag(1, "wiki_draft_page_id")),
        Some(id) if id != &page_id => {
            diagnostics.push(diag(line("pageId"), "wiki_draft_page_id_mismatch"))
        }
        _ => {}
    }
    let base = context.base_revision(&page_id, tree);
    // An omitted revision of an existing page is filled from the exact read;
    // an explicit value must match it, and new pages carry no revision.
    match (&base, &parsed.expected_revision) {
        (Some(base), Some(Some(value))) if value == base => {}
        (Some(_), None) | (None, None) | (None, Some(None)) => {}
        _ => diagnostics.push(diag(
            line("expectedRevision"),
            "wiki_candidate_base_revision",
        )),
    }
    let kind = match parsed.kind.clone() {
        Some(KnowledgePageKind::Source) => {
            diagnostics.push(diag(line("kind"), "wiki_draft_kind_source"));
            return None;
        }
        Some(kind) => kind,
        None => {
            if !parsed.field_lines.contains_key("kind") {
                diagnostics.push(diag(1, "wiki_draft_kind"));
            }
            return None;
        }
    };
    if (kind == KnowledgePageKind::Overview) != (page_id == context.overview_id) {
        diagnostics.push(diag(line("kind"), "wiki_candidate_unreserved_overview"));
    }
    let title = parsed.title.clone().unwrap_or_default();
    if title.trim().is_empty()
        || title.len() > MAX_TITLE_BYTES
        || title.chars().count() > MAX_TITLE_CHARACTERS
    {
        diagnostics.push(diag(line("title"), "wiki_candidate_title"));
    }
    let body_line = parsed.frontmatter_lines + 1;
    if parsed.markdown.trim().is_empty() {
        diagnostics.push(diag(body_line, "wiki_candidate_empty_markdown"));
    }
    if parsed.markdown.len() > WIKI_MAX_PAGE_BYTES {
        diagnostics.push(diag(body_line, "wiki_candidate_page_bounds"));
    }
    if let Some(units) = &parsed.source_units {
        for unit in units {
            if !context.unit_ids.contains(unit) {
                diagnostics.push(diag(line("sourceUnits"), "wiki_draft_source_unit_unknown"));
            }
        }
    }
    let known: BTreeSet<&str> = context
        .existing
        .iter()
        .map(|page| page.draft.page_id.as_str())
        .chain(tree.admitted.keys().map(String::as_str))
        .chain(
            context
                .existing
                .iter()
                .flat_map(|page| page.draft.related_page_ids.iter().map(String::as_str)),
        )
        .chain(context.new_ids.iter().map(String::as_str))
        .collect();
    for target in &parsed.related_page_ids {
        if target == &page_id {
            diagnostics.push(diag(
                line("relatedPageIds"),
                "wiki_candidate_self_reference",
            ));
        } else if !known.contains(target.as_str()) {
            diagnostics.push(diag(
                line("relatedPageIds"),
                "wiki_candidate_related_target_missing",
            ));
        }
    }
    let mut citations: Vec<KnowledgeCitation> = context
        .prior(&page_id)
        .map(|page| page.draft.citations.clone())
        .unwrap_or_default();
    let prior_citations = citations.len();
    let mut map = PageMap {
        path: path.into(),
        page_id: page_id.clone(),
        frontmatter_lines: parsed.frontmatter_lines,
        field_lines: parsed.field_lines.clone(),
        prior_citations,
        ..PageMap::default()
    };
    let mut label_index = BTreeMap::new();
    for CitationDef { label, line, spec } in &parsed.defs {
        let mut citation = match expand(spec, context) {
            Ok(citation) => citation,
            Err(code) => {
                diagnostics.push(diag(*line, code));
                continue;
            }
        };
        if let Some(code) = exact(&mut citation, context) {
            diagnostics.push(diag(*line, code));
            continue;
        }
        let index = match citations.iter().position(|known| known == &citation) {
            Some(index) => index,
            None => {
                citations.push(citation);
                map.citation_lines.push(*line);
                citations.len() - 1
            }
        };
        label_index.insert(label.clone(), index);
    }
    if citations.is_empty() {
        diagnostics.push(diag(body_line, "wiki_evidence_citations_bounds"));
    }
    for (body, labels) in &parsed.marked {
        let indices: Vec<usize> = labels
            .iter()
            .filter_map(|label| label_index.get(label).copied())
            .collect();
        if !indices.is_empty() {
            map.marked.insert(*body, indices);
        }
    }
    Some((
        KnowledgePageDraft {
            page_id,
            expected_revision: match &parsed.expected_revision {
                Some(value) => value.clone(),
                None => base,
            },
            kind,
            title,
            markdown: parsed.markdown,
            citations,
            related_page_ids: parsed.related_page_ids,
        },
        map,
    ))
}

/// Located diagnostics for one file, used for immediate tool feedback.
pub(in crate::ingest) fn check_file(
    path: &str,
    text: &str,
    tree: &WikiTree,
    context: &DraftContext<'_>,
) -> Vec<DraftDiagnostic> {
    if path == "review.md" {
        let (blocking, notes, mut diagnostics) = parse_review(text);
        if blocking.len() + notes.len() > MAX_REVIEW_NOTES
            || blocking
                .iter()
                .chain(notes.iter())
                .any(|note| note.len() > MAX_REVIEW_NOTE_BYTES)
        {
            diagnostics.push(diag(1, "wiki_candidate_review_bounds"));
        }
        return diagnostics;
    }
    let mut diagnostics = Vec::new();
    page_from_draft(path, text, tree, context, &mut diagnostics);
    diagnostics.sort_by_key(|diagnostic| diagnostic.line);
    diagnostics.dedup();
    diagnostics
}

/// Collect every changed draft file into one proposal with line maps.
pub(in crate::ingest) fn deliver(tree: &WikiTree, context: &DraftContext<'_>) -> Delivery {
    let mut delivery = Delivery::default();
    let mut placements = Vec::new();
    for (path, text) in tree.changed_drafts() {
        let mut diagnostics = Vec::new();
        let built = page_from_draft(path, text, tree, context, &mut diagnostics);
        let page_id = path
            .strip_prefix("draft/")
            .and_then(|name| name.strip_suffix(".md"))
            .unwrap_or_default()
            .to_owned();
        diagnostics.sort_by_key(|diagnostic| diagnostic.line);
        diagnostics.dedup();
        if !diagnostics.is_empty() {
            delivery.failing_pages.insert(page_id.clone());
        }
        for diagnostic in diagnostics {
            delivery.errors.push(Located {
                path: path.into(),
                line: diagnostic.line,
                code: diagnostic.code.into(),
            });
        }
        let Some((page, map)) = built else { continue };
        if let Some(units) = parse_draft(text).source_units {
            for unit in units.iter().filter(|unit| context.unit_ids.contains(unit)) {
                placements
                    .push(serde_json::json!({"unitId":unit,"pageId":page.page_id,"allLines":true}));
            }
        }
        delivery.proposal.pages.push(page);
        delivery.maps.push(map);
    }
    if let Some(text) = tree.get("review.md") {
        let (blocking, notes, diagnostics) = parse_review(text);
        for diagnostic in diagnostics {
            delivery.errors.push(Located {
                path: "review.md".into(),
                line: diagnostic.line,
                code: diagnostic.code.into(),
            });
        }
        delivery.proposal.review_notes = blocking;
        delivery.proposal.advisory_notes = notes;
    }
    if let Some(inventory) = context.inventory
        && !placements.is_empty()
    {
        let value = serde_json::json!({"binding":inventory.binding,"placements":placements});
        delivery.proposal.organization_proof =
            serde_json::from_value::<OrganizationProof>(value).ok();
    }
    delivery
}

/// Map a host JSON pointer (`/pages/<i>/...`) to a draft file line.
pub(in crate::ingest) fn locate(
    field: &str,
    maps: &[PageMap],
    proposal: &WikiProposal,
) -> (String, usize) {
    let parts: Vec<&str> = field.trim_start_matches('/').split('/').collect();
    match parts.as_slice() {
        ["pages", index, rest @ ..] => {
            let Some(map) = index.parse::<usize>().ok().and_then(|index| {
                let id = &proposal.pages.get(index)?.page_id;
                maps.iter().find(|map| &map.page_id == id)
            }) else {
                return ("draft/".into(), 1);
            };
            let line = match rest {
                ["citations", citation, ..] => citation
                    .parse::<usize>()
                    .ok()
                    .and_then(|citation| citation.checked_sub(map.prior_citations))
                    .and_then(|citation| map.citation_lines.get(citation).copied())
                    .unwrap_or(map.frontmatter_lines + 1),
                ["title", ..] => map.field_lines.get("title").copied().unwrap_or(1),
                ["pageId", ..] => map.field_lines.get("pageId").copied().unwrap_or(1),
                ["kind", ..] => map.field_lines.get("kind").copied().unwrap_or(1),
                ["expectedRevision", ..] => map
                    .field_lines
                    .get("expectedRevision")
                    .copied()
                    .unwrap_or(1),
                ["relatedPageIds", ..] => {
                    map.field_lines.get("relatedPageIds").copied().unwrap_or(1)
                }
                _ => map.frontmatter_lines + 1,
            };
            (map.path.clone(), line)
        }
        ["organizationProof", "placements", index, ..] => {
            let page = index.parse::<usize>().ok().and_then(|index| {
                proposal
                    .organization_proof
                    .as_ref()?
                    .placements
                    .get(index)
                    .map(|placement| placement.page_id.clone())
            });
            match page.and_then(|id| maps.iter().find(|map| map.page_id == id)) {
                Some(map) => (
                    map.path.clone(),
                    map.field_lines
                        .get("sourceUnits")
                        .copied()
                        .unwrap_or(map.frontmatter_lines + 1),
                ),
                None => ("draft/".into(), 1),
            }
        }
        ["reviewNotes", ..] => ("review.md".into(), 1),
        _ => ("draft/".into(), 1),
    }
}
