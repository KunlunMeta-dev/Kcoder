//! Deterministic tool-definition surface measurements and size budgets.
//!
//! Each surface renders the exact `ToolDefinition`s a request would carry via
//! `tool_definitions_for_model`, then measures them the same way the prompt
//! research scripts do: compact JSON (`name`, `description`, `input_schema`)
//! counted in Unicode scalar values. Budgets may only be tightened; a growing
//! tool surface must justify itself by raising a budget in review.
use super::*;
use kcoder_tools::session_discovery::{SessionDiscoveryCall, SessionDiscoveryHost};
use kcoder_tools::session_messages::{SessionMessageCall, SessionMessageSendError};
use std::collections::{BTreeMap, BTreeSet};

struct DiscoveryHost;
#[async_trait::async_trait]
impl SessionDiscoveryHost for DiscoveryHost {
    async fn list(
        &self,
        _: SessionDiscoveryCall,
        _: Option<String>,
    ) -> std::result::Result<Value, ToolError> {
        Ok(serde_json::json!({"targets": []}))
    }
    fn supports_read(&self) -> bool {
        true
    }
}

struct MessagesHost;
#[async_trait::async_trait]
impl kcoder_tools::session_messages::SessionMessagesHost for MessagesHost {
    async fn send(
        &self,
        _: SessionMessageCall,
        _: kcoder_types::cross_session_messages::AgentMessageIntent,
    ) -> std::result::Result<Value, SessionMessageSendError> {
        Ok(serde_json::json!({"status": "queued"}))
    }
    async fn receipt(
        &self,
        _: SessionMessageCall,
        _: Value,
    ) -> std::result::Result<Value, ToolError> {
        Ok(serde_json::json!({"status": "unknown"}))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Surface {
    CliFull,
    StudioKcoder,
    StudioKworker,
    ExploreSubagent,
}

impl Surface {
    const ALL: [Surface; 4] = [
        Surface::CliFull,
        Surface::StudioKcoder,
        Surface::StudioKworker,
        Surface::ExploreSubagent,
    ];

    fn label(self) -> &'static str {
        match self {
            Surface::CliFull => "cli_full",
            Surface::StudioKcoder => "studio_kcoder",
            Surface::StudioKworker => "studio_kworker",
            Surface::ExploreSubagent => "explore_subagent",
        }
    }
}

/// The full host-composed built-in registry: CLI `full` profile plus Config and
/// the Studio-only builtins that a connection with session hosts supplies.
fn host_registry() -> ToolRegistry {
    let discovery = kcoder_tools::session_discovery::ListSessionsTool::new(Arc::new(DiscoveryHost));
    let mut registry = kcoder_tools::default_registry().register(kcoder_tools::ConfigTool);
    if let Some(read) = discovery.read_tool() {
        registry = registry.register(read);
    }
    let messages: Arc<dyn kcoder_tools::session_messages::SessionMessagesHost> =
        Arc::new(MessagesHost);
    use kcoder_tools::session_messages::{
        GetSessionMessageReceiptTool, ListSessionMessageReceiptsTool, SendSessionMessageTool,
    };
    registry
        .register(discovery)
        .register(SendSessionMessageTool::new(messages.clone()))
        .register(GetSessionMessageReceiptTool::new(messages.clone()))
        .register(ListSessionMessageReceiptsTool::new(messages))
        .register(kcoder_tools::ShowWidgetTool::preview())
        .register(kcoder_tools::tool_search::ToolSearchTool)
        .register(kcoder_tools::tool_execute::ToolExecuteTool)
}

fn surface_registry(surface: Surface, settings: &Settings) -> ToolRegistry {
    let host = host_registry();
    let studio_only: BTreeSet<&str> = kcoder_config::KWORKER_DEFAULT_SESSION_TOOLS
        .iter()
        .copied()
        .chain(["show_widget", "tool_search", "tool_execute"])
        .collect();
    let names: Vec<String> = match surface {
        Surface::CliFull => host
            .names()
            .into_iter()
            .filter(|name| !studio_only.contains(name.as_str()))
            .collect(),
        // KCoder mode defaults to every available tool it supports; the deferred
        // discovery pair is KWorker-only.
        Surface::StudioKcoder => host
            .names()
            .into_iter()
            .filter(|name| !matches!(name.as_str(), "tool_search" | "tool_execute"))
            .collect(),
        Surface::StudioKworker => {
            kcoder_config::kworker_default_tool_names(&settings.tools.luna.allowed)
        }
        Surface::ExploreSubagent => {
            let cli = surface_registry(Surface::CliFull, settings);
            return crate::agent::filter_tools_for_agent_kind(
                &cli,
                kcoder_tools::AgentKind::Explore,
                false,
            );
        }
    };
    host.filtered_to_names(&names)
        .filtered_out_by_patterns(&settings.tools.disabled)
}

async fn render_surface(surface: Surface) -> Vec<kcoder_types::ToolDefinition> {
    let root = tempfile::tempdir().unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Yolo,
        ..Settings::default()
    };
    let registry = surface_registry(surface, &settings);
    let mut engine = TestEngineBuilder::new(root.path())
        .settings(settings)
        .tool_registry(registry)
        .build();
    // Client runtimes never probe the terminal, which keeps rendering
    // independent of how the test binary's stdin is attached.
    engine.workspace_persistence_mode = crate::WorkspacePersistenceMode::Client;
    let studio_mode = match surface {
        Surface::StudioKcoder => Some(kcoder_types::StudioWorkMode::Kcoder),
        Surface::StudioKworker => Some(kcoder_types::StudioWorkMode::Kworker),
        Surface::CliFull | Surface::ExploreSubagent => None,
    };
    if let Some(mode) = studio_mode {
        engine = engine
            .with_studio_work_mode(Some(mode))
            .with_client_presentation(Some(kcoder_types::ClientPresentationV1 {
                version: 1,
                studio_work_mode: Some(mode),
                inline_widgets: true,
                isolated_widgets: false,
            }));
    }
    if surface == Surface::ExploreSubagent {
        engine = engine
            .with_agent_depth(1)
            .with_subagent_system_prompt(Some("Explore role".into()));
    }
    let mut definitions = engine.tool_definitions_for_model().await;
    definitions.sort_by(|left, right| left.name.cmp(&right.name));
    definitions
}

