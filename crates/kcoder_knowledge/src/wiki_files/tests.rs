use super::delivery::{DraftContext, deliver, locate};
use super::draft_format::{CitationSpec, parse_draft, parse_review, render_page};
use super::tools::{LibraryAccess, ToolCall, definitions, execute};
use super::tree::{MAX_READ_RESULT_BYTES, WikiTree, validate_path};
use super::workspace::{PlannedUnit, WorkspaceInput, build, chunk_path};
use crate::StoredPage;
use crate::ingest::ingest_citation_refs::CitationRefs;
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
use serde_json::json;

const SOURCE: &str = "source-1";
const REVISION: &str = "revision-1";

fn chunks() -> Vec<crate::SourceChunk> {
    vec![
        crate::SourceChunk {
            page: None,
            ordinal: 1,
            chunk_id: "chunk-a".into(),
            first_line: 1,
            last_line: 3,
            text: "Alpha uses port 8080.\nBeta stores data in SQLite.\nGamma is optional.".into(),
        },
        crate::SourceChunk {
            page: None,
            ordinal: 2,
            chunk_id: "chunk-b".into(),
            first_line: 4,
            last_line: 5,
            text: "Delta requires TLS 1.3.\nEpsilon logs to stderr.".into(),
        },
    ]
}

fn existing() -> StoredPage {
    StoredPage {
        revision_id: "rev-old".into(),
        human_edited: false,
        draft: KnowledgePageDraft {
            page_id: "page-old".into(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "Old \"topic\"".into(),
            markdown: "Old fact.\nKept line.".into(),
            citations: vec![KnowledgeCitation {
                source_id: "older".into(),
                revision_id: "older-rev".into(),
                chunk_id: "older-chunk".into(),
                quote: "Old fact.".into(),
            }],
            related_page_ids: vec![],
        },
    }
}

struct Fixture {
    chunks: Vec<crate::SourceChunk>,
    refs: CitationRefs,
    existing: Vec<StoredPage>,
    new_ids: Vec<String>,
    units: Vec<String>,
}

impl Fixture {
    fn new() -> Self {
        let chunks = chunks();
        Self {
            refs: CitationRefs::new(SOURCE, REVISION, &chunks),
            chunks,
            existing: vec![existing()],
            new_ids: vec!["new-1".into(), "new-2".into(), "overview".into()],
            units: vec!["U1".into()],
        }
    }
    fn context(&self) -> DraftContext<'_> {
        DraftContext {
            source_id: SOURCE,
            revision_id: REVISION,
            chunks: &self.chunks,
            refs: &self.refs,
            existing: &self.existing,
            new_ids: &self.new_ids,
            overview_id: "overview",
            unit_ids: &self.units,
            inventory: None,
        }
    }
    fn tree(&self) -> WikiTree {
        let units = [PlannedUnit {
            id: "U1".into(),
            disposition: "required",
            reason: "Port facts".into(),
            chunk_id: "chunk-a".into(),
            first_line: 1,
            last_line: 1,
            reference: "span-x".into(),
            context_refs: vec![],
        }];
        build(&WorkspaceInput {
            purpose: "Operate the services",
            language: "en",
            source_id: SOURCE,
            revision_id: REVISION,
            chunks: &self.chunks,
            spans: self.refs.metadata(),
            analysis_summary: "Five services",
            conflicts: &[],
            units: &units,
            existing: &self.existing,
            new_ids: &self.new_ids,
            overview_id: "overview",
            topic_limit: 2,
            budget: "- fixture budget",
        })
    }
}

struct Library(Vec<StoredPage>);
impl LibraryAccess for Library {
    fn page(&mut self, page_id: &str) -> anyhow::Result<Option<StoredPage>> {
        Ok(self
            .0
            .iter()
            .find(|page| page.draft.page_id == page_id)
            .cloned())
    }
    fn index(&mut self) -> anyhow::Result<String> {
        Ok("# Library pages\n".into())
    }
}

fn call(name: &str, input: serde_json::Value) -> ToolCall {
    ToolCall {
        id: "call".into(),
        name: name.into(),
        input,
        invalid: false,
    }
}

