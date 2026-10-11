//! Exact prior prompt spelling, used only to find already paid private stage
//! caches. It is never sent to the provider and never weakens current checks.
use super::*;
const MAX_NEW_PAGE_CHARACTERS: usize = 2000;

pub(super) fn request(input: &WikiModelRequest) -> Result<Option<WikiModelRequest>> {
    const ANALYSIS_START: &str = "Return one JSON analysis.";
    const ANALYSIS_END: &str = "Analysis headings are guidance, not mandatory JSON keys.";
    const GENERATION_START: &str = "Return a complete JSON page proposal.";
    const GENERATION_END: &str = "All byte limits apply to decoded strings.";
    let mut context: serde_json::Value = serde_json::from_str(&input.user)?;
    let original = context.get("originalInput").unwrap_or(&context);
    let mut compatible = input.clone();
    if let Some(start) = compatible.system.find(ANALYSIS_START) {
        let Some(relative_end) = compatible.system[start..].find(ANALYSIS_END) else {
            return Ok(None);
        };
        let inventory = &original["sourceInventory"];
        if !inventory["planTemplate"].is_object() {
            return Ok(None);
        }
        compatible.system.replace_range(
            start..start + relative_end + ANALYSIS_END.len(),
            &analysis_output_contract(inventory),
        );
    } else if let Some(start) = compatible.system.find(GENERATION_START) {
        let Some(relative_end) = compatible.system[start..].find(GENERATION_END) else {
            return Ok(None);
        };
        if !original["identityBindings"]["exampleProposal"].is_object() {
            return Ok(None);
        }
        compatible.system.replace_range(
            start..start + relative_end + GENERATION_END.len(),
            &generation_output_contract(&original["identityBindings"]),
        );
        compatible.system = compatible.system.replace(
            "Use outputPolicy.suggestedNewPageCharacters as an initial writing target; longer complete supported topics are allowed within the shared 1048576 byte limit. Retain all necessary facts, qualifications and structured fields, and select appropriate evidence refs.",
            "Each new page must fit within 2000 Unicode characters. Use outputPolicy.suggestedNewPageCharacters as a working target and select appropriate evidence refs, not the hard character limit as a target.");
        compatible.system = compatible.system.replace(
            "organizationProof is optional: the host derives source-unit placements from real topic citations and verifies each complete body. If supplied, each placement needs only exact unitId and pageId; omit binding, citationRefs and line ranges to use host-owned values.",
            "Return organizationProof with sourceInventory.binding and placements:[{\"unitId\":\"copy an offered unit ID\",\"pageId\":\"copy an included topic ID\",\"allLines\":true}] for every required unit.");
        compatible.system = compatible.system.replace(
            "Return pages with complete bodies and real citations; organizationProof, relatedPageIds and empty reviewNotes may be omitted. A single page or blocking review note is accepted.",
            "Return JSON only with keys organizationProof, pages (array of page objects) and reviewNotes (array of strings, [] when no blocking review is needed; never a string).");
    } else {
        return Ok(None);
    }
    let original = if context.get("originalInput").is_some() {
        context.get_mut("originalInput").unwrap()
    } else {
        &mut context
    };
    if let Some(policy) = original
        .get_mut("outputPolicy")
        .and_then(serde_json::Value::as_object_mut)
    {
        policy.remove("maxPageBytes");
        policy.insert("maxNewPageCharacters".into(), serde_json::json!(2000));
        compatible.user = serde_json::to_string(&context)?;
    }
    Ok(Some(compatible))
}

fn analysis_output_contract(inventory: &serde_json::Value) -> String {
    let mut example_plan = inventory["planTemplate"].clone();
    example_plan.as_object_mut().unwrap().remove("aspects");
    if let Some(unit) = inventory["units"]
        .as_array()
        .and_then(|units| units.first())
    {
        example_plan["units"] = serde_json::json!([{"unitId":unit["id"],"disposition":"uncertain",
            "purposeAspectIds":[],"reason":"Determine source relevance and actual organization; this is a schema example."}]);
    }
    let shape = serde_json::to_string(&serde_json::json!({"summary":"Concise source analysis",
        "queries":[],"conflicts":[],"organizationPlan":example_plan}))
    .unwrap();
    format!(
        "Return only one JSON object with this VALID JSON shape bound to the actual offered source/purpose IDs: {shape}. The example organizationPlan is an uncertain template, NOT a completed analysis; replace every disposition and explicitly select each required unit's purposeAspectIds. Omit aspects; the host derives the inverse agenda from your explicit per-unit assignments. If you supply the legacy aspects array, it must exactly agree; a wrong explicit inverse is never silently changed. All binding values and aspect/unit IDs are actual copyable host values, not aliases. organizationPlan is mandatory for this worker. Every source unit, including late sections, needs required/context/excluded/uncertain disposition. A compound source unit retains ALL constituent claims and qualifiers in its original contiguous byte range, plus full chunk context; never treat it as a sample. If constituent relevance differs, retain necessary knowledge as required or mark uncertain, not whole-block excluded merely because one constituent is irrelevant. The single purpose aspect is the ENTIRE literal goal: address ALL clauses and constraints together. Punctuation/commas do not create independent factual topics; do not invent facts to populate navigation/style/negative constraints; every literal purpose aspect needs evidenced required units or an explicit unresolved review gap. Do not select easy themes instead of requested knowledge. Context/excluded/uncertain require a concise source-grounded reason; every exclusion/relevance is later assessed against the actual purpose. No unoffered identities or additional JSON keys. summary is a string of at most {MAX_ANALYSIS_SUMMARY_BYTES} UTF-8 bytes. queries is an array of at most {MAX_ANALYSIS_QUERIES} strings, each at most {MAX_ANALYSIS_QUERY_BYTES} UTF-8 bytes; use short keywords, not sentences or the full analysis. conflicts is an array of at most {MAX_ANALYSIS_CONFLICTS} strings, each at most {MAX_ANALYSIS_CONFLICT_BYTES} UTF-8 bytes; use [] when none. All byte limits apply to the decoded strings, not JSON escape spelling. A Chinese character commonly uses 3 UTF-8 bytes: 85 such characters fit in a search, 86 do not. The analysis headings are guidance for summary content, not separate JSON fields. If no Wiki index is supplied, do not claim that an existing page was found."
    )
}