fn compact(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap()
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

struct ToolSize {
    description: usize,
    schema: usize,
}

fn tool_sizes(definitions: &[kcoder_types::ToolDefinition]) -> BTreeMap<String, ToolSize> {
    definitions
        .iter()
        .map(|definition| {
            (
                definition.name.clone(),
                ToolSize {
                    description: chars(&definition.description),
                    schema: chars(&compact(&definition.input_schema)),
                },
            )
        })
        .collect()
}

/// Print a measurement table; `KCODER_TOOL_SURFACE_REPORT=<dir>` also writes each
/// rendered surface as JSON for offline analysis.
#[tokio::test]
async fn tool_surface_measurement_report() {
    let report_dir = std::env::var_os("KCODER_TOOL_SURFACE_REPORT").map(std::path::PathBuf::from);
    for surface in Surface::ALL {
        let definitions = render_surface(surface).await;
        let json = compact(&definitions);
        let sizes = tool_sizes(&definitions);
        let descriptions: usize = sizes.values().map(|size| size.description).sum();
        let schemas: usize = sizes.values().map(|size| size.schema).sum();
        eprintln!(
            "surface={} tools={} json_chars={} desc_chars={} schema_chars={}",
            surface.label(),
            definitions.len(),
            chars(&json),
            descriptions,
            schemas
        );
        let mut ranked = sizes.iter().collect::<Vec<_>>();
        ranked.sort_by_key(|(_, size)| std::cmp::Reverse(size.description + size.schema));
        for (name, size) in ranked {
            eprintln!(
                "  {name:<28} desc={:>6} schema={:>6} total={:>6}",
                size.description,
                size.schema,
                size.description + size.schema
            );
        }
        if let Some(dir) = &report_dir {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(format!("{}.json", surface.label())), &json).unwrap();
        }
    }
}