fn run(
    tree: &mut WikiTree,
    fixture: &Fixture,
    name: &str,
    input: serde_json::Value,
) -> super::tools::ToolOutput {
    execute(
        tree,
        &call(name, input),
        &mut Library(vec![]),
        &fixture.context(),
    )
    .unwrap()
}

#[test]
fn workspace_is_deterministic_and_tree_hash_tracks_every_byte() {
    let fixture = Fixture::new();
    let (first, second) = (fixture.tree(), fixture.tree());
    assert_eq!(first.tree_hash(), second.tree_hash());
    assert!(
        first
            .get("index.md")
            .unwrap()
            .contains("new-1: new topic page")
    );
    assert!(
        first
            .get("index.md")
            .unwrap()
            .contains("reserved for the Wiki overview")
    );
    assert!(first.get("plan.md").unwrap().contains("U1 (required)"));
    assert_eq!(
        first.get("draft/page-old.md"),
        first.get("library/page-old.md")
    );
    let mut changed = first.clone();
    changed
        .write(
            "review.md",
            "# Review\n\n## Blocking\n\n## Notes\n- x\n".into(),
        )
        .unwrap();
    assert_ne!(changed.tree_hash(), first.tree_hash());
    assert!(!first.any_change());
    assert!(changed.any_change());
}

#[test]
fn read_numbers_source_lines_absolutely_and_bounds_results() {
    let fixture = Fixture::new();
    let mut tree = fixture.tree();
    let path = chunk_path(SOURCE, REVISION, &fixture.chunks[1]);
    let output = run(&mut tree, &fixture, "read", json!({"file_path":path}));
    assert!(output.content.contains("     4\tDelta requires TLS 1.3."));
    assert!(output.content.contains("     5\tEpsilon logs to stderr."));
    let tail = run(
        &mut tree,
        &fixture,
        "read",
        json!({"file_path":path,"offset":5}),
    );
    assert!(!tail.content.contains("Delta") && tail.content.contains("Epsilon"));
    let before = run(
        &mut tree,
        &fixture,
        "read",
        json!({"file_path":path,"offset":3}),
    );
    assert!(before.is_error && before.content.contains("wiki_tool_offset_out_of_range"));
    let limited = run(
        &mut tree,
        &fixture,
        "read",
        json!({"file_path":path,"limit":1}),
    );
    assert!(limited.content.contains("nextOffset: 5"));
    // A long file stops at the result bound and reports where to continue.
    let mut big = WikiTree::default();
    big.insert_read_only("big.md", format!("{}\n", "x".repeat(1000)).repeat(200));
    let text = big.read("big.md", None, None).unwrap();
    assert!(text.len() <= MAX_READ_RESULT_BYTES + 64);
    assert!(text.contains("nextOffset: "));
    let listing = run(&mut tree, &fixture, "read", json!({"file_path":"draft"}));
    assert!(listing.content.contains("draft/page-old.md"));
}

