use std::fs;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct PressureScenario {
    skill: String,
    pressure_prompt: String,
    required_phrases: Vec<String>,
}

fn bundled_skill(name: &str) -> &'static str {
    kcoder_specs::SUPERPOWER_SKILLS
        .iter()
        .find_map(|(skill_name, content)| (*skill_name == name).then_some(*content))
        .unwrap_or_else(|| panic!("bundled skill {name} not found"))
}

fn core_pressure_scenarios() -> Vec<PressureScenario> {
    serde_yaml::from_str(include_str!("skills/core_pressure_scenarios.yaml"))
        .expect("core pressure scenarios fixture should be valid YAML")
}

#[test]
fn using_superpowers_keeps_root_protocol_trigger() {
    let content = bundled_skill("using-superpowers");

    assert!(content.contains("Invoke relevant or requested skills BEFORE"));
    assert!(content.contains("brainstorming"));
    assert!(content.contains("Skill tool"));
    assert!(content.contains("Follow skill exactly"));
}

#[test]
fn test_driven_development_keeps_red_green_refactor_flow() {
    let content = bundled_skill("test-driven-development");

    assert!(content.contains("RED"));
    assert!(content.contains("GREEN"));
    assert!(content.contains("REFACTOR"));
    assert!(content.contains("Verify RED"));
    assert!(content.contains("Verify GREEN"));
}

#[test]
fn verification_before_completion_keeps_completion_gate() {
    let content = bundled_skill("verification-before-completion");

    assert!(content.contains("Skip any step = lying, not verifying"));
    assert!(content.contains("verification"));
    assert!(content.contains("claiming"));
}

#[test]
fn spec_init_generates_using_specs_with_structured_tool_preference() {
    let tmp = tempfile::tempdir().unwrap();

    kcoder_specs::init(tmp.path()).unwrap();

    let content =
        fs::read_to_string(tmp.path().join(".kcoder/skills/using-specs/SKILL.md")).unwrap();
    assert!(content.contains("SpecStatus"));
    assert!(content.contains("SpecStatus"));
    assert!(content.contains("action=preflight"));
    assert!(content.contains("Project Spec Configuration"));
}

#[test]
fn spec_init_installs_core_skills_and_path_triggers_protocols() {
    let tmp = tempfile::tempdir().unwrap();

    kcoder_specs::init(tmp.path()).unwrap();

    let registry = kcoder_skills::SkillRegistry::load(tmp.path()).unwrap();
    assert!(registry.get_active("using-superpowers").is_some());
    assert!(registry.get("test-driven-development").is_some());
    assert!(registry.get("verification-before-completion").is_some());

    for skill in [
        "using-superpowers",
        "test-driven-development",
        "verification-before-completion",
    ] {
        let content = fs::read_to_string(
            tmp.path()
                .join(".kcoder")
                .join("skills")
                .join(skill)
                .join("SKILL.md"),
        )
        .unwrap();
        assert!(content.contains("paths: [\".kcoder/specs/**\"]"));
        if skill == "using-superpowers" {
            assert!(content.contains("user_invocable: false"));
        }
    }
}

#[test]
fn core_skills_encode_pressure_resistance_scenarios() {
    let scenarios = core_pressure_scenarios();
    let scenario_names = scenarios
        .iter()
        .map(|scenario| scenario.skill.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        scenario_names,
        std::collections::BTreeSet::from([
            "test-driven-development",
            "using-superpowers",
            "verification-before-completion",
        ])
    );

    for scenario in scenarios {
        assert!(
            !scenario.pressure_prompt.trim().is_empty(),
            "{} should define a pressure prompt",
            scenario.skill
        );
        let content = bundled_skill(&scenario.skill);
        for phrase in scenario.required_phrases {
            assert!(
                content.contains(&phrase),
                "{} should retain pressure counter phrase {:?}",
                scenario.skill,
                phrase
            );
        }
    }
}
