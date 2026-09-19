use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use kcoder_memory::{
    MemoryObservation, MemoryOrderBy, MemorySearchOptions, MemorySummary,
    MemorySummarySearchOptions, sanitize_memory_text,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Store a fact into long-term memory.
#[derive(Debug, Default)]
pub struct MemoryTool;

/// Search structured long-term memory observations.
#[derive(Debug, Default)]
pub struct MemorySearchTool;

/// Fetch one structured long-term memory observation by id.
#[derive(Debug, Default)]
pub struct MemoryGetTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RememberInput {
    /// The fact to remember.
    pub fact: String,
    /// Category of the memory (e.g. "user", "project"). Defaults to "general".
    pub category: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MemorySearchInput {
    /// Full-text query. Omit to list recent structured memories.
    pub query: Option<String>,
    /// Optional observation type/category filter, such as "user", "project", or "bugfix".
    pub observation_type: Option<String>,
    /// Optional concept filters. All provided concepts must match.
    pub concepts: Option<Vec<String>>,
    /// Optional file path filters. Matches files read or modified by substring.
    pub files: Option<Vec<String>>,
    /// Memory records to search. Defaults to both observations and summaries.
    #[serde(default)]
    pub scope: MemorySearchScope,
    /// Optional session id filter. Applies only to the summaries branch.
    pub session_id: Option<String>,
    /// Maximum number of results. Defaults to 10 and is capped at 50.
    pub limit: Option<usize>,
}

#[derive(Debug, Default, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemorySearchScope {
    Observations,
    Summaries,
    #[default]
    Both,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MemoryGetInput {
    /// Structured memory id returned by memory_search, timeline_lookup, or prompt memory entries.
    pub id: Option<i64>,
    /// Structured memory ids to fetch in one call. Capped at 50.
    pub ids: Option<Vec<i64>>,
    /// Memory kind to fetch: "observation" (default) or "summary".
    pub kind: Option<String>,
    /// Number of same-session observations before the anchor. Defaults to 5 and is capped at 50.
    pub before: Option<usize>,
    /// Number of same-session observations after the anchor. Defaults to 5 and is capped at 50.
    pub after: Option<usize>,
}

#[derive(Debug, Serialize)]
struct MemorySearchResponse {
    count: usize,
    results: Vec<Value>,
}

#[derive(Debug, Serialize)]
struct MemoryGetResponse {
    kind: String,
    found: bool,
    count: usize,
    observation: Option<MemoryObservationView>,
    summary: Option<MemorySummaryView>,
    observations: Vec<MemoryObservationView>,
    summaries: Vec<MemorySummaryView>,
}

#[derive(Debug, Serialize)]
struct MemoryTimelineResponse {
    anchor_id: i64,
    count: usize,
    items: Vec<MemoryTimelineItem>,
    observations: Vec<MemoryObservationView>,
    summaries: Vec<MemorySummaryView>,
}

#[derive(Debug, Serialize)]
struct MemoryObservationSummary {
    id: i64,
    observation_type: String,
    title: Option<String>,
    narrative: Option<String>,
    facts: Vec<String>,
    concepts: Vec<String>,
    files_modified: Vec<String>,
    source: String,
    created_at_epoch: u64,
}

#[derive(Debug, Clone, Serialize)]
struct MemoryObservationView {
    id: i64,
    session_id: String,
    project_key: String,
    prompt_number: Option<u64>,
    observation_type: String,
    title: Option<String>,
    subtitle: Option<String>,
    narrative: Option<String>,
    facts: Vec<String>,
    concepts: Vec<String>,
    files_read: Vec<String>,
    files_modified: Vec<String>,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
    source: String,
    generated_by_model: Option<String>,
    created_at_epoch: u64,
}

#[derive(Debug, Clone, Serialize)]
struct MemorySummaryView {
    id: i64,
    session_id: String,
    project_key: String,
    prompt_number: Option<u64>,
    request: Option<String>,
    investigated: Option<String>,
    learned: Option<String>,
    completed: Option<String>,
    next_steps: Option<String>,
    notes: Option<String>,
    created_at_epoch: u64,
}

#[derive(Debug, Serialize)]
struct MemoryTimelineItem {
    kind: &'static str,
    created_at_epoch: u64,
    observation: Option<MemoryObservationView>,
    summary: Option<MemorySummaryView>,
}

#[async_trait]
impl Tool for MemoryTool {
    fn name(&self) -> String {
        "remember".to_string()
    }

    fn description(&self) -> String {
        "Store a durable fact into the structured long-term memory store (sqlite), retrievable in future sessions via memory_search/memory_get. Use it for user preferences, project constraints, decisions, and lessons that should outlive this session. Do NOT use it for scratch notes or the user's own curated notes: those belong to the user's ~/.kcoder/local-memory/ space, which is user-managed and read via LocalMemoryRecall instead.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(RememberInput))
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: RememberInput = parse_input(&input)?;
        let category = input.category.unwrap_or_else(|| "general".to_string());
        let Some(fact) = sanitize_memory_text(&input.fact) else {
            return Ok(ToolOutput::text(
                "Memory skipped: content was marked private.",
            ));
        };

        if let Some(manager) = &ctx.memory_manager {
            manager
                .remember_tool(&category, &fact)
                .map_err(|e| ToolError::Execution(format!("failed to save memory: {}", e)))?;
            Ok(ToolOutput::text(format!(
                "Remembered ({}): {}",
                category, fact
            )))
        } else if let Some(store) = &ctx.memory_store {
            store
                .add(&category, &fact, "tool")
                .map_err(|e| ToolError::Execution(format!("failed to save memory: {}", e)))?;
            Ok(ToolOutput::text(format!(
                "Remembered ({}): {}",
                category, fact
            )))
        } else {
            Err(ToolError::Execution(
                "memory store is not available".to_string(),
            ))
        }
    }
}

#[async_trait]
impl Tool for MemorySearchTool {
    fn name(&self) -> String {
        "memory_search".to_string()
    }

    fn description(&self) -> String {
        "Search structured long-term memory observations and session summaries by content. Use scope=observations for fine-grained facts, scope=summaries for prior progress and conclusions, or scope=both (default). Fetch an exact hit or its observation timeline with memory_get. Use LocalMemoryRecall for the user's curated ~/.kcoder/local-memory/ notes, and remember to write a new durable fact."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(MemorySearchInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: MemorySearchInput = parse_input(&input)?;
        let Some(manager) = &ctx.memory_manager else {
            return Err(ToolError::Execution(
                "memory manager is not available".to_string(),
            ));
        };
        let query = input
            .query
            .as_deref()
            .map(str::trim)
            .filter(|query| !query.is_empty());
        let limit = input.limit.unwrap_or(10).clamp(1, 50);
        let order_by = if query.is_some() {
            MemoryOrderBy::Relevance
        } else {
            MemoryOrderBy::DateDesc
        };
        let mut observation_results = Vec::new();
        if matches!(
            input.scope,
            MemorySearchScope::Observations | MemorySearchScope::Both
        ) {
            let options = MemorySearchOptions {
                observation_type: input.observation_type,
                concepts: input.concepts.unwrap_or_default(),
                files: input.files.unwrap_or_default(),
                limit: Some(limit),
                order_by,
                ..MemorySearchOptions::default()
            };
            for observation in manager
                .search_structured_observations_with_options(query, options)
                .map_err(|e| ToolError::Execution(format!("failed to search memory: {e}")))?
            {
                observation_results.push(search_result_value(
                    "observation",
                    MemoryObservationSummary::from(observation),
                )?);
            }
        }
        let mut summary_results = Vec::new();
        if matches!(
            input.scope,
            MemorySearchScope::Summaries | MemorySearchScope::Both
        ) {
            let options = MemorySummarySearchOptions {
                session_id: input.session_id,
                limit: Some(limit),
                order_by,
                ..MemorySummarySearchOptions::default()
            };
            for summary in manager
                .search_structured_summaries(query, options)
                .map_err(|e| {
                    ToolError::Execution(format!("failed to search memory summaries: {e}"))
                })?
            {
                summary_results.push(search_result_value(
                    "summary",
                    MemorySummaryView::from(summary),
                )?);
            }
        }
        let results =
            merge_search_results(query.is_some(), observation_results, summary_results, limit);
        let response = MemorySearchResponse {
            count: results.len(),
            results,
        };
        json_output(&response)
    }
}

#[async_trait]
impl Tool for MemoryGetTool {
    fn name(&self) -> String {
        "memory_get".to_string()
    }

    fn description(&self) -> String {
        "Fetch structured long-term memory by id. Use id/ids for exact observations or summaries (kind=summary); add before and/or after with one observation id to fetch its same-session timeline. Search by content with memory_search first. Use LocalMemoryRecall for the user's curated notes and remember to write a new durable fact."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(MemoryGetInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: MemoryGetInput = parse_input(&input)?;
        let Some(manager) = &ctx.memory_manager else {
            return Err(ToolError::Execution(
                "memory manager is not available".to_string(),
            ));
        };
        if input.before.is_some() || input.after.is_some() {
            if input.ids.is_some()
                || input
                    .kind
                    .as_deref()
                    .is_some_and(|kind| kind != "observation")
            {
                return Err(ToolError::InvalidInput(
                    "before/after require one observation id and cannot be combined with ids or kind=summary".to_string(),
                ));
            }
            let id = input.id.filter(|id| *id > 0).ok_or_else(|| {
                ToolError::InvalidInput(
                    "before/after require one positive observation id".to_string(),
                )
            })?;
            return timeline_lookup(manager, id, input.before, input.after);
        }
        let kind = input
            .kind
            .as_deref()
            .map(str::trim)
            .filter(|kind| !kind.is_empty())
            .unwrap_or("observation");
        let ids = memory_get_ids(&input)?;

        match kind {
            "observation" => {
                let mut observations = Vec::new();
                for id in ids {
                    if let Some(observation) = manager
                        .get_structured_observation(id)
                        .map_err(|e| ToolError::Execution(format!("failed to get memory: {}", e)))?
                    {
                        observations.push(MemoryObservationView::from(observation));
                    }
                }
                let observation = observations.first().cloned();
                json_output(&MemoryGetResponse {
                    kind: "observation".to_string(),
                    found: !observations.is_empty(),
                    count: observations.len(),
                    observation,
                    summary: None,
                    observations,
                    summaries: Vec::new(),
                })
            }
            "summary" => {
                let mut summaries = Vec::new();
                for id in ids {
                    if let Some(summary) = manager
                        .get_structured_summary(id)
                        .map_err(|e| ToolError::Execution(format!("failed to get memory: {}", e)))?
                    {
                        summaries.push(MemorySummaryView::from(summary));
                    }
                }
                let summary = summaries.first().cloned();
                json_output(&MemoryGetResponse {
                    kind: "summary".to_string(),
                    found: !summaries.is_empty(),
                    count: summaries.len(),
                    observation: None,
                    summary,
                    observations: Vec::new(),
                    summaries,
                })
            }
            _ => Err(ToolError::InvalidInput(
                "kind must be observation or summary".to_string(),
            )),
        }
    }
}

fn timeline_lookup(
    manager: &kcoder_memory::MemoryManager,
    id: i64,
    before: Option<usize>,
    after: Option<usize>,
) -> Result<ToolOutput, ToolError> {
    let before = before.unwrap_or(5).clamp(0, 50);
    let after = after.unwrap_or(5).clamp(0, 50);
    let observations = manager
        .structured_timeline_around(id, before, after)
        .map_err(|e| ToolError::Execution(format!("failed to get memory timeline: {}", e)))?
        .into_iter()
        .map(MemoryObservationView::from)
        .collect::<Vec<_>>();
    let session_id = observations
        .iter()
        .find(|observation| observation.id == id)
        .map(|observation| observation.session_id.as_str())
        .or_else(|| {
            observations
                .first()
                .map(|observation| observation.session_id.as_str())
        });
    let summaries = if let Some(session_id) = session_id {
        manager
            .structured_summaries_for_session(session_id, (before + after + 1).clamp(1, 50))
            .map_err(|e| ToolError::Execution(format!("failed to get memory summaries: {}", e)))?
            .into_iter()
            .map(MemorySummaryView::from)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let items = timeline_items(&observations, &summaries);
    json_output(&MemoryTimelineResponse {
        anchor_id: id,
        count: items.len(),
        items,
        observations,
        summaries,
    })
}

fn search_result_value<T: Serialize>(kind: &str, value: T) -> Result<Value, ToolError> {
    let mut value = serde_json::to_value(value)
        .map_err(|e| ToolError::Execution(format!("failed to serialize memory result: {e}")))?;
    value
        .as_object_mut()
        .expect("memory search result is an object")
        .insert("kind".to_string(), Value::String(kind.to_string()));
    Ok(value)
}

fn merge_search_results(
    relevance_ordered: bool,
    observations: Vec<Value>,
    summaries: Vec<Value>,
    limit: usize,
) -> Vec<Value> {
    if relevance_ordered {
        let mut results = Vec::with_capacity(limit);
        let mut observations = observations.into_iter();
        let mut summaries = summaries.into_iter();
        loop {
            let before = results.len();
            if let Some(observation) = observations.next() {
                results.push(observation);
                if results.len() == limit {
                    break;
                }
            }
            if let Some(summary) = summaries.next() {
                results.push(summary);
                if results.len() == limit {
                    break;
                }
            }
            if results.len() == before {
                break;
            }
        }
        return results;
    }

    let mut results = observations;
    results.extend(summaries);
    results.sort_by(|a, b| {
        b.get("created_at_epoch")
            .and_then(Value::as_u64)
            .cmp(&a.get("created_at_epoch").and_then(Value::as_u64))
    });
    results.truncate(limit);
    results
}

impl From<MemoryObservation> for MemoryObservationSummary {
    fn from(observation: MemoryObservation) -> Self {
        Self {
            id: observation.id,
            observation_type: observation.observation_type,
            title: observation.title,
            narrative: observation.narrative,
            facts: observation.facts,
            concepts: observation.concepts,
            files_modified: observation.files_modified,
            source: observation.source,
            created_at_epoch: observation.created_at_epoch,
        }
    }
}

impl From<MemoryObservation> for MemoryObservationView {
    fn from(observation: MemoryObservation) -> Self {
        Self {
            id: observation.id,
            session_id: observation.session_id,
            project_key: observation.project_key,
            prompt_number: observation.prompt_number,
            observation_type: observation.observation_type,
            title: observation.title,
            subtitle: observation.subtitle,
            narrative: observation.narrative,
            facts: observation.facts,
            concepts: observation.concepts,
            files_read: observation.files_read,
            files_modified: observation.files_modified,
            tool_name: observation.tool_name,
            tool_call_id: observation.tool_call_id,
            source: observation.source,
            generated_by_model: observation.generated_by_model,
            created_at_epoch: observation.created_at_epoch,
        }
    }
}

impl From<MemorySummary> for MemorySummaryView {
    fn from(summary: MemorySummary) -> Self {
        Self {
            id: summary.id,
            session_id: summary.session_id,
            project_key: summary.project_key,
            prompt_number: summary.prompt_number,
            request: summary.request,
            investigated: summary.investigated,
            learned: summary.learned,
            completed: summary.completed,
            next_steps: summary.next_steps,
            notes: summary.notes,
            created_at_epoch: summary.created_at_epoch,
        }
    }
}

fn timeline_items(
    observations: &[MemoryObservationView],
    summaries: &[MemorySummaryView],
) -> Vec<MemoryTimelineItem> {
    let mut items = observations
        .iter()
        .cloned()
        .map(|observation| MemoryTimelineItem {
            kind: "observation",
            created_at_epoch: observation.created_at_epoch,
            observation: Some(observation),
            summary: None,
        })
        .chain(summaries.iter().cloned().map(|summary| MemoryTimelineItem {
            kind: "summary",
            created_at_epoch: summary.created_at_epoch,
            observation: None,
            summary: Some(summary),
        }))
        .collect::<Vec<_>>();
    items.sort_by(|a, b| {
        a.created_at_epoch
            .cmp(&b.created_at_epoch)
            .then_with(|| a.kind.cmp(b.kind))
    });
    items
}

fn memory_get_ids(input: &MemoryGetInput) -> Result<Vec<i64>, ToolError> {
    let mut ids = Vec::new();
    if let Some(id) = input.id {
        ids.push(id);
    }
    if let Some(batch) = &input.ids {
        ids.extend(batch.iter().copied());
    }
    let mut unique = Vec::new();
    for id in ids {
        if id > 0 && !unique.contains(&id) {
            unique.push(id);
        }
    }
    let mut ids = unique;
    if ids.is_empty() {
        return Err(ToolError::InvalidInput(
            "id or ids must include at least one positive memory id".to_string(),
        ));
    }
    ids.truncate(50);
    Ok(ids)
}

fn json_output<T: Serialize>(value: &T) -> Result<ToolOutput, ToolError> {
    serde_json::to_string_pretty(value)
        .map(ToolOutput::text)
        .map_err(|e| ToolError::Execution(format!("failed to serialize memory response: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_memory::{MemoryManager, MemoryStore, MemorySummaryInput, StructuredMemoryStore};
    use kcoder_state::AppState;
    use kcoder_types::ContentBlock;
    use serde_json::json;
    use std::sync::Arc;
    use tempfile::TempDir;

    #[test]
    fn queried_memory_results_preserve_each_source_relevance_order() {
        let results = merge_search_results(
            true,
            vec![
                json!({"kind": "observation", "id": 1, "created_at_epoch": 10}),
                json!({"kind": "observation", "id": 2, "created_at_epoch": 30}),
            ],
            vec![
                json!({"kind": "summary", "id": 3, "created_at_epoch": 5}),
                json!({"kind": "summary", "id": 4, "created_at_epoch": 40}),
            ],
            3,
        );

        let ids = results
            .iter()
            .map(|result| result["id"].as_i64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![1, 3, 2]);
    }

    #[test]
    fn unqueried_memory_results_are_merged_by_recency() {
        let results = merge_search_results(
            false,
            vec![json!({"id": 1, "created_at_epoch": 10})],
            vec![json!({"id": 2, "created_at_epoch": 20})],
            2,
        );

        assert_eq!(results[0]["id"].as_i64(), Some(2));
        assert_eq!(results[1]["id"].as_i64(), Some(1));
    }

    #[tokio::test]
    async fn remember_tool_uses_memory_manager_for_structured_dual_write() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = Arc::new(
            MemoryManager::global_only(global)
                .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a"),
        );
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_memory_manager(manager.clone());

        let output = MemoryTool
            .call(
                json!({
                    "fact": "use anyhow Context for operational errors",
                    "category": "project"
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(!output.is_error);
        assert_eq!(manager.global_store().list().len(), 1);
        let observations = manager
            .search_structured_observations(Some("anyhow Context"), 10)
            .unwrap();
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].source, "tool");
        assert_eq!(observations[0].tool_name.as_deref(), Some("remember"));
    }

    #[tokio::test]
    async fn remember_tool_strips_private_content_from_output_and_storage() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = Arc::new(
            MemoryManager::global_only(global)
                .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a"),
        );
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_memory_manager(manager.clone());

        let output = MemoryTool
            .call(
                json!({
                    "fact": "use Rust <private>secret token</private>",
                    "category": "project"
                }),
                &ctx,
            )
            .await
            .unwrap();

        let text = output_text(&output);
        assert!(text.contains("use Rust"));
        assert!(!text.contains("secret token"));
        assert_eq!(manager.global_store().list()[0].fact, "use Rust");

        let skipped = MemoryTool
            .call(
                json!({
                    "fact": "<private>secret token</private>",
                    "category": "project"
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(output_text(&skipped).contains("skipped"));
        assert!(!output_text(&skipped).contains("secret token"));
        assert_eq!(manager.global_store().list().len(), 1);
    }

    #[tokio::test]
    async fn memory_search_and_get_return_structured_observations() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = Arc::new(
            MemoryManager::global_only(global)
                .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a"),
        );
        manager
            .remember_tool("project", "use anyhow Context for operational errors")
            .unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_memory_manager(manager);

        let search_output = MemorySearchTool
            .call(json!({"query": "anyhow Context", "limit": 5}), &ctx)
            .await
            .unwrap();
        let search: Value = serde_json::from_str(output_text(&search_output)).unwrap();
        assert_eq!(search["count"].as_u64(), Some(1));
        let id = search["results"][0]["id"].as_i64().unwrap();

        let get_output = MemoryGetTool.call(json!({"id": id}), &ctx).await.unwrap();
        let get: Value = serde_json::from_str(output_text(&get_output)).unwrap();
        assert_eq!(get["found"].as_bool(), Some(true));
        assert_eq!(get["count"].as_u64(), Some(1));
        assert_eq!(get["kind"].as_str(), Some("observation"));
        assert_eq!(get["observation"]["tool_name"].as_str(), Some("remember"));
        assert_eq!(get["observations"].as_array().unwrap().len(), 1);
        assert!(get["summary"].is_null());
    }

    #[tokio::test]
    async fn memory_get_returns_batch_observations() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = Arc::new(
            MemoryManager::global_only(global)
                .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a"),
        );
        manager
            .remember_tool("project", "first batch memory")
            .unwrap();
        manager
            .remember_tool("project", "second batch memory")
            .unwrap();
        let observations = manager.search_structured_observations(None, 10).unwrap();
        let ids = observations
            .iter()
            .map(|observation| observation.id)
            .collect::<Vec<_>>();
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_memory_manager(manager);

        let get_output = MemoryGetTool
            .call(json!({"ids": [ids[0], ids[1], ids[0]]}), &ctx)
            .await
            .unwrap();
        let get: Value = serde_json::from_str(output_text(&get_output)).unwrap();

        assert_eq!(get["found"].as_bool(), Some(true));
        assert_eq!(get["count"].as_u64(), Some(2));
        assert_eq!(get["observations"].as_array().unwrap().len(), 2);
        assert_eq!(get["observation"]["id"].as_i64(), Some(ids[0]));
        assert!(get["summaries"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn memory_get_returns_structured_summary() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = Arc::new(
            MemoryManager::global_only(global)
                .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a"),
        );
        let id = manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "memory-manager".to_string(),
                project_key: String::new(),
                prompt_number: Some(7),
                request: Some("context compaction".to_string()),
                investigated: Some("memory subsystem".to_string()),
                learned: Some("summary details".to_string()),
                completed: Some("summary get path".to_string()),
                next_steps: Some("wire retrieval into tools".to_string()),
                notes: None,
                created_at_epoch: 9_000_000_000_001,
            })
            .unwrap()
            .unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_memory_manager(manager);

        let get_output = MemoryGetTool
            .call(json!({"id": id, "kind": "summary"}), &ctx)
            .await
            .unwrap();
        let get: Value = serde_json::from_str(output_text(&get_output)).unwrap();

        assert_eq!(get["found"].as_bool(), Some(true));
        assert_eq!(get["kind"].as_str(), Some("summary"));
        assert_eq!(get["count"].as_u64(), Some(1));
        assert!(get["observation"].is_null());
        assert_eq!(get["summary"]["learned"].as_str(), Some("summary details"));
        assert_eq!(get["summary"]["prompt_number"].as_u64(), Some(7));
        assert_eq!(get["summaries"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn memory_get_returns_batch_summaries() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = Arc::new(
            MemoryManager::global_only(global)
                .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a"),
        );
        let first = manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(1),
                request: Some("first summary".to_string()),
                investigated: None,
                learned: Some("first summary details".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 1_000,
            })
            .unwrap()
            .unwrap();
        let second = manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(2),
                request: Some("second summary".to_string()),
                investigated: None,
                learned: Some("second summary details".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 2_000,
            })
            .unwrap()
            .unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_memory_manager(manager);

        let get_output = MemoryGetTool
            .call(json!({"ids": [first, second], "kind": "summary"}), &ctx)
            .await
            .unwrap();
        let get: Value = serde_json::from_str(output_text(&get_output)).unwrap();

        assert_eq!(get["found"].as_bool(), Some(true));
        assert_eq!(get["count"].as_u64(), Some(2));
        assert!(get["observation"].is_null());
        assert_eq!(get["summaries"].as_array().unwrap().len(), 2);
        assert_eq!(get["summary"]["id"].as_i64(), Some(first));
    }

    #[tokio::test]
    async fn memory_search_summaries_returns_structured_summaries() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = Arc::new(
            MemoryManager::global_only(global)
                .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a"),
        );
        manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(3),
                request: Some("context compaction".to_string()),
                investigated: Some("memory summary search".to_string()),
                learned: Some("summary search can find compaction conclusions".to_string()),
                completed: Some("memory_search_summaries tool added".to_string()),
                next_steps: Some("fetch details with memory_get kind summary".to_string()),
                notes: None,
                created_at_epoch: 9_000_000_000_010,
            })
            .unwrap()
            .unwrap();
        manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-2".to_string(),
                project_key: "project-b".to_string(),
                prompt_number: Some(1),
                request: Some("other project".to_string()),
                investigated: None,
                learned: Some("compaction conclusions for another project".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 9_000_000_000_011,
            })
            .unwrap()
            .unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_memory_manager(manager);

        let search_output = MemorySearchTool
            .call(
                json!({"query": "compaction conclusions", "scope": "summaries", "limit": 5}),
                &ctx,
            )
            .await
            .unwrap();
        let search: Value = serde_json::from_str(output_text(&search_output)).unwrap();

        assert_eq!(search["count"].as_u64(), Some(1));
        assert_eq!(
            search["results"][0]["learned"].as_str(),
            Some("summary search can find compaction conclusions")
        );

        let id = search["results"][0]["id"].as_i64().unwrap();
        let get_output = MemoryGetTool
            .call(json!({"id": id, "kind": "summary"}), &ctx)
            .await
            .unwrap();
        let get: Value = serde_json::from_str(output_text(&get_output)).unwrap();
        assert_eq!(get["found"].as_bool(), Some(true));
        assert_eq!(
            get["summary"]["completed"].as_str(),
            Some("memory_search_summaries tool added")
        );
    }

    #[tokio::test]
    async fn memory_search_scope_both_merges_observations_and_summaries() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = Arc::new(
            MemoryManager::global_only(global)
                .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a"),
        );
        manager
            .remember_tool("project", "shared consolidation marker")
            .unwrap();
        manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(1),
                request: Some("shared consolidation marker".to_string()),
                investigated: None,
                learned: None,
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 9_000_000_000_100,
            })
            .unwrap()
            .unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_memory_manager(manager);

        let output = MemorySearchTool
            .call(
                json!({"query": "shared consolidation marker", "scope": "both", "limit": 10}),
                &ctx,
            )
            .await
            .unwrap();
        let result: Value = serde_json::from_str(output_text(&output)).unwrap();
        let kinds = result["results"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["kind"].as_str())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            kinds,
            std::collections::BTreeSet::from(["observation", "summary"])
        );
    }

    #[tokio::test]
    async fn memory_get_rejects_unknown_kind() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = Arc::new(
            MemoryManager::global_only(global)
                .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a"),
        );
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_memory_manager(manager);

        let result = MemoryGetTool
            .call(json!({"id": 1, "kind": "session"}), &ctx)
            .await;

        match result {
            Err(ToolError::InvalidInput(message)) => {
                assert!(message.contains("kind must be observation or summary"));
            }
            _ => panic!("expected invalid input"),
        }
    }

    #[tokio::test]
    async fn memory_get_requires_id_or_ids() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = Arc::new(
            MemoryManager::global_only(global)
                .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a"),
        );
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_memory_manager(manager);

        let result = MemoryGetTool.call(json!({}), &ctx).await;

        match result {
            Err(ToolError::InvalidInput(message)) => {
                assert!(message.contains("id or ids"));
            }
            _ => panic!("expected invalid input"),
        }
    }

    #[tokio::test]
    async fn timeline_lookup_returns_adjacent_structured_observations() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = Arc::new(
            MemoryManager::global_only(global)
                .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a"),
        );
        manager.remember_tool("project", "first memory").unwrap();
        manager.remember_tool("project", "second memory").unwrap();
        manager.remember_tool("project", "third memory").unwrap();
        manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "memory-manager".to_string(),
                project_key: String::new(),
                prompt_number: None,
                request: Some("compact memory session".to_string()),
                investigated: None,
                learned: Some("timeline can mix summaries".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 9_000_000_000_000,
            })
            .unwrap()
            .unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_memory_manager(manager);

        let search_output = MemorySearchTool
            .call(json!({"query": "second memory", "limit": 1}), &ctx)
            .await
            .unwrap();
        let search: Value = serde_json::from_str(output_text(&search_output)).unwrap();
        let id = search["results"][0]["id"].as_i64().unwrap();

        let timeline_output = MemoryGetTool
            .call(json!({"id": id, "before": 1, "after": 1}), &ctx)
            .await
            .unwrap();
        let timeline: Value = serde_json::from_str(output_text(&timeline_output)).unwrap();

        assert_eq!(timeline["count"].as_u64(), Some(4));
        assert_eq!(timeline["summaries"].as_array().unwrap().len(), 1);
        let narratives = timeline["observations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["narrative"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            narratives,
            vec!["first memory", "second memory", "third memory"]
        );
        let item_kinds = timeline["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            item_kinds,
            vec!["observation", "observation", "observation", "summary"]
        );
    }

    fn output_text(output: &ToolOutput) -> &str {
        match &output.content[0] {
            ContentBlock::Text { text } => text,
            _ => panic!("expected text output"),
        }
    }
}