/// Upper bounds in characters of the compact tool JSON per surface.
/// Final trimmed measurements: CLI 93,353; Studio KCoder 111,337;
/// Studio KWorker 109,492; Explore 18,302. Allow about 3% headroom.
const SURFACE_JSON_BUDGETS: &[(Surface, usize)] = &[
    (Surface::CliFull, 96_000),
    (Surface::StudioKcoder, 115_000),
    (Surface::StudioKworker, 113_000),
    (Surface::ExploreSubagent, 18_900),
];

/// Per-tool caps (description chars, compact schema chars) for the largest
/// tools, rounded above the final trimmed measurements.
const TOOL_SIZE_CAPS: &[(&str, usize, usize)] = &[
    ("WorkflowDraft", 1_950, 20_200),
    ("show_widget", 3_450, 1_950),
    ("spawn_agent", 2_350, 6_850),
    ("Workflow", 1_800, 4_650),
    ("explore_agent", 1_500, 2_850),
    ("read", 1_820, 1_930),
    ("glob", 1_510, 1_920),
    ("TodoWrite", 1_500, 1_270),
    ("SendMessage", 1_430, 650),
];

/// Distinct 8-word shingles shared by descriptions of two or more tools
/// (peer-hint suffixes excluded). The final trimmed fixture has two.
const SHARED_DESCRIPTION_8GRAM_BUDGET: usize = 2;

fn description_without_peer_hints(description: &str) -> &str {
    description
        .split("\n\nAvailable peer operations: ")
        .next()
        .unwrap_or(description)
}

fn shared_description_8grams(
    definitions: &BTreeMap<String, kcoder_types::ToolDefinition>,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut owners: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (name, definition) in definitions {
        let words = description_without_peer_hints(&definition.description)
            .split(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '-')
            .filter(|word| !word.is_empty())
            .map(str::to_ascii_lowercase)
            .collect::<Vec<_>>();
        for window in words.windows(8) {
            owners
                .entry(window.join(" "))
                .or_default()
                .insert(name.clone());
        }
    }
    owners.retain(|_, tools| tools.len() > 1);
    owners
}

async fn union_of_surfaces() -> BTreeMap<String, kcoder_types::ToolDefinition> {
    let mut union = BTreeMap::new();
    for surface in Surface::ALL {
        for definition in render_surface(surface).await {
            union.entry(definition.name.clone()).or_insert(definition);
        }
    }
    union
}

#[tokio::test]
async fn tool_surfaces_stay_within_character_budgets() {
    let mut failures = Vec::new();
    for (surface, budget) in SURFACE_JSON_BUDGETS {
        let size = chars(&compact(&render_surface(*surface).await));
        if size > *budget {
            failures.push(format!("{}: {size} > {budget}", surface.label()));
        }
    }
    let union = union_of_surfaces().await;
    for (name, description_cap, schema_cap) in TOOL_SIZE_CAPS {
        let definition = union
            .get(*name)
            .unwrap_or_else(|| panic!("capped tool {name} is not rendered on any surface"));
        let description = chars(&definition.description);
        let schema = chars(&compact(&definition.input_schema));
        if description > *description_cap || schema > *schema_cap {
            failures.push(format!(
                "{name}: description {description}/{description_cap}, schema {schema}/{schema_cap}"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn tool_descriptions_do_not_repeat_long_passages_across_tools() {
    let shared = shared_description_8grams(&union_of_surfaces().await);
    assert!(
        shared.len() <= SHARED_DESCRIPTION_8GRAM_BUDGET,
        "{} shared 8-grams exceed {}; move the rule to one owner tool:\n{}",
        shared.len(),
        SHARED_DESCRIPTION_8GRAM_BUDGET,
        shared
            .iter()
            .map(|(gram, tools)| format!("{gram} <- {tools:?}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}
