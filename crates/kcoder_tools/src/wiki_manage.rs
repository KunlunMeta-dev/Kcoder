//! Explicit conversational Wiki maintenance; never accepts a caller-supplied identity.
use crate::{Tool, ToolContext, ToolError, ToolOutput};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope, LibrarySelection};
use kcoder_types::knowledge::KnowledgePageDraft;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;

pub struct WikiManageTool;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    action: String,
    library: Option<String>,
    request_key: Option<String>,
    name: Option<String>,
    purpose: Option<String>,
    expected_revision: Option<u64>,
    title: Option<String>,
    text: Option<String>,
    pages: Option<Vec<KnowledgePageDraft>>,
    job: Option<String>,
    cursor: Option<String>,
    query: Option<String>,
    page: Option<String>,
    revision: Option<String>,
    source: Option<String>,
    chunk: Option<String>,
}
#[async_trait]
impl Tool for WikiManageTool {
    fn name(&self) -> String {
        "WikiManage".into()
    }
    fn description(&self) -> String {
        "Use only for explicitly requested Wiki organization, never to bypass disabled retrieval for ordinary question answering. Ordinary lookup uses Wiki({action: \"search\", query: \"keywords\"}), then Wiki action=read; this tool instead uses find_pages/read_page only to collect evidence for an explicit maintenance task. find_pages/read_page/sources/source/citation read bounded evidence for this maintenance task even when independent retrieval is off. Maintain the user's enabled Wiki when requested: create/select/rename a library, import original text, commit cited generated pages, list/pause organization jobs. Import only saves evidence; organize it with propose_pages after reading sources. Changes to human-edited pages are rejected for Studio review, never bypassed by claiming user confirmation. Required by action: create needs request_key + name; rename needs name + expected_revision; import_text needs request_key + title + text; propose_pages needs request_key + pages; pause needs job; find_pages needs query; read_page needs page (and revision with cursor); source needs source + revision even on its first call; citation needs source + revision + chunk. sources/set_default/allocate_ids/jobs need no extra fields beyond library selection. Reuse returned IDs, never invent revisions. Use stable request_key for retries of identical writes and exact expected revisions. No automatic enablement, arbitrary file paths, or background generation.".into()
    }
    fn input_schema(&self) -> Value {
        let citation = json!({"type":"object","additionalProperties":false,"required":["sourceId","revisionId","chunkId","quote"],"properties":{"sourceId":{"type":"string"},"revisionId":{"type":"string"},"chunkId":{"type":"string"},"quote":{"type":"string","maxLength":16384,"description":"Nonempty exact substring of the identified source revision/chunk, at most 16 KiB UTF-8; never paraphrase."}}});
        let page = json!({"type":"object","additionalProperties":false,"required":["pageId","kind","title","markdown","citations"],"properties":{"pageId":{"type":"string","description":"UUID; obtain new IDs with allocate_ids."},"expectedRevision":{"type":["string","null"],"description":"Current page revision ID required when updating; omit/null for a new page. Read the page first."},"kind":{"type":"string","enum":["overview","source","concept","entity","synthesis","query"]},"title":{"type":"string","maxLength":240},"markdown":{"type":"string","maxLength":1048576},"citations":{"type":"array","minItems":1,"maxItems":128,"items":citation},"relatedPageIds":{"type":"array","maxItems":128,"items":{"type":"string"}}}});
        json!({"type":"object","additionalProperties":false,"required":["action"],"properties":{
            "action":{"type":"string","enum":["create","set_default","rename","import_text","allocate_ids","propose_pages","jobs","pause","find_pages","read_page","sources","source","citation"]},
            "query":{"type":"string","maxLength":4096,"description":"Required nonempty query for find_pages."},"page":{"type":"string","description":"Required page ID for read_page."},"revision":{"type":"string","description":"Required source revision ID for source/citation, including first call. Required page revision for read_page with cursor. Obtain from sources/find_pages/read_page; distinct from numeric expected_revision."},"source":{"type":"string","description":"Required source ID for source/citation."},"chunk":{"type":"string","description":"Required citation chunk ID from source/find_pages or imported evidence."},
            "library":{"type":"string","description":"Returned library ID; defaults to existing preferred/sole library."},
            "request_key":{"type":"string","maxLength":128,"description":"Stable key required for create/import_text/propose_pages."},
            "name":{"type":"string","maxLength":120},"purpose":{"type":"string","maxLength":32768},
            "expected_revision":{"type":"integer","minimum":0,"description":"Library metadata revision required for rename."},
            "title":{"type":"string","maxLength":240},"text":{"type":"string","maxLength":262144,"description":"Required nonempty original text for import_text; at most 256 KiB UTF-8 bytes."},
            "pages":{"type":"array","minItems":1,"maxItems":32,"items":page},
            "job":{"type":"string","description":"Required job ID for pause; obtain from jobs."},"cursor":{"type":"string","description":"Use next_cursor from the same action, preserving library and other arguments; pin revision for read_page. Stop when null."}
        }})
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn is_read_only(&self) -> bool {
        false
    }
    fn is_concurrency_safe(&self, _: &Value) -> bool {
        false
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: Input =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        if matches!(input.action.as_str(), "search" | "read") {
            return Err(ToolError::InvalidInput("WikiManage has no search/read action. Ordinary retrieval uses Wiki action=search/read. For explicitly requested organization only, use WikiManage action=find_pages/read_page; do not bypass disabled retrieval.".into()));
        }
        let read_action = match input.action.as_str() {
            "find_pages" => Some("search"),
            "read_page" => Some("read"),
            "sources" => Some("sources"),
            "source" => Some("source"),
            "citation" => Some("citation"),
            _ => None,
        };
        if let Some(action) = read_action {
            return crate::wiki::read_for_organization(
                json!({"action":action,"library":input.library,"query":input.query,"page":input.page,"revision":input.revision,"source":input.source,"chunk":input.chunk,"cursor":input.cursor}),
                ctx,
            );
        }
        let result = (|| -> Result<Value> {
            let settings = ctx
                .settings_persistence_path
                .as_deref()
                .context("Wiki target settings unavailable")?;
            require_enabled(settings)?;
            let profile = settings
                .parent()
                .context("Wiki profile unavailable")?
                .canonicalize()?;
            let root = profile.join("knowledge");
            if let Some(sandbox) = ctx.sandbox.as_deref() {
                for path in [
                    &root,
                    &root.join("state.sqlite"),
                    &root.join("state.objects"),
                ] {
                    sandbox
                        .check_path(path, true)
                        .map_err(|e| anyhow::anyhow!("Wiki write rejected by sandbox: {e}"))?;
                }
            }
            let principal = match std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID") {
                Ok(id) => uuid::Uuid::parse_str(&id)
                    .context("invalid host account identity")?
                    .to_string(),
                Err(std::env::VarError::NotPresent) => format!("profile:{}", profile.display()),
                Err(e) => return Err(e.into()),
            };
            let scope = KnowledgeScope::from_authenticated_host(&principal, "execution-host")?;
            if let Ok(metadata) = std::fs::symlink_metadata(&root) {
                ensure!(
                    !metadata.file_type().is_symlink() && metadata.is_dir(),
                    "Wiki root must be a private directory"
                );
            }
            std::fs::create_dir_all(&root)?;
            kcoder_config::set_user_only_dir_permissions(&root)?;
            let mut store = KnowledgeCatalog::open(&root.join("state.sqlite"))?;
            require_enabled(settings)?;
            execute(&mut store, &scope, input)
        })()
        .map_err(|e| ToolError::Execution(format!("{e:#}")))?;
        Ok(ToolOutput::text(result.to_string()))
    }
}
fn require_enabled(path: &Path) -> Result<()> {
    let document = kcoder_config::read_settings_file(path)?;
    let settings: kcoder_config::KnowledgeSettings = serde_json::from_value(
        document
            .get("knowledge")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )?;
    ensure!(
        settings.can_organize(),
        "Wiki organization is disabled for this target"
    );
    Ok(())
}
fn required<'a>(value: &'a Option<String>, name: &str) -> Result<&'a str> {
    value
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .with_context(|| format!("{name} is required"))
}
fn execute(store: &mut KnowledgeCatalog, scope: &KnowledgeScope, input: Input) -> Result<Value> {
    ensure!(
        matches!(
            input.action.as_str(),
            "create"
                | "set_default"
                | "rename"
                | "import_text"
                | "allocate_ids"
                | "propose_pages"
                | "jobs"
                | "pause"
        ),
        "unsupported WikiManage action"
    );
    if input.action == "import_text" {
        required(&input.request_key, "request_key")?;
        required(&input.title, "title")?;
        ensure!(
            required(&input.text, "text")?.len() <= 256 * 1024,
            "text exceeds 256 KiB"
        );
    }
    if input.action == "create" {
        return Ok(serde_json::to_value(store.create(
            scope,
            required(&input.request_key, "request_key")?,
            required(&input.name, "name")?,
            input.purpose.as_deref().unwrap_or(""),
        )?)?);
    }
    let selection = if input.action == "import_text" && input.library.is_none() {
        store.ensure_import_library(scope, "Wiki")?
    } else {
        store.resolve_library(scope, input.library.as_deref(), None)?
    };
    let library = match selection {
        LibrarySelection::Selected(library) => library,
        LibrarySelection::Empty => {
            return Ok(json!({"status":"empty","message":"Create a Wiki first."}));
        }
        LibrarySelection::NeedsChoice => {
            return Ok(json!({"status":"choose_library","libraries":store.list(scope,None,10)?}));
        }
    };
    match input.action.as_str() {
        "set_default" => {
            store.set_default_library(scope, &library.id)?;
            Ok(json!({"library":library,"status":"selected"}))
        }
        "rename" => Ok(serde_json::to_value(
            store.update_library(
                scope,
                &library.id,
                input
                    .expected_revision
                    .context("expected_revision is required")?,
                required(&input.name, "name")?,
                input.purpose.as_deref().unwrap_or(&library.purpose),
            )?,
        )?),
        "allocate_ids" => Ok(
            json!({"page_ids":(0..8).map(|_|uuid::Uuid::new_v4().to_string()).collect::<Vec<_>>() }),
        ),
        "import_text" => {
            let text = required(&input.text, "text")?;
            ensure!(text.len() <= 256 * 1024, "text exceeds 256 KiB");
            let source = store.import_text(
                scope,
                &library.id,
                required(&input.request_key, "request_key")?,
                required(&input.title, "title")?,
                text,
            )?;
            let chunks = store.source_chunks(
                scope,
                &library.id,
                &source.source_id,
                &source.revision_id,
                0,
                100,
            )?;
            Ok(
                json!({"status":"imported","library":library.id,"source":source,"first_chunk":chunks.first(),"chunks":chunks.iter().map(|chunk|json!({"chunk":chunk.chunk_id,"firstLine":chunk.first_line,"lastLine":chunk.last_line})).collect::<Vec<_>>(),"next":"Read further source evidence with Wiki citation, then propose_pages. Import alone does not organize."}),
            )
        }
        "propose_pages" => {
            let pages = input.pages.context("pages is required")?;
            match store.commit_generated_pages(
                scope,
                &library.id,
                required(&input.request_key, "request_key")?,
                pages,
            ) {
                Ok(revisions) => Ok(json!({"status":"committed","revisions":revisions})),
                Err(e) if e.is::<kcoder_knowledge::ReviewRequired>() => Ok(
                    json!({"status":"review_required","committed":false,"message":"Human-edited content is protected. No changes committed; use Studio review/edit. This proposal was not queued for approval."}),
                ),
                Err(e) => Err(e),
            }
        }
        "jobs" => {
            let jobs = store.list_jobs(scope, &library.id, input.cursor.as_deref(), 10)?;
            let next = if jobs.len() == 10 {
                jobs.last().map(|j| j.id.clone())
            } else {
                None
            };
            Ok(json!({"jobs":jobs,"next_cursor":next}))
        }
        "pause" => {
            let job = required(&input.job, "job")?;
            store.pause_job(scope, &library.id, job)?;
            Ok(json!({"status":"paused","job":job}))
        }
        _ => anyhow::bail!("unsupported WikiManage action"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(value: Value) -> Input {
        serde_json::from_value(value).unwrap()
    }
    #[tokio::test]
    async fn misplaced_retrieval_actions_explain_the_tool_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(dir.path()));
        for action in ["search", "read"] {
            let error = WikiManageTool
                .call(json!({"action":action}), &ctx)
                .await
                .unwrap_err();
            assert!(matches!(error, ToolError::InvalidInput(_)));
            assert!(error.to_string().contains("Wiki action=search/read"));
            assert!(
                error
                    .to_string()
                    .contains("do not bypass disabled retrieval")
            );
        }
    }
    #[test]
    fn conversational_import_is_idempotent_scoped_and_does_not_claim_generation() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&tmp.path().join("state.sqlite"))?;
        let alice = KnowledgeScope::from_authenticated_host("alice", "execution-host")?;
        let bob = KnowledgeScope::from_authenticated_host("bob", "execution-host")?;
        let args = json!({"action":"import_text","request_key":"source-1","title":"Plan","text":"Launch on Friday."});
        let first = execute(&mut store, &alice, input(args.clone()))?;
        let again = execute(&mut store, &alice, input(args))?;
        assert_eq!(first["source"], again["source"]);
        let library = first["library"].as_str().unwrap();
        assert!(store.list_pages(&alice, library, None, 10)?.is_empty());
        assert!(
            execute(
                &mut store,
                &bob,
                input(json!({"action":"pause","library":library,"job":"anything"}))
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<Input>(json!({"action":"create","owner":"alice"})).is_err()
        );
        let selected = execute(
            &mut store,
            &alice,
            input(json!({"action":"set_default","library":library})),
        )?;
        assert_eq!(selected["status"], "selected");
        Ok(())
    }
    #[test]
    fn generated_commit_validates_evidence_and_cannot_override_human_content() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&tmp.path().join("state.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("alice", "execution-host")?;
        let imported = execute(
            &mut store,
            &scope,
            input(
                json!({"action":"import_text","request_key":"s","title":"Launch","text":"Friday launch"}),
            ),
        )?;
        let library = imported["library"].as_str().unwrap();
        let page_id = uuid::Uuid::new_v4().to_string();
        let page = json!({"pageId":page_id,"kind":"concept","title":"Launch","markdown":"Friday launch","citations":[{"sourceId":imported["source"]["sourceId"],"revisionId":imported["source"]["revisionId"],"chunkId":imported["first_chunk"]["chunkId"],"quote":"Friday"}]});
        let output = execute(
            &mut store,
            &scope,
            input(json!({"action":"propose_pages","request_key":"p","pages":[page]})),
        )?;
        assert_eq!(output["status"], "committed");
        let mut invalid = store.read_page(&scope, library, &page_id, None)?.draft;
        invalid.expected_revision = Some(
            output["revisions"][0]["revisionId"]
                .as_str()
                .unwrap()
                .into(),
        );
        invalid.citations[0].quote = "fabricated".into();
        assert!(
            execute(
                &mut store,
                &scope,
                input(json!({"action":"propose_pages","request_key":"bad","pages":[invalid]}))
            )
            .is_err()
        );
        let current = store.read_page(&scope, library, &page_id, None)?;
        let human = store.edit_page(
            &scope,
            library,
            &page_id,
            &current.revision_id,
            "human",
            "Launch",
            "Human decision",
        )?;
        let mut proposal = current.draft;
        proposal.expected_revision = Some(human.revision_id);
        proposal.markdown = "Model overwrite".into();
        let protected = execute(
            &mut store,
            &scope,
            input(json!({"action":"propose_pages","request_key":"overwrite","pages":[proposal]})),
        )?;
        assert_eq!(protected["status"], "review_required");
        assert_eq!(
            store
                .read_page(&scope, library, &page_id, None)?
                .draft
                .markdown,
            "Human decision"
        );
        assert!(!WikiManageTool.is_read_only());
        assert!(!WikiManageTool.is_concurrency_safe(&json!({})));
        assert!(
            serde_json::from_value::<Input>(
                json!({"action":"propose_pages","user_confirmed":true})
            )
            .is_err()
        );
        Ok(())
    }
    #[tokio::test]
    async fn fresh_profile_creates_private_catalog_and_obeys_sandbox() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let path = tmp.path().join("settings.json");
        std::fs::write(&path, r#"{"knowledge":{"enabled":true}}"#)?;
        let ctx = ToolContext::new(kcoder_state::AppState::new(tmp.path()))
            .with_settings_persistence_path(Some(path));
        WikiManageTool
            .call(
                json!({"action":"create","request_key":"one","name":"Personal"}),
                &ctx,
            )
            .await?;
        assert!(tmp.path().join("knowledge/state.sqlite").is_file());
        let other = tempfile::tempdir()?;
        let sandbox = crate::Sandbox::new(
            other.path(),
            kcoder_types::SandboxConfig {
                enabled: true,
                allowed_paths: vec![other.path().display().to_string()],
                ..Default::default()
            },
        );
        let ctx = ctx.with_sandbox(std::sync::Arc::new(sandbox));
        assert!(
            WikiManageTool
                .call(
                    json!({"action":"create","request_key":"two","name":"Denied"}),
                    &ctx
                )
                .await
                .is_err()
        );
        Ok(())
    }
    #[test]
    fn disabled_profile_is_rejected_without_creating_catalog() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let path = tmp.path().join("settings.json");
        std::fs::write(&path, "{}")?;
        assert!(require_enabled(&path).is_err());
        assert!(!tmp.path().join("knowledge").exists());
        Ok(())
    }
}