#[test]
fn paths_writes_and_edits_stay_inside_the_writable_tree() {
    let fixture = Fixture::new();
    let mut tree = fixture.tree();
    for bad in [
        "/etc/passwd",
        "../index.md",
        "draft/../index.md",
        "C:\\x",
        "draft//x.md",
        "~/x",
    ] {
        assert!(validate_path(bad).is_err(), "{bad}");
        let output = run(&mut tree, &fixture, "read", json!({"file_path":bad}));
        assert!(
            output.is_error && output.content.contains("wiki_tool_path_invalid"),
            "{bad}"
        );
    }
    let before = tree.tree_hash();
    let read_only = run(
        &mut tree,
        &fixture,
        "write",
        json!({"file_path":"plan.md","content":"x"}),
    );
    assert!(read_only.is_error && read_only.content.contains("wiki_tool_read_only"));
    let foreign = run(
        &mut tree,
        &fixture,
        "write",
        json!({"file_path":"draft/invented.md","content":"x"}),
    );
    assert!(foreign.content.contains("wiki_tool_unallocated_page"));
    let unknown = run(&mut tree, &fixture, "shell", json!({"command":"ls"}));
    assert!(unknown.content.contains("wiki_tool_unknown"));
    let invalid = execute(
        &mut tree,
        &ToolCall {
            id: "x".into(),
            name: "write".into(),
            input: json!({}),
            invalid: true,
        },
        &mut Library(vec![]),
        &fixture.context(),
    )
    .unwrap();
    assert!(invalid.is_error && invalid.content.contains("wiki_tool_arguments_json"));
    assert_eq!(
        tree.tree_hash(),
        before,
        "failed tools leave the tree unchanged"
    );
    // Ambiguous edits are atomic failures; replace_all applies every match.
    run(
        &mut tree,
        &fixture,
        "write",
        json!({"file_path":"review.md","content":"## Notes\n- a\n- a\n"}),
    );
    let ambiguous = run(
        &mut tree,
        &fixture,
        "edit",
        json!({"file_path":"review.md","old_string":"- a","new_string":"- b"}),
    );
    assert!(ambiguous.content.contains("wiki_tool_edit_ambiguous"));
    assert_eq!(tree.get("review.md"), Some("## Notes\n- a\n- a\n"));
    let all = run(
        &mut tree,
        &fixture,
        "edit",
        json!({"file_path":"review.md","old_string":"- a","new_string":"- b","replace_all":true}),
    );
    assert!(!all.is_error && all.changed);
    assert_eq!(tree.get("review.md"), Some("## Notes\n- b\n- b\n"));
    let empty = run(
        &mut tree,
        &fixture,
        "edit",
        json!({"file_path":"review.md","old_string":"","new_string":"x"}),
    );
    assert!(empty.content.contains("wiki_tool_edit_empty"));
    let missing = run(
        &mut tree,
        &fixture,
        "edit",
        json!({"file_path":"review.md","old_string":"zzz","new_string":"x"}),
    );
    assert!(missing.content.contains("wiki_tool_edit_not_found"));
    let extra = run(
        &mut tree,
        &fixture,
        "read",
        json!({"file_path":"index.md","command":"x"}),
    );
    assert!(extra.content.contains("wiki_tool_argument"));
}

#[test]
fn library_reads_admit_bounded_updates_and_record_revisions() {
    let fixture = Fixture::new();
    let mut tree = fixture.tree();
    let mut pages = Vec::new();
    for index in 0..8 {
        let mut page = existing();
        page.draft.page_id = format!("lib-{index}");
        page.revision_id = format!("lib-rev-{index}");
        pages.push(page);
    }
    let mut library = Library(pages);
    for index in 0..8 {
        let output = execute(
            &mut tree,
            &call(
                "read",
                json!({"file_path":format!("library/lib-{index}.md")}),
            ),
            &mut library,
            &fixture.context(),
        )
        .unwrap();
        assert!(!output.is_error);
        assert_eq!(output.content.contains("is admitted"), index < 6, "{index}");
    }
    assert_eq!(tree.admitted.len(), 6);
    assert_eq!(tree.read_revisions.len(), 8);
    assert!(tree.check_writable("draft/lib-0.md").is_ok());
    assert!(tree.check_writable("draft/lib-7.md").is_err());
}

