use crate::materialize_extensions_fixture;
use kcoder_hooks::{HookCommand, HookEvent, HookSourceKind};
use kcoder_plugins::PluginRegistry;
use kcoder_skills::SkillRegistry;
use std::path::PathBuf;

#[test]
fn trusted_project_loads_fixture_plugin_and_untrusted_project_skips_its_source() {
    let (_temporary, fixture) = materialize_extensions_fixture();
    let trusted = PluginRegistry::discover_with_trust(&fixture.root, true).unwrap();
    let fixture_plugins = trusted
        .plugins()
        .iter()
        .filter(|plugin| plugin.root.starts_with(&fixture.root))
        .collect::<Vec<_>>();
    assert_eq!(fixture_plugins.len(), 1);
    let plugin = fixture_plugins[0];
    assert_eq!(plugin.id, "fixture-review-plugin");
    assert!(plugin.enabled);
    assert_eq!(plugin.name, "Fixture Review Plugin");
    assert!(plugin.root.starts_with(&fixture.root));
    assert_eq!(
        trusted
            .enabled_plugins()
            .filter(|plugin| plugin.root.starts_with(&fixture.root))
            .count(),
        1
    );

    let hooks = trusted
        .hook_matchers()
        .into_iter()
        .filter(|(_, matcher)| {
            matcher
                .source
                .as_ref()
                .is_some_and(|source| source.root.starts_with(&fixture.root))
        })
        .collect::<Vec<_>>();
    assert_eq!(hooks.len(), 1);
    let (event, matcher) = &hooks[0];
    assert_eq!(*event, HookEvent::PreToolUse);
    assert_eq!(matcher.matcher.as_deref(), Some("bash"));
    assert!(matches!(
        matcher.hooks.as_slice(),
        [HookCommand::Prompt { .. }]
    ));
    let source = matcher.source.as_ref().expect("plugin hook 应带来源");
    assert_eq!(source.kind, HookSourceKind::Plugin);
    assert_eq!(source.id, "fixture-review-plugin");
    assert!(source.root.starts_with(&fixture.root));

    let untrusted = PluginRegistry::discover_with_trust(&fixture.root, false).unwrap();
    assert!(
        untrusted
            .plugins()
            .iter()
            .all(|plugin| !plugin.root.starts_with(&fixture.root)),
        "untrusted project 不能加载 fixture plugin；外来用户 plugin 不影响断言"
    );
}

#[test]
fn fixture_skills_obey_trust_expand_arguments_and_activate_by_path() {
    let (_temporary, fixture) = materialize_extensions_fixture();
    let trusted = SkillRegistry::load_with_external_dirs_and_trust(
        &fixture.root,
        std::iter::empty::<PathBuf>(),
        true,
    )
    .unwrap();
    let fixture_skills = trusted
        .iter_all()
        .filter(|skill| skill.source.starts_with(&fixture.root))
        .collect::<Vec<_>>();
    assert_eq!(fixture_skills.len(), 2);

    let review = trusted
        .get("fixture-extensions-review")
        .expect("trusted project 应加载 fixture review skill");
    assert!(review.source.starts_with(&fixture.root));
    let invocation =
        review.invocation_text(&["crates/kcoder_state".to_string(), "--strict".to_string()]);
    assert!(invocation.starts_with("<skill_content name=\"fixture-extensions-review\">"));
    assert!(invocation.contains("审查目标：crates/kcoder_state"));
    assert!(invocation.contains("完整参数：crates/kcoder_state --strict"));

    assert!(trusted.get("fixture-extensions-rust-guard").is_none());
    let active_fixture_skills = trusted
        .active_for_paths(&["crates/kcoder_state/src/lib.rs".to_string()])
        .into_iter()
        .filter(|skill| skill.source.starts_with(&fixture.root))
        .collect::<Vec<_>>();
    assert_eq!(active_fixture_skills.len(), 1);
    assert_eq!(
        active_fixture_skills[0].name,
        "fixture-extensions-rust-guard"
    );
    assert!(active_fixture_skills[0].source.starts_with(&fixture.root));
    assert!(
        trusted
            .active_for_paths(&["README.md".to_string()])
            .iter()
            .all(|skill| !skill.source.starts_with(&fixture.root))
    );

    let untrusted = SkillRegistry::load_with_external_dirs_and_trust(
        &fixture.root,
        std::iter::empty::<PathBuf>(),
        false,
    )
    .unwrap();
    assert!(
        untrusted
            .iter_all()
            .all(|skill| !skill.source.starts_with(&fixture.root)),
        "untrusted project 不能加载 fixture skill；外来用户 skill 不影响断言"
    );
}
