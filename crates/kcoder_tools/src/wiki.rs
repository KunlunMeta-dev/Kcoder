//! Bounded, read-only Wiki access scoped by the trusted execution host.
use crate::{Tool, ToolContext, ToolError, ToolOutput};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope, LibrarySelection};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;

const TEXT_LIMIT: usize = 16_000;
const LIST_LIMIT: usize = 10;

pub struct WikiTool;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    action: String,
    library: Option<String>,
    query: Option<String>,
    page: Option<String>,
    revision: Option<String>,
    source: Option<String>,
    chunk: Option<String>,
    cursor: Option<String>,
}

#[async_trait]
impl Tool for WikiTool {
    fn name(&self) -> String {
        "Wiki".into()
    }
    fn description(&self) -> String {
        "Read personal Wiki only when useful for the user's request. For ordinary retrieval use Wiki({action: \"search\", query: \"keywords\"}), then Wiki({action: \"read\", page: \"returned-page-id\"}). find_pages/read_page belong only to WikiManage for explicit organization, not this tool. Never switch to WikiManage to bypass disabled retrieval. List libraries/pages/sources, search, read a page or source chunk, list its references, or resolve a source citation. Required by action: source needs source + revision even on its first call; citation needs source + revision + chunk; search needs query; read/references need page and also revision whenever cursor is supplied. Get source/revision from sources or search, never invent IDs. libraries/pages/sources need no additional fields. No editing or organizing. Reuse returned library/revision IDs and cursors for subsequent pages. Citation results identify removed or historical sources; do not present them as current evidence without qualification.".into()
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"required":["action"],"properties":{
            "action":{"type":"string","enum":["libraries","pages","sources","source","search","read","references","citation"]},
            "library":{"type":"string","description":"Optional library ID; otherwise use the existing default or sole library."},
            "query":{"type":"string","maxLength":4096,"description":"Required nonempty search query."},
            "page":{"type":"string","description":"Required page ID for read/references; obtain from pages/search."},"revision":{"type":"string","description":"Required source revision ID for source/citation, including the first call. For read/references, optional on first call but required with cursor; reuse the returned page revision. Not the numeric library metadata revision."},
            "source":{"type":"string","description":"Required source ID for source/citation; obtain with its revision from sources/search."},"chunk":{"type":"string","description":"Required chunk ID for citation; obtain from source/references/search."},
            "cursor":{"type":"string","description":"Continuation cursor returned by the same action; keep other arguments unchanged."}
        }})
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn is_read_only(&self) -> bool {
        true
    }
    // Opening the domain catalog may run schema maintenance, so serialize calls.
    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        call_scoped(input, ctx, false)
    }
}

pub(crate) fn read_for_organization(
    input: Value,
    ctx: &ToolContext,
) -> Result<ToolOutput, ToolError> {
    call_scoped(input, ctx, true)
}
fn call_scoped(
    input: Value,
    ctx: &ToolContext,
    organization: bool,
) -> Result<ToolOutput, ToolError> {
    let input: Input =
        serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))?;
    match input.action.as_str() {
        "find_pages" => return Err(ToolError::InvalidInput("Wiki has no find_pages action. For ordinary retrieval use Wiki with action=search and query. WikiManage.find_pages is only for explicitly requested organization; it is not a fallback for disabled retrieval.".into())),
        "read_page" => return Err(ToolError::InvalidInput("Wiki has no read_page action. Use Wiki with action=read and page; include revision when using a cursor. WikiManage.read_page is only for explicit organization.".into())),
        _ => {}
    }
    let result = (|| {
        let path = ctx
            .settings_persistence_path
            .as_deref()
            .context("Wiki is disabled: no target settings")?;
        require_enabled(path, organization)?;
        let principal = std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID");
        let principal = match principal {
            Ok(value) => Some(
                uuid::Uuid::parse_str(&value)
                    .context("invalid host account identity")?
                    .to_string(),
            ),
            Err(std::env::VarError::NotPresent) => None,
            Err(error) => return Err(error.into()),
        };
        execute_for_access(path, principal.as_deref(), &input, organization)
    })()
    .map_err(|e: anyhow::Error| ToolError::Execution(format!("{e:#}")))?;
    Ok(ToolOutput::text(result.to_string()))
}

