//! Catalog regressions against the skill set actually shipped with KCoder.
use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_skills::SkillRegistry;
use kcoder_tools::{SkillTool, ToolRegistry};
use kcoder_types::StudioWorkMode;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const OFFICE_SKILLS: [&str; 4] = ["docx", "pdf", "pptx", "xlsx"];

fn isolated_config_dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

/// Materialize the embedded bundled skills exactly as the CLI does at startup.
fn bundled_registry(config: &Path, project: &Path) -> SkillRegistry {
    kcoder_skills::ensure_builtin_skills(config).unwrap();
    SkillRegistry::load_for_profile(project, std::iter::empty::<PathBuf>(), config, true).unwrap()
}

struct BundledFixture {
    _config: tempfile::TempDir,
    _project: tempfile::TempDir,
    engine: QueryEngine,
}

/// `None` is a CLI/TUI engine; Studio modes also attach the managed widget tool.
fn bundled_engine(mode: Option<StudioWorkMode>) -> BundledFixture {
    let config = isolated_config_dir();
    let project = tempfile::tempdir().unwrap();
    let registry = bundled_registry(config.path(), project.path());
    let mut engine = TestEngineBuilder::new(project.path())
        .tool_registry(ToolRegistry::new().register(SkillTool))
        .skill_registry(registry)
        .build_with_profile_directory()
        .with_studio_work_mode(mode);
    if mode.is_some() {
        engine = engine.with_widget_tool(kcoder_tools::ShowWidgetTool::preview());
    }
    BundledFixture {
        _config: config,
        _project: project,
        engine,
    }
}

fn available(names: &[&str]) -> HashSet<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

/// Exact names the catalog lets the model load, and the subset with descriptions.
fn catalog_names(catalog: &str) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut all = BTreeSet::new();
    let mut described = BTreeSet::new();
    for line in catalog.lines().filter(|line| line.starts_with('{')) {
        let entry: serde_json::Value = serde_json::from_str(line).unwrap();
        if let Some(names) = entry["names"].as_array() {
            assert_eq!(entry["count"].as_u64(), Some(names.len() as u64), "{line}");
            let prefix = entry["family"].as_str().unwrap().trim_end_matches('*');
            for name in names {
                let name = name.as_str().unwrap();
                assert!(name.starts_with(prefix), "{name} is not in {prefix}*");
                assert!(all.insert(name.to_owned()), "{name} listed twice");
            }
        } else {
            let name = entry["name"].as_str().unwrap();
            assert!(entry["description"].is_string(), "{line}");
            assert!(all.insert(name.to_owned()), "{name} listed twice");
            described.insert(name.to_owned());
        }
    }
    (all, described)
}

#[test]
fn bundled_catalog_names_every_visible_skill_in_each_mode_within_budget() {
    let tools = available(&["skill", "DiscoverSkills", "show_widget"]);
    for (mode, expected_hidden, expected_present) in [
        (
            None,
            &["inline-visualization"][..],
            &["kcoder-settings"][..],
        ),
        (
            Some(StudioWorkMode::Kcoder),
            &[][..],
            &["kcoder-settings", "inline-visualization"][..],
        ),
        (
            Some(StudioWorkMode::Kworker),
            &["kcoder-settings"][..],
            &["inline-visualization"][..],
        ),
    ] {
        let fixture = bundled_engine(mode);
        let catalog = fixture.engine.skill_catalog_prompt(&tools);
        assert!(
            catalog.len() <= MAX_CATALOG_BYTES,
            "{mode:?}: {} bytes",
            catalog.len()
        );
        // Every visible skill is named, so the catalog must not claim truncation.
        assert!(
            !catalog.contains("Directory bounded"),
            "{mode:?}\n{catalog}"
        );
        let (names, described) = catalog_names(&catalog);
        let registry = fixture.engine.skill_registry.read().unwrap();
        let registered = registry
            .iter_all()
            .map(|skill| skill.name.clone())
            .collect::<BTreeSet<_>>();
        let lark = registered
            .iter()
            .filter(|name| name.starts_with("lark-"))
            .count();
        assert_eq!(lark, 25, "the bundled Feishu family changed size");
        let expected = registered
            .iter()
            .filter(|name| !expected_hidden.contains(&name.as_str()))
            .cloned()
            .collect::<BTreeSet<_>>();
        assert_eq!(names, expected, "{mode:?}\n{catalog}");
        for name in expected_present {
            assert!(described.contains(*name), "{mode:?}: {name}");
        }
        // Office and other non-family skills keep their descriptions; only the
        // large prefix family is reduced to exact names.
        for name in OFFICE_SKILLS
            .iter()
            .chain(&["skill-creator", "webapp-testing", "xlsx"])
        {
            assert!(described.contains(*name), "{mode:?}: {name}\n{catalog}");
        }
        assert!(names.contains("lark-calendar") && !described.contains("lark-calendar"));
        assert!(catalog.contains("\"family\":\"lark-*\""));
        assert!(catalog.contains("DiscoverSkills tool with the family prefix"));
        // Each listed name resolves through the loader the skill tool uses.
        for name in &names {
            assert!(registry.get_active(name).is_some(), "{name} cannot load");
        }
        drop(registry);
        assert_eq!(catalog, fixture.engine.skill_catalog_prompt(&tools));
    }
}

#[test]
fn bundled_catalog_without_discovery_stays_truthful() {
    let fixture = bundled_engine(None);
    let catalog = fixture.engine.skill_catalog_prompt(&available(&["skill"]));
    assert!(catalog.len() <= MAX_CATALOG_BYTES);
    assert!(!catalog.contains("DiscoverSkills"));
    assert!(catalog.contains("No discovery tool is attached"));
    let (names, _) = catalog_names(&catalog);
    assert!(names.contains("lark-im") && names.contains("pdf"));
}

#[tokio::test]
async fn family_member_listed_by_name_activates_by_exact_name() {
    let fixture = bundled_engine(Some(StudioWorkMode::Kworker));
    let (output, _, _, _) = fixture
        .engine
        .execute_tool(
            "activate-lark",
            "skill",
            serde_json::json!({"skill": "lark-calendar"}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(!output.is_error, "{output:?}");
    assert!(
        fixture
            .engine
            .active_skills
            .read()
            .unwrap()
            .iter()
            .any(|name| name == "lark-calendar")
    );
}