#[test]
fn draft_syntax_round_trips_and_strips_host_markers() {
    let text = "---\npageId: new-1   # must match\nkind: concept\ntitle: \"C# \\\"ports\\\"\"\nexpectedRevision: null\nrelatedPageIds: [page-old]\nsourceUnits:\n  - U1\n---\nAlpha listens on 8080 [^c1].\nBeta uses SQLite[^c2] and Delta TLS[^c3]; old[^p1].\n\n[^c1]: ref span-x\n[^c2]: lines chunk-a L2-L2\n[^c3]: quote chunk-b \"Delta requires TLS 1.3.\"\n[^c4]: chunk chunk-b\n[^p1]: existing older-chunk \"Old fact.\"\n";
    let parsed = parse_draft(text);
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.page_id.as_deref(), Some("new-1"));
    assert_eq!(parsed.title.as_deref(), Some("C# \"ports\""));
    assert_eq!(parsed.expected_revision, Some(None));
    assert_eq!(parsed.related_page_ids, ["page-old"]);
    assert_eq!(parsed.source_units.as_deref(), Some(&["U1".to_owned()][..]));
    assert_eq!(parsed.frontmatter_lines, 9);
    assert_eq!(
        parsed.markdown,
        "Alpha listens on 8080.\nBeta uses SQLite and Delta TLS; old."
    );
    assert_eq!(parsed.defs.len(), 4);
    assert_eq!(parsed.defs[1].line, 14);
    assert_eq!(
        parsed.defs[1].spec,
        CitationSpec::Lines {
            chunk: "chunk-a".into(),
            first: 2,
            last: 2
        }
    );
    assert_eq!(parsed.marked.get(&2).map(Vec::len), Some(2));
    let broken =
        parse_draft("---\npageId: x\nunknown: 1\n---\nBody [^c9]\n\n[^c1]: cite something\n");
    let codes: Vec<_> = broken
        .diagnostics
        .iter()
        .map(|d| (d.line, d.code))
        .collect();
    assert!(codes.contains(&(3, "wiki_draft_frontmatter_unknown_key")));
    assert!(codes.contains(&(5, "wiki_draft_citation_undefined")));
    assert!(codes.contains(&(7, "wiki_draft_citation_syntax")));
    // A human-authored footnote is ordinary body text.
    let human = parse_draft("---\npageId: x\n---\nSee note[^1].\n\n[^1]: human footnote\n");
    assert!(human.markdown.contains("[^1]: human footnote"));
    let (blocking, notes, diagnostics) = parse_review(
        "# Review\n\n## Blocking\n- Decide version\n  scope first\n## Notes\n- Minor\n",
    );
    assert_eq!(blocking, ["Decide version scope first"]);
    assert_eq!(notes, ["Minor"]);
    assert!(diagnostics.is_empty());
}

#[test]
fn review_placeholders_keep_real_blocking_notes_and_continuations() {
    let (blocking, notes, diagnostics) = parse_review(
        "# Review\n## Blocking\n无。\n- None.\n- No blockers!\n- 无法核实来源\n- 无。\n  仍需确认表格版本\n## Notes\n- 无。\n",
    );
    assert_eq!(blocking, ["无法核实来源", "无。 仍需确认表格版本"]);
    assert_eq!(notes, ["无。"]);
    assert!(diagnostics.is_empty());
}

#[test]
fn delivery_expands_four_citation_forms_and_keeps_prior_citations() {
    let fixture = Fixture::new();
    let mut tree = fixture.tree();
    let span = fixture.refs.metadata()[0]["ref"]
        .as_str()
        .unwrap()
        .to_owned();
    let page = format!(
        "---\npageId: new-1\nkind: concept\ntitle: Services\nrelatedPageIds: [page-old]\n---\nAlpha uses port 8080.[^c1]\nBeta[^c2] Delta[^c3] Epsilon[^c4]\n\n[^c1]: ref {span}\n[^c2]: lines chunk-a L2-L2\n[^c3]: quote chunk-b \"Delta requires TLS 1.3.\"\n[^c4]: chunk chunk-b\n"
    );
    let written = run(
        &mut tree,
        &fixture,
        "write",
        json!({"file_path":"draft/new-1.md","content":page}),
    );
    assert!(
        written.content.contains("diagnostics: none"),
        "{}",
        written.content
    );
    let seed = tree
        .get("draft/page-old.md")
        .unwrap()
        .replace("Kept line.", "Kept line.\nNew: Gamma is optional.[^c1]")
        + "[^c1]: lines chunk-a L3-L3\n";
    run(
        &mut tree,
        &fixture,
        "write",
        json!({"file_path":"draft/page-old.md","content":seed}),
    );
    let delivery = deliver(&tree, &fixture.context());
    assert!(delivery.errors.is_empty(), "{:?}", delivery.errors);
    let new_page = delivery
        .proposal
        .pages
        .iter()
        .find(|p| p.page_id == "new-1")
        .unwrap();
    assert_eq!(new_page.citations.len(), 4);
    assert_eq!(new_page.citations[1].quote, "Beta stores data in SQLite.\n");
    assert_eq!(new_page.citations[3].quote, fixture.chunks[1].text);
    assert_eq!(new_page.expected_revision, None);
    let updated = delivery
        .proposal
        .pages
        .iter()
        .find(|p| p.page_id == "page-old")
        .unwrap();
    assert_eq!(updated.expected_revision.as_deref(), Some("rev-old"));
    assert_eq!(
        updated.citations[0],
        existing().draft.citations[0],
        "prior first"
    );
    assert_eq!(updated.citations[1].quote, "Gamma is optional.");
    assert!(updated.markdown.ends_with("New: Gamma is optional."));
    assert!(!updated.markdown.contains("[^"));
}