fn require_enabled(path: &Path, organization: bool) -> Result<()> {
    let document = kcoder_config::read_settings_file(path)?;
    let settings: kcoder_config::KnowledgeSettings = serde_json::from_value(
        document
            .get("knowledge")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )?;
    if organization {
        ensure!(
            settings.can_organize(),
            "Wiki organization is disabled for this target"
        );
    } else {
        ensure!(
            settings.can_retrieve(),
            "Wiki retrieval is disabled for this target"
        );
    }
    Ok(())
}

#[cfg(test)]
fn execute(path: &Path, principal: Option<&str>, input: &Input) -> Result<Value> {
    execute_for_access(path, principal, input, false)
}
fn execute_for_access(
    path: &Path,
    principal: Option<&str>,
    input: &Input,
    organization: bool,
) -> Result<Value> {
    require_enabled(path, organization)?;
    let profile = path
        .parent()
        .context("Wiki profile unavailable")?
        .canonicalize()?;
    let principal = principal
        .map(str::to_owned)
        .unwrap_or_else(|| format!("profile:{}", profile.display()));
    let scope = KnowledgeScope::from_authenticated_host(&principal, "execution-host")?;
    let database = profile.join("knowledge/state.sqlite");
    // Reads never create a catalog or a default library.
    if !database.is_file() {
        return Ok(json!({"status":"empty","libraries":[],"next_cursor":null}));
    }
    let store = KnowledgeCatalog::open(&database)?;
    run(&store, &scope, input)
}