fn generation_output_contract(bindings: &serde_json::Value) -> String {
    let shape = serde_json::to_string(&bindings["exampleProposal"]).unwrap();
    let contract = format!(
        r#"Return only one JSON object with exactly pages, reviewNotes and organizationProof. A valid JSON example with actual copyable IDs/binding is: {shape}. This is an unfinished template: fill actual sourced prose and ALL required source-unit placements; empty placements do not establish completion. organizationProof.binding must copy sourceInventory.binding exactly, and placements is an array of objects with unitId, pageId and exactly one line mode. Omit citationRefs: after strict source/unit/page checks the host derives this selected unit's exact ref and ALL context refs and appends their exact citations to that SAME actual topic. An explicitly supplied citationRefs must be complete and valid; []/null/unknown refs are never filled or corrected by the host. Each placement must select ONE explicit line mode: allLines:true (omit firstLine and lastLine; the host derives the complete actual topic body range), or both firstLine and lastLine as 1-based physical lines. Never mix modes or substitute source line numbers. Whole-page mode does not certify facts: the explicit unit/page/refs, literal anchors and final semantic checks still apply. Cite the exact unit and all context refs on the same target. Compound units require ALL constituent knowledge/qualifiers in the actual topic prose, not a representative sample or raw-only page. Omit hostBodyHashes; the host calculates it from validated actual bodies. Each page object has pageId, expectedRevision, kind, title, markdown, citations and relatedPageIds. Every NEW citation must be {{"ref":"an exact offered citationSpans ref"}}. The ONLY literal exception is an exact unchanged citation already supplied on the SAME read existing pageId; preserve those prior sourceId, revisionId, chunkId and quote fields verbatim, including older revisions. Never reconstruct a new literal quote or remap prior evidence to current refs. Never mix ref with literal fields. citationSpans provides immutable source spans with UTF-8 byte offsets, original line/page positions and a short preview; read the complete source.chunks text to choose the appropriate span. The preview is only a locator, not the quote. The host expands the ref to the complete original span before all citation and semantic-support validation. A full-chunk span is available for facts crossing smaller span boundaries; select it only when that scope is necessary. Unknown or foreign refs are rejected, with no automatic fallback. identityBindings in the input provides actual copyable page/source/revision/chunk identities and an exampleProposal bound to this batch. Copy exact identities from those bindings. The example demonstrates field format only, not a completed page proposal; replace its instructional prose with source-supported content without overwriting retained facts. No ID aliases are supplied. Never shorten IDs, turn them into slugs, infer IDs from titles or choose a similar-looking ID. No additional fields. pages is an array of 1 to {MAX_CANDIDATE_PAGES} objects; at most outputPolicy.maxNewTopicPages may be new topic/entity/synthesis pages, each with at most {MAX_NEW_PAGE_CHARACTERS} Unicode characters; existing complete page updates retain the shared page byte limit. expectedRevision is null for a new page or the exact revisionId of the offered existing page. citations is an array of 1 to {MAX_PAGE_CITATIONS} citation objects, never a string or a map. relatedPageIds is an array of at most {MAX_PAGE_RELATIONS} ID strings; use [] when none. reviewNotes is an array of at most {MAX_REVIEW_NOTES} strings, each at most {MAX_REVIEW_NOTE_BYTES} UTF-8 bytes; use [] when none. title must be nonempty, at most {MAX_TITLE_CHARACTERS} Unicode characters and at most {MAX_TITLE_BYTES} UTF-8 bytes. markdown must be nonempty and at most {WIKI_MAX_PAGE_BYTES} UTF-8 bytes. All byte limits apply to decoded strings. Read actual source text to select the appropriate offered ref; its preview is not the evidence."#
    );
    format!(
        "{contract} Citation evidence comes from source.chunks, not the analysis summary; the host expands selected refs preserving spaces, tabs, newlines, punctuation and hyphenation."
    )
}