#[test]
fn unchanged_seed_is_not_an_update_and_failures_map_to_file_lines() {
    let fixture = Fixture::new();
    let mut tree = fixture.tree();
    assert!(deliver(&tree, &fixture.context()).proposal.pages.is_empty());
    let page = "---\npageId: new-2\nkind: concept\ntitle: Wrong\n---\nPort 9090.[^c1]\n\n[^c1]: quote chunk-a \"Alpha uses port 9090.\"\n[^c2]: lines chunk-z L1-L1\n";
    let written = run(
        &mut tree,
        &fixture,
        "write",
        json!({"file_path":"draft/new-2.md","content":page}),
    );
    assert!(
        written
            .content
            .contains("draft/new-2.md:L8 wiki_evidence_quote_span"),
        "{}",
        written.content
    );
    assert!(
        written
            .content
            .contains("draft/new-2.md:L9 wiki_evidence_chunk_not_supplied")
    );
    let delivery = deliver(&tree, &fixture.context());
    assert!(delivery.failing_pages.contains("new-2"));
    let located: Vec<String> = delivery.errors.iter().map(ToString::to_string).collect();
    assert!(located.contains(&"draft/new-2.md:L8 wiki_evidence_quote_span".to_owned()));
    assert!(located.contains(&"draft/new-2.md:L6 wiki_evidence_citations_bounds".to_owned()));
    // Host pointers resolve to the same files and definition lines.
    let page = "---\npageId: new-1\nkind: concept\ntitle: Ok\n---\nGamma[^c1]\n\n[^c1]: lines chunk-a L3-L3\n";
    run(
        &mut tree,
        &fixture,
        "write",
        json!({"file_path":"draft/new-1.md","content":page}),
    );
    let delivery = deliver(&tree, &fixture.context());
    let index = delivery
        .proposal
        .pages
        .iter()
        .position(|p| p.page_id == "new-1")
        .unwrap();
    assert_eq!(
        locate(
            &format!("/pages/{index}/citations/0/quote"),
            &delivery.maps,
            &delivery.proposal
        ),
        ("draft/new-1.md".into(), 8)
    );
    assert_eq!(
        locate(
            &format!("/pages/{index}/title"),
            &delivery.maps,
            &delivery.proposal
        ),
        ("draft/new-1.md".into(), 4)
    );
    // Changing a seeded base revision is rejected at its frontmatter line.
    let seed = tree
        .get("draft/page-old.md")
        .unwrap()
        .replace("expectedRevision: rev-old", "expectedRevision: other");
    let output = run(
        &mut tree,
        &fixture,
        "write",
        json!({"file_path":"draft/page-old.md","content":seed}),
    );
    assert!(
        output
            .content
            .contains("draft/page-old.md:L5 wiki_candidate_base_revision"),
        "{}",
        output.content
    );
}

#[test]
fn rendered_existing_pages_show_prior_citations_read_only() {
    let rendered = render_page(&existing());
    assert!(rendered.contains("title: \"Old \\\"topic\\\"\""));
    assert!(rendered.contains("[^p1]: existing older-chunk \"Old fact.\""));
    let parsed = parse_draft(&rendered);
    assert!(parsed.diagnostics.is_empty());
    assert_eq!(parsed.markdown, "Old fact.\nKept line.");
    assert!(parsed.defs.is_empty());
}

#[test]
fn tool_definitions_are_flat_and_gemini_compatible() {
    let tools = definitions();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        ["read", "edit", "write"]
    );
    for tool in tools {
        let schema = serde_json::to_string(&tool.input_schema).unwrap();
        assert!(!schema.contains("oneOf") && !schema.contains("anyOf") && !schema.contains("$ref"));
        assert!(
            tool.name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        );
        assert!(tool.description.contains("not a filesystem"));
    }
}
