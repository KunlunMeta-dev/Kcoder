//! Deterministic system-prompt surface measurements, budgets and duplication guards.
//!
//! Each surface runs one real turn against a recording provider and measures the
//! exact `system` text and tool definitions the provider receives. Workspace paths
//! and the test executable name are replaced by fixed placeholders so the counts do
//! not depend on where the test runs. Budgets sit just above the measured sizes:
//! growth must be a deliberate, reviewed budget change.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Surface {
    CliFull,
    CliCore,
    CliNano,
    Orchestrate,
    StudioKcoder,
    StudioKworker,
    ExploreSubagent,
}

impl Surface {
    const ALL: [Surface; 7] = [
        Surface::CliFull,
        Surface::CliCore,
        Surface::CliNano,
        Surface::Orchestrate,
        Surface::StudioKcoder,
        Surface::StudioKworker,
        Surface::ExploreSubagent,
    ];

    fn label(self) -> &'static str {
        match self {
            Surface::CliFull => "cli_full",
            Surface::CliCore => "cli_core",
            Surface::CliNano => "cli_nano",
            Surface::Orchestrate => "orchestrate",
            Surface::StudioKcoder => "studio_kcoder",
            Surface::StudioKworker => "studio_kworker",
            Surface::ExploreSubagent => "explore_subagent",
        }
    }
}

/// Upper bounds in Unicode scalar values for one rendered surface.
struct SurfaceBudget {
    surface: Surface,
    system_chars: usize,
    /// Compact JSON of the attached tool definitions.
    tools_json_chars: usize,
}

/// Measured at the prompt de-duplication change (before → after, system chars):
/// cli_full 11,015 → 8,359; cli_core 8,208 → 6,368; cli_nano 5,580 → 4,569;
/// orchestrate 17,118 → 14,934; studio_kcoder 11,015 → 8,359;
/// studio_kworker 12,420 → 9,769; explore_subagent 7,435 → 6,765.
/// Tool budgets allow about 3% above the final fixed-fixture measurements.
const SURFACE_BUDGETS: &[SurfaceBudget] = &[
    SurfaceBudget {
        surface: Surface::CliFull,
        system_chars: 8_600,
        tools_json_chars: 96_000,
    },
    SurfaceBudget {
        surface: Surface::CliCore,
        system_chars: 6_600,
        tools_json_chars: 57_000,
    },
    SurfaceBudget {
        surface: Surface::CliNano,
        system_chars: 4_750,
        tools_json_chars: 26_100,
    },
    SurfaceBudget {
        surface: Surface::Orchestrate,
        system_chars: 15_400,
        tools_json_chars: 99_000,
    },
    SurfaceBudget {
        surface: Surface::StudioKcoder,
        system_chars: 8_600,
        tools_json_chars: 101_700,
    },
    SurfaceBudget {
        surface: Surface::StudioKworker,
        system_chars: 10_050,
        tools_json_chars: 99_700,
    },
    SurfaceBudget {
        surface: Surface::ExploreSubagent,
        system_chars: 7_000,
        tools_json_chars: 18_900,
    },
];

/// A system paragraph may share at most this many word 8-grams with the attached
/// tool descriptions; a larger overlap means a rule is stated in two places.
const MAX_SHARED_EIGHT_GRAMS_PER_PARAGRAPH: usize = 2;

/// SHA-256 of `KUNLUNMETA_PROFILE_PROMPT`. The developer profile is fixed product
/// copy: any change must be an explicit, reviewed update of this digest.
const KUNLUNMETA_PROFILE_SHA256: &str =
    "e9aaf7b8ed813f950a8073e6833ad611fd4fd9abcd3ddd325805a6775d49aa5e";

const CWD_PLACEHOLDER: &str = "<workspace>";
const EXE_PLACEHOLDER: &str = "<executable>";

struct RenderedSurface {
    system: String,
    tools: Vec<kcoder_types::ToolDefinition>,
}

