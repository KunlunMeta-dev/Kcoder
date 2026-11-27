use kcoder_plugins::{PluginMcpDeclaration, load_plugin_manifest};
use std::path::{Path, PathBuf};

const V1_SCHEMA: &str = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

fn write_manifest(root: &Path) {
    std::fs::write(
        root.join("plugin.json"),
        serde_json::json!({"$schema": V1_SCHEMA, "name": "skill-fixture"}).to_string(),
    )
    .unwrap();
}

fn write_skill(path: &Path, name: &str) {
    std::fs::create_dir_all(path).unwrap();
    std::fs::write(
        path.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: Fixture skill\n---\nUse this skill."),
    )
    .unwrap();
}

#[test]
fn v1_discovers_only_immediate_skill_directories_and_isolates_invalid_skill_content() {
    let temp = tempfile::tempdir().unwrap();
    let plugin = temp.path().join("plugin");
    std::fs::create_dir_all(plugin.join("skills")).unwrap();
    write_manifest(&plugin);

    write_skill(&plugin.join("skills/healthy"), "healthy");
    std::fs::create_dir_all(plugin.join("skills/broken")).unwrap();
    std::fs::write(
        plugin.join("skills/broken/SKILL.md"),
        "---\nname: [\n---\nThis frontmatter is invalid.",
    )
    .unwrap();
    write_skill(&plugin.join("skills/nested/deeper"), "too-deep");
    write_skill(&plugin.join("outside-flat-skill"), "outside-flat");
    std::fs::write(
        plugin.join("SKILL.md"),
        "---\nname: root-skill\ndescription: Root skill\n---\nMust not load.",
    )
    .unwrap();
    std::fs::write(
        plugin.join("skills/SKILL.md"),
        "---\nname: collection-root\ndescription: Collection root\n---\nMust not load.",
    )
    .unwrap();

    let loaded = load_plugin_manifest(&plugin).unwrap().unwrap();
    let skill_paths = loaded
        .manifest
        .contributions
        .skills
        .iter()
        .map(|resource| resource.relative_path.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        skill_paths,
        vec![
            PathBuf::from("skills/broken"),
            PathBuf::from("skills/healthy")
        ]
    );

    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let profile = temp.path().join("profile");
    let registry = kcoder_skills::SkillRegistry::load_for_profile(
        &workspace,
        loaded
            .manifest
            .contributions
            .skills
            .iter()
            .map(|resource| &resource.absolute_path),
        &profile,
        true,
    )
    .unwrap();
    let mut names = registry
        .list()
        .into_iter()
        .map(|skill| skill.name.clone())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, vec!["healthy"]);
}

#[test]
fn invalid_v1_skills_component_is_deferred_without_discarding_mcp() {
    let temp = tempfile::tempdir().unwrap();
    let plugin = temp.path().join("plugin");
    std::fs::create_dir_all(&plugin).unwrap();
    write_manifest(&plugin);
    std::fs::write(plugin.join("skills"), "wrong component kind").unwrap();
    std::fs::write(plugin.join("mcp.json"), "{}").unwrap();

    let loaded = load_plugin_manifest(&plugin).unwrap().unwrap();
    assert!(loaded.manifest.contributions.skills.is_empty());
    assert!(matches!(
        loaded.manifest.contributions.mcp_servers,
        Some(PluginMcpDeclaration::Path(_))
    ));
    assert!(
        loaded
            .compatibility
            .deferred_capabilities
            .iter()
            .any(|capability| capability == "skills")
    );
    assert!(loaded.compatibility.issues.iter().any(|issue| {
        issue.code == "component_invalid" && issue.capability.as_deref() == Some("skills")
    }));
}

#[test]
fn invalid_v1_mcp_component_is_deferred_without_discarding_skills() {
    let temp = tempfile::tempdir().unwrap();
    let plugin = temp.path().join("plugin");
    std::fs::create_dir_all(&plugin).unwrap();
    write_manifest(&plugin);
    write_skill(&plugin.join("skills/healthy"), "healthy");
    std::fs::create_dir(plugin.join("mcp.json")).unwrap();

    let loaded = load_plugin_manifest(&plugin).unwrap().unwrap();
    assert!(loaded.manifest.contributions.mcp_servers.is_none());
    assert_eq!(loaded.manifest.contributions.skills.len(), 1);
    assert_eq!(
        loaded.manifest.contributions.skills[0].relative_path,
        PathBuf::from("skills/healthy")
    );
    assert!(
        loaded
            .compatibility
            .deferred_capabilities
            .iter()
            .any(|capability| capability == "mcp_servers")
    );
    assert!(loaded.compatibility.issues.iter().any(|issue| {
        issue.code == "component_invalid" && issue.capability.as_deref() == Some("mcp_servers")
    }));
}