fn required<'a>(value: &'a Option<String>, name: &str) -> Result<&'a str> {
    value
        .as_deref()
        .filter(|s| !s.is_empty())
        .with_context(|| format!("{name} is required"))
}
fn offset(input: &Input) -> Result<usize> {
    input
        .cursor
        .as_deref()
        .unwrap_or("0")
        .parse()
        .context("invalid continuation cursor")
}
fn text_page(text: &str, offset: usize) -> Result<(String, Option<String>)> {
    let length = text.chars().count();
    ensure!(offset <= length, "continuation cursor exceeds text length");
    let body: String = text.chars().skip(offset).take(TEXT_LIMIT).collect();
    let end = offset + body.chars().count();
    Ok((body, (end < length).then(|| end.to_string())))
}
fn libraries(
    store: &KnowledgeCatalog,
    scope: &KnowledgeScope,
    cursor: Option<&str>,
) -> Result<Value> {
    let items = store.list(scope, cursor, LIST_LIMIT + 1)?;
    let next = (items.len() > LIST_LIMIT).then(|| items[LIST_LIMIT - 1].id.clone());
    let items: Vec<_> = items
        .into_iter()
        .take(LIST_LIMIT)
        .map(|l| json!({"id":l.id,"name":l.name,"revision":l.revision,"archived":l.archived}))
        .collect();
    Ok(json!({"libraries":items,"next_cursor":next}))
}
fn run(store: &KnowledgeCatalog, scope: &KnowledgeScope, input: &Input) -> Result<Value> {
    if input.action == "libraries" {
        return libraries(store, scope, input.cursor.as_deref());
    }
    let library = match store.resolve_library(scope, input.library.as_deref(), None)? {
        LibrarySelection::Selected(library) => library,
        LibrarySelection::Empty => return Ok(json!({"status":"empty","libraries":[]})),
        LibrarySelection::NeedsChoice => {
            let mut result = libraries(store, scope, None)?;
            result["status"] = json!("choose_library");
            result["message"] = json!(
                "Ask the user which library to use; use libraries with next_cursor for more choices."
            );
            return Ok(result);
        }
    };
    let mut result = match input.action.as_str() {
        "pages" => {
            let rows =
                store.list_pages(scope, &library.id, input.cursor.as_deref(), LIST_LIMIT + 1)?;
            let next = (rows.len() > LIST_LIMIT).then(|| rows[LIST_LIMIT - 1].page_id.clone());
            let rows: Vec<_> = rows.into_iter().take(LIST_LIMIT).map(|p| json!({"page":p.page_id,"revision":p.revision_id,"title":p.title.chars().take(400).collect::<String>()})).collect();
            json!({"pages":rows,"next_cursor":next})
        }
        "sources" => {
            let rows =
                store.list_sources(scope, &library.id, input.cursor.as_deref(), LIST_LIMIT + 1)?;
            let next = (rows.len() > LIST_LIMIT).then(|| rows[LIST_LIMIT - 1].source_id.clone());
            let rows:Vec<_>=rows.into_iter().take(LIST_LIMIT).map(|source|json!({"source":source.source_id,"revision":source.revision_id,"title":source.title})).collect();
            json!({"sources":rows,"next_cursor":next})
        }
        "source" => {
            let source = required(&input.source, "source")?;
            let revision = required(&input.revision, "revision")?;
            let chunks =
                store.source_chunks(scope, &library.id, source, revision, offset(input)?, 2)?;
            if let Some(chunk) = chunks.first() {
                let (metadata, _) = store.resolve_citation(
                    scope,
                    &library.id,
                    source,
                    revision,
                    &chunk.chunk_id,
                )?;
                json!({"source":source,"revision":revision,"title":metadata.title,"chunk":chunk.chunk_id,"page":chunk.page,"first_line":chunk.first_line,"last_line":chunk.last_line,"text":chunk.text,"next_cursor":(chunks.len()>1).then(||chunk.ordinal.to_string())})
            } else {
                json!({"source":source,"revision":revision,"text":"","next_cursor":null})
            }
        }
        "search" => {
            let rows = store.search(scope, &library.id, required(&input.query, "query")?, 50)?;
            let start = offset(input)?;
            ensure!(start <= rows.len(), "invalid search cursor");
            let end = (start + LIST_LIMIT).min(rows.len());
            let hits: Vec<_> = rows[start..end].iter().map(|h| {
                    let follow_up = if let Some((source, chunk)) = h.document_id.strip_prefix("source:").and_then(|s| s.split_once(':')) {
                        json!({"action":"citation","library":library.id,"source":source,"revision":h.revision_id,"chunk":chunk})
                    } else {
                        json!({"action":"read","library":library.id,"page":h.document_id,"revision":h.revision_id})
                    };
                    json!({"document":h.document_id,"revision":h.revision_id,"title":h.title.chars().take(400).collect::<String>(),"excerpt":h.excerpt.chars().take(800).collect::<String>(),"read":follow_up})
                }).collect();
            json!({"hits":hits,"next_cursor":(end < rows.len()).then(||end.to_string()),"result_window":50,"refine_query_for_more":rows.len()==50})
        }
        "read" | "references" => {
            let page_id = required(&input.page, "page")?;
            ensure!(
                input.cursor.is_none() || input.revision.is_some(),
                "revision is required when continuing a page read"
            );
            let page = store.read_page(scope, &library.id, page_id, input.revision.as_deref())?;
            let mut value = json!({"page":page_id,"revision":page.revision_id,"title":page.draft.title.chars().take(400).collect::<String>()});
            if input.action == "read" {
                let (body, next) = text_page(&page.draft.markdown, offset(input)?)?;
                value["text"] = json!(body);
                value["next_cursor"] = json!(next);
                value["reference_count"] = json!(page.draft.citations.len());
            } else {
                let start = offset(input)?;
                ensure!(
                    start <= page.draft.citations.len(),
                    "invalid reference cursor"
                );
                let end = (start + LIST_LIMIT).min(page.draft.citations.len());
                let refs: Vec<_> = page.draft.citations[start..end].iter().map(|c| json!({"source":c.source_id,"revision":c.revision_id,"chunk":c.chunk_id})).collect();
                value["references"] = json!(refs);
                value["next_cursor"] =
                    json!((end < page.draft.citations.len()).then(|| end.to_string()));
            }
            value
        }
        "citation" => {
            let source = required(&input.source, "source")?;
            let revision = required(&input.revision, "revision")?;
            let chunk = required(&input.chunk, "chunk")?;
            let (metadata, content) =
                store.resolve_citation(scope, &library.id, source, revision, chunk)?;
            let (body, next) = text_page(&content.text, offset(input)?)?;
            let current = store.source_status(scope, &library.id, source)?;
            json!({"source":source,"revision":revision,"chunk":chunk,"title":metadata.title.chars().take(400).collect::<String>(),"removed":metadata.removed,"historical":current.current_revision != revision,"page":content.page,"first_line":content.first_line,"last_line":content.last_line,"text":body,"next_cursor":next})
        }
        _ => anyhow::bail!(
            "unknown Wiki action; supported: libraries, pages, sources, source, search, read, references, citation"
        ),
    };
    result["library"] = json!(library.id);
    result["library_name"] = json!(library.name);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(value: Value) -> Input {
        serde_json::from_value(value).unwrap()
    }
    #[tokio::test]
    async fn misplaced_maintenance_actions_explain_retrieval_without_opening_storage() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(dir.path()));
        for (action, correction) in [
            ("find_pages", "action=search"),
            ("read_page", "action=read"),
        ] {
            let error = WikiTool
                .call(json!({"action":action}), &ctx)
                .await
                .unwrap_err();
            assert!(matches!(error, ToolError::InvalidInput(_)));
            assert!(error.to_string().contains(correction));
        }
    }
    #[test]
    fn source_read_walks_all_chunks_with_revision_pinned_cursors() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&dir.path().join("state.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("reader", "execution-host")?;
        let library = store.create(&scope, "lib", "Wiki", "")?;
        let text = "long source evidence ".repeat(4000);
        let source = store.import_text(&scope, &library.id, "source", "Notes", &text)?;
        let listing = run(&store, &scope, &input(json!({"action":"sources"})))?;
        assert_eq!(listing["sources"][0]["source"], source.source_id);
        let mut cursor = None;
        let mut actual = String::new();
        loop {
            let result = run(
                &store,
                &scope,
                &input(
                    json!({"action":"source","source":source.source_id,"revision":source.revision_id,"cursor":cursor}),
                ),
            )?;
            actual.push_str(result["text"].as_str().unwrap());
            cursor = result["next_cursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(actual, text);
        assert!(
            run(
                &store,
                &scope,
                &input(json!({"action":"source","source":source.source_id,"cursor":"1"}))
            )
            .is_err()
        );
        store.set_archived(&scope, &library.id, library.revision, true)?;
        assert!(
            run(
                &store,
                &scope,
                &input(json!({"action":"sources","library":library.id}))
            )
            .is_err()
        );
        Ok(())
    }
    #[test]
    fn disabled_and_empty_reads_have_no_storage_side_effects() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{}")?;
        let request = input(json!({"action":"libraries"}));
        assert!(
            execute(&path, None, &request)
                .unwrap_err()
                .to_string()
                .contains("disabled")
        );
        assert!(!dir.path().join("knowledge").exists());
        std::fs::write(&path, r#"{"knowledge":{"enabled":true}}"#)?;
        assert_eq!(execute(&path, None, &request)?["status"], "empty");
        assert!(!dir.path().join("knowledge").exists());
        Ok(())
    }
    #[test]
    fn scopes_and_library_choice_are_not_model_controlled() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"knowledge":{"enabled":true}}"#)?;
        std::fs::create_dir(dir.path().join("knowledge"))?;
        let mut store = KnowledgeCatalog::open(&dir.path().join("knowledge/state.sqlite"))?;
        let alice = KnowledgeScope::from_authenticated_host("alice", "execution-host")?;
        let bob = KnowledgeScope::from_authenticated_host("bob", "execution-host")?;
        let other = KnowledgeScope::from_authenticated_host("alice", "other-target")?;
        let a = store.create(&alice, "a", "Alice Wiki", "")?;
        store.create(&bob, "b", "Bob Wiki", "")?;
        store.create(&other, "c", "Other target", "")?;
        let list = execute(&path, Some("alice"), &input(json!({"action":"libraries"})))?;
        assert_eq!(list["libraries"].as_array().unwrap().len(), 1);
        assert_eq!(list["libraries"][0]["id"], a.id);
        assert!(
            execute(
                &path,
                Some("bob"),
                &input(json!({"action":"pages","library":a.id}))
            )
            .is_err()
        );
        store.create(&alice, "d", "Second Wiki", "")?;
        let choice = execute(
            &path,
            Some("alice"),
            &input(json!({"action":"search","query":"hello"})),
        )?;
        assert_eq!(choice["status"], "choose_library");
        assert_eq!(choice["libraries"].as_array().unwrap().len(), 2);
        assert!(
            serde_json::from_value::<Input>(json!({"action":"libraries","owner":"bob"})).is_err()
        );
        std::fs::write(&path, "{}")?;
        assert!(execute(&path, Some("alice"), &input(json!({"action":"libraries"}))).is_err());
        Ok(())
    }
    #[test]
    fn search_returns_resolvable_revision_pinned_citations() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&dir.path().join("state.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("alice", "execution-host")?;
        let library = store.create(&scope, "wiki", "Wiki", "")?;
        let source = store.import_text(
            &scope,
            &library.id,
            "source",
            "Evidence",
            "A distinctive kiwi fact.",
        )?;
        let results = run(
            &store,
            &scope,
            &input(json!({"action":"search", "query":"kiwi"})),
        )?;
        let follow_up = results["hits"][0]["read"].clone();
        assert_eq!(follow_up["revision"], source.revision_id);
        let citation = run(&store, &scope, &input(follow_up))?;
        assert_eq!(citation["text"], "A distinctive kiwi fact.");
        assert_eq!(citation["source"], source.source_id);
        assert_eq!(citation["revision"], source.revision_id);
        assert!(citation["next_cursor"].is_null());
        let page_id = uuid::Uuid::new_v4().to_string();
        let refs = store.commit_generated_pages(
            &scope,
            &library.id,
            "page",
            vec![kcoder_types::knowledge::KnowledgePageDraft {
                page_id: page_id.clone(),
                expected_revision: None,
                title: "Long page".into(),
                kind: kcoder_types::knowledge::KnowledgePageKind::Concept,
                markdown: "你".repeat(TEXT_LIMIT + 3),
                citations: vec![kcoder_types::knowledge::KnowledgeCitation {
                    source_id: source.source_id,
                    revision_id: source.revision_id,
                    chunk_id: citation["chunk"].as_str().unwrap().into(),
                    quote: "kiwi".into(),
                }],
                related_page_ids: vec![],
            }],
        )?;
        let first = run(
            &store,
            &scope,
            &input(json!({"action":"read","page":page_id})),
        )?;
        assert_eq!(first["text"].as_str().unwrap().chars().count(), TEXT_LIMIT);
        assert_eq!(first["revision"], refs[0].revision_id);
        assert!(
            run(
                &store,
                &scope,
                &input(json!({"action":"read","page":page_id,"cursor":first["next_cursor"]}))
            )
            .is_err()
        );
        let last = run(
            &store,
            &scope,
            &input(
                json!({"action":"read","page":page_id,"revision":first["revision"],"cursor":first["next_cursor"]}),
            ),
        )?;
        assert_eq!(last["text"], "你你你");
        assert!(last["next_cursor"].is_null());
        Ok(())
    }
    #[test]
    fn text_pagination_preserves_unicode_and_library_cursor() -> Result<()> {
        let text = "你".repeat(TEXT_LIMIT + 7);
        let (first, next) = text_page(&text, 0)?;
        assert_eq!(first.chars().count(), TEXT_LIMIT);
        let (last, next) = text_page(&text, next.unwrap().parse()?)?;
        assert_eq!(last, "你".repeat(7));
        assert!(next.is_none());
        let dir = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&dir.path().join("state.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("alice", "execution-host")?;
        for n in 0..12 {
            store.create(&scope, &format!("r{n}"), &format!("Wiki {n}"), "")?;
        }
        let first = libraries(&store, &scope, None)?;
        assert_eq!(first["libraries"].as_array().unwrap().len(), 10);
        let last = libraries(&store, &scope, first["next_cursor"].as_str())?;
        assert_eq!(last["libraries"].as_array().unwrap().len(), 2);
        assert!(last["next_cursor"].is_null());
        Ok(())
    }
}