fn presentation(mode: kcoder_types::StudioWorkMode) -> Option<kcoder_types::ClientPresentationV1> {
    Some(kcoder_types::ClientPresentationV1 {
        version: 1,
        studio_work_mode: Some(mode),
        inline_widgets: true,
        isolated_widgets: false,
    })
}

/// Two fixed project skills keep the catalog section present and identical everywhere.
fn write_fixture_skills(root: &std::path::Path) {
    for (name, description) in [
        (
            "fixture-report",
            "Write a structured status report from supplied notes.",
        ),
        (
            "fixture-review",
            "Review a supplied change for correctness risks.",
        ),
    ] {
        let directory = root.join(".kcoder/skills").join(name);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n\nFixture body.\n"),
        )
        .unwrap();
    }
}

/// The host-composed registry: profile tools plus Config, after the default
/// `tools.disabled` patterns, as the CLI and app-server compose it.
fn surface_registry(surface: Surface) -> ToolRegistry {
    let disabled = Settings::default().tools.disabled;
    let compose = |registry: ToolRegistry| {
        registry
            .register(kcoder_tools::ConfigTool)
            .filtered_out_by_patterns(&disabled)
    };
    let full = compose(kcoder_tools::default_registry());
    match surface {
        Surface::CliCore => compose(kcoder_tools::core_registry()),
        Surface::CliNano => compose(kcoder_tools::nano_registry()),
        Surface::ExploreSubagent => crate::agent::filter_tools_for_agent_kind(
            &full,
            kcoder_tools::AgentKind::Explore,
            false,
        ),
        _ => full,
    }
}

fn normalize(text: &str, cwd: &std::path::Path) -> String {
    let mut text = text.replace(&cwd.display().to_string(), CWD_PLACEHOLDER);
    if let Some(stem) = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
        })
        .filter(|stem| !stem.trim().is_empty())
    {
        text = text.replace(&format!("`{stem}`"), &format!("`{EXE_PLACEHOLDER}`"));
    }
    text
}

async fn render_surface_in(
    surface: Surface,
    root: &std::path::Path,
    model: &str,
) -> RenderedSurface {
    write_fixture_skills(root);
    let mut settings = crate::test_support::engine_builder::fixture_settings();
    settings.permission_mode = PermissionMode::Yolo;
    settings.model = model.to_string();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut engine = TestEngineBuilder::new(root)
        .provider(Arc::new(RequestRecordingProvider {
            requests: Arc::clone(&requests),
        }))
        .settings(settings)
        .tool_registry(surface_registry(surface))
        .build_with_profile_directory();
    match surface {
        Surface::StudioKcoder | Surface::StudioKworker => {
            let mode = if surface == Surface::StudioKcoder {
                kcoder_types::StudioWorkMode::Kcoder
            } else {
                kcoder_types::StudioWorkMode::Kworker
            };
            engine = engine
                .with_studio_work_mode(Some(mode))
                .with_client_presentation(presentation(mode))
                .with_widget_tool(kcoder_tools::ShowWidgetTool::preview());
        }
        Surface::Orchestrate => {
            engine
                .state
                .enter_orchestrate_before_first_message()
                .unwrap();
        }
        Surface::ExploreSubagent => {
            engine = engine.with_agent_depth(1).with_subagent_system_prompt(Some(
                kcoder_tools::AgentKind::Explore.system_prompt().to_string(),
            ));
        }
        Surface::CliFull | Surface::CliCore | Surface::CliNano => {}
    }
    crate::test_support::engine_builder::initialize_owned_native_profile(&engine).unwrap();
    engine.state.add_message(Message::user_text("hi"));
    engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    // Session-end work may add an auxiliary request without a system prompt.
    let request = requests
        .lock()
        .unwrap()
        .iter()
        .find(|request| request.system.is_some())
        .cloned()
        .expect("foreground request with a system prompt");
    let mut tools = request.tools.clone();
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    RenderedSurface {
        system: normalize(request.system.as_deref().unwrap(), root),
        tools,
    }
}