#[cfg(unix)]
#[test]
fn unsafe_v1_commands_component_is_deferred_without_discarding_skills_or_mcp() {
    let temp = tempfile::tempdir().unwrap();
    let plugin = temp.path().join("plugin");
    std::fs::create_dir_all(&plugin).unwrap();
    write_manifest(&plugin);
    write_skill(&plugin.join("skills/healthy"), "healthy");
    std::fs::write(plugin.join("mcp.json"), "{}").unwrap();
    let outside = temp.path().join("outside-commands");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, plugin.join("commands")).unwrap();

    let loaded = load_plugin_manifest(&plugin).unwrap().unwrap();
    assert!(loaded.manifest.contributions.commands.is_empty());
    assert_eq!(loaded.manifest.contributions.skills.len(), 1);
    assert!(matches!(
        loaded.manifest.contributions.mcp_servers,
        Some(PluginMcpDeclaration::Path(_))
    ));
    assert!(
        loaded
            .compatibility
            .deferred_capabilities
            .iter()
            .any(|capability| capability == "commands")
    );
    assert!(loaded.compatibility.issues.iter().any(|issue| {
        issue.code == "component_invalid" && issue.capability.as_deref() == Some("commands")
    }));
}

#[test]
fn oversized_v1_skills_component_is_deferred_without_discarding_mcp() {
    let temp = tempfile::tempdir().unwrap();
    let plugin = temp.path().join("plugin");
    std::fs::create_dir_all(plugin.join("skills")).unwrap();
    write_manifest(&plugin);
    std::fs::write(plugin.join("mcp.json"), "{}").unwrap();
    for index in 0..=4096 {
        std::fs::create_dir(plugin.join(format!("skills/entry-{index:04}"))).unwrap();
    }

    let loaded = load_plugin_manifest(&plugin).unwrap().unwrap();
    assert!(loaded.manifest.contributions.skills.is_empty());
    assert!(matches!(
        loaded.manifest.contributions.mcp_servers,
        Some(PluginMcpDeclaration::Path(_))
    ));
    assert!(
        loaded
            .compatibility
            .deferred_capabilities
            .iter()
            .any(|capability| capability == "skills")
    );
    assert!(loaded.compatibility.issues.iter().any(|issue| {
        issue.code == "component_invalid"
            && issue.capability.as_deref() == Some("skills")
            && issue.message.contains("4096-entry limit")
    }));
}

#[cfg(unix)]
#[test]
fn unsafe_v1_mcp_component_is_deferred_without_discarding_skills() {
    let temp = tempfile::tempdir().unwrap();
    let plugin = temp.path().join("plugin");
    std::fs::create_dir_all(&plugin).unwrap();
    write_manifest(&plugin);
    write_skill(&plugin.join("skills/healthy"), "healthy");
    let outside = temp.path().join("outside.json");
    std::fs::write(&outside, "{}").unwrap();
    std::os::unix::fs::symlink(&outside, plugin.join("mcp.json")).unwrap();

    let loaded = load_plugin_manifest(&plugin).unwrap().unwrap();
    assert!(loaded.manifest.contributions.mcp_servers.is_none());
    assert_eq!(loaded.manifest.contributions.skills.len(), 1);
    assert!(
        loaded
            .compatibility
            .deferred_capabilities
            .iter()
            .any(|capability| capability == "mcp_servers")
    );
    assert!(loaded.compatibility.issues.iter().any(|issue| {
        issue.code == "component_invalid" && issue.capability.as_deref() == Some("mcp_servers")
    }));
}

#[cfg(unix)]
#[test]
fn unsafe_single_skill_is_skipped_without_losing_healthy_siblings() {
    let temp = tempfile::tempdir().unwrap();
    let plugin = temp.path().join("plugin");
    std::fs::create_dir_all(plugin.join("skills/unsafe")).unwrap();
    write_manifest(&plugin);
    write_skill(&plugin.join("skills/healthy"), "healthy");

    let outside = temp.path().join("outside.md");
    std::fs::write(
        &outside,
        "---\nname: outside\ndescription: Outside\n---\nMust not load.",
    )
    .unwrap();
    std::os::unix::fs::symlink(&outside, plugin.join("skills/unsafe/SKILL.md")).unwrap();

    let loaded = load_plugin_manifest(&plugin).unwrap().unwrap();
    assert_eq!(loaded.manifest.contributions.skills.len(), 1);
    assert_eq!(
        loaded.manifest.contributions.skills[0].relative_path,
        PathBuf::from("skills/healthy")
    );
    assert!(loaded.compatibility.issues.iter().any(|issue| {
        issue.code == "component_entry_invalid" && issue.capability.as_deref() == Some("skills")
    }));
}