async fn render_surface(surface: Surface) -> RenderedSurface {
    let root = tempfile::tempdir().unwrap();
    render_surface_in(surface, root.path(), "surface-fixture-model").await
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

fn tools_json_chars(tools: &[kcoder_types::ToolDefinition]) -> usize {
    chars(&serde_json::to_string(tools).unwrap())
}

fn words(text: &str) -> Vec<String> {
    text.split(|ch: char| !(ch.is_alphanumeric() || ch == '_'))
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn eight_grams(text: &str) -> BTreeSet<String> {
    words(text)
        .windows(8)
        .map(|window| window.join(" "))
        .collect()
}

/// System paragraphs and the 8-grams each shares with the attached tool descriptions.
fn shared_paragraphs(rendered: &RenderedSurface) -> Vec<(String, Vec<String>)> {
    let tool_grams = rendered
        .tools
        .iter()
        .flat_map(|tool| eight_grams(&tool.description))
        .collect::<BTreeSet<_>>();
    rendered
        .system
        .split("\n\n")
        .filter_map(|paragraph| {
            let shared = eight_grams(paragraph)
                .intersection(&tool_grams)
                .cloned()
                .collect::<Vec<_>>();
            (!shared.is_empty()).then(|| (paragraph.to_string(), shared))
        })
        .collect()
}

fn hex_sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Print every surface's measurement; this test never fails on size.
#[tokio::test]
async fn prompt_surface_measurement_report() {
    for surface in Surface::ALL {
        let rendered = render_surface(surface).await;
        let shared = shared_paragraphs(&rendered);
        eprintln!(
            "surface={} system_chars={} tools={} tools_json_chars={} shared_paragraphs={} shared_8grams={}",
            surface.label(),
            chars(&rendered.system),
            rendered.tools.len(),
            tools_json_chars(&rendered.tools),
            shared.len(),
            shared.iter().map(|(_, grams)| grams.len()).sum::<usize>(),
        );
        for (paragraph, grams) in shared {
            let head = paragraph.chars().take(90).collect::<String>();
            eprintln!("  shared={:>3} {head:?}", grams.len());
        }
    }
}

#[tokio::test]
async fn prompt_surfaces_stay_within_budget() {
    for budget in SURFACE_BUDGETS {
        let rendered = render_surface(budget.surface).await;
        let system = chars(&rendered.system);
        assert!(
            system <= budget.system_chars,
            "{} system prompt grew to {system} chars (budget {}); trim it or raise the budget deliberately",
            budget.surface.label(),
            budget.system_chars
        );
        let tools = tools_json_chars(&rendered.tools);
        assert!(
            tools <= budget.tools_json_chars,
            "{} tool definitions grew to {tools} chars (budget {})",
            budget.surface.label(),
            budget.tools_json_chars,
        );
    }
    assert_eq!(
        SURFACE_BUDGETS
            .iter()
            .map(|budget| budget.surface.label())
            .collect::<Vec<_>>(),
        Surface::ALL.map(Surface::label).to_vec(),
        "every measured surface needs exactly one budget"
    );
}

#[tokio::test]
async fn system_prompt_does_not_restate_attached_tool_descriptions() {
    for surface in Surface::ALL {
        let rendered = render_surface(surface).await;
        for (paragraph, grams) in shared_paragraphs(&rendered) {
            assert!(
                grams.len() <= MAX_SHARED_EIGHT_GRAMS_PER_PARAGRAPH,
                "{}: system paragraph repeats {} 8-grams of an attached tool description; keep the rule in one place.\nparagraph: {paragraph}\nshared: {grams:?}",
                surface.label(),
                grams.len()
            );
        }
    }
}

#[tokio::test]
async fn developer_profile_is_unchanged_and_follows_the_identity_line() {
    assert_eq!(
        hex_sha256(crate::prompt_runtime::KUNLUNMETA_PROFILE_PROMPT),
        KUNLUNMETA_PROFILE_SHA256
    );
    for surface in Surface::ALL {
        let rendered = render_surface(surface).await;
        let identity = if surface == Surface::StudioKworker {
            crate::prompt_runtime::KWORKER_IDENTITY_PROMPT
        } else {
            crate::prompt_runtime::KCODER_IDENTITY_PROMPT
        };
        assert!(
            rendered.system.starts_with(&format!(
                "{identity}\n\n{}\n\n",
                crate::prompt_runtime::KUNLUNMETA_PROFILE_PROMPT
            )),
            "{}: identity and developer profile must lead the system prompt",
            surface.label()
        );
        assert_eq!(
            rendered
                .system
                .matches(crate::prompt_runtime::KUNLUNMETA_PROFILE_PROMPT)
                .count(),
            1,
            "{}",
            surface.label()
        );
    }
}

/// Workspace path and model identifier are per-session facts. They belong to the
/// dynamic tail so the long static prefix stays byte-identical across sessions.
#[tokio::test]
async fn static_system_prefix_is_identical_across_workspaces_and_models() {
    for surface in [Surface::CliFull, Surface::StudioKworker] {
        let first_root = tempfile::tempdir().unwrap();
        let second_root = tempfile::Builder::new()
            .prefix("another-workspace-with-a-longer-name-")
            .tempdir()
            .unwrap();
        let first = render_surface_in(surface, first_root.path(), "first-model").await;
        let second =
            render_surface_in(surface, second_root.path(), "a-different-model-identifier").await;
        let first_raw = first.system.replace(CWD_PLACEHOLDER, "/first");
        let second_raw = second.system.replace(CWD_PLACEHOLDER, "/second/workspace");
        let common = first_raw
            .bytes()
            .zip(second_raw.bytes())
            .take_while(|(left, right)| left == right)
            .count();
        let tail = first_raw
            .find(crate::prompt_runtime::DYNAMIC_CONTEXT_LEAD)
            .expect("dynamic tail marker");
        assert!(
            common >= tail,
            "{}: the system prompt diverges at byte {common}, before the dynamic tail at {tail}:\n{}",
            surface.label(),
            &first_raw[common.saturating_sub(80)..(common + 80).min(first_raw.len())]
        );
        assert!(tail * 2 > first_raw.len(), "{}", surface.label());
    }
}

/// Rules removed from the system prompt because an attached tool already carries
/// them. If a tool description is rewritten, the rule must survive somewhere in
/// that tool's definition (description or schema), or return to the system prompt.
const RELOCATED_RULES: &[(&str, &[&str])] = &[
    (
        "bash",
        &["process lifecycle is scoped to the current session"],
    ),
    ("bash", &["curl http 000 alone does not prove"]),
    ("bash", &["in-command health check alone"]),
    (
        "spawn_agent",
        &["more than 4 sub-agents", "4-running sub-agent cap"],
    ),
    ("spawn_agent", &["keep the parent task open"]),
    (
        "explore_agent",
        &["more than 4 sub-agents", "4-running sub-agent cap"],
    ),
    ("skill", &["load it before following its workflow"]),
    ("skill", &["trust, guard and approval checks still apply"]),
    ("WebSearch", &["empty search is not evidence"]),
    (
        "WorkflowDraft",
        &[
            "read a draft before editing it",
            "read existing drafts before edits",
        ],
    ),
    ("WorkflowDraft", &["expected_revision"]),
];

#[tokio::test]
async fn rules_dropped_from_the_system_prompt_remain_in_their_tool_definitions() {
    let rendered = render_surface(Surface::CliFull).await;
    for (tool, variants) in RELOCATED_RULES {
        let definition = rendered
            .tools
            .iter()
            .find(|definition| definition.name == *tool)
            .unwrap_or_else(|| panic!("{tool} must be attached on the cli_full surface"));
        let text = serde_json::to_string(definition).unwrap().to_lowercase();
        assert!(
            variants.iter().any(|variant| text.contains(variant)),
            "{tool} no longer states a rule the system prompt delegates to it: {variants:?}"
        );
    }
}
