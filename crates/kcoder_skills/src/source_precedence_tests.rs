//! Same-name precedence across built-in, plugin, project, external and user layers.
use crate::sources::{PluginSkillRoot, SkillLayer};
use crate::{SkillRegistry, builtin};
use kcoder_config::SkillSourcePreferenceSettings;
use std::path::{Path, PathBuf};

fn write_skill(root: &Path, name: &str, marker: &str) {
    let directory = root.join(name);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {marker}\n---\n{marker} body"),
    )
    .unwrap();
}

struct Fixture {
    _temp: tempfile::TempDir,
    cwd: PathBuf,
    user: PathBuf,
    builtin: PathBuf,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        let cwd = root.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let user = root.join("profile/skills");
        let builtin = user.join(builtin::BUILTIN_SKILLS_DIR_NAME);
        std::fs::create_dir_all(&builtin).unwrap();
        Self {
            _temp: temp,
            cwd,
            user,
            builtin,
            root,
        }
    }

    fn plugin(&self, id: &str, names: &[&str]) -> PluginSkillRoot {
        let root = self
            .root
            .join("plugins")
            .join(id.replace('@', "_"))
            .join("skills");
        for name in names {
            write_skill(&root, name, &format!("plugin {id}"));
        }
        PluginSkillRoot::new(root, id)
    }

    fn load(
        &self,
        external: &[PathBuf],
        plugins: &[PluginSkillRoot],
        preference: &SkillSourcePreferenceSettings,
    ) -> SkillRegistry {
        let mut dirs = external.to_vec();
        dirs.extend(plugins.iter().map(|plugin| plugin.root.clone()));
        let mut registry =
            SkillRegistry::load_with_layers(&self.cwd, dirs, Some(&self.user), true).unwrap();
        registry.apply_source_policy(plugins, preference);
        registry
    }
}

fn description(registry: &SkillRegistry, name: &str) -> String {
    registry.get_active(name).unwrap().description.clone()
}

#[test]
fn bundled_copy_beats_plugin_copy_and_the_plugin_copy_is_recorded_as_shadowed() {
    let fixture = Fixture::new();
    write_skill(&fixture.builtin, "lark-doc", "bundled");
    write_skill(&fixture.builtin, "kcoder-settings", "builtin");
    let plugin = fixture.plugin("lark@trae", &["lark-doc", "kcoder-settings", "lark-only"]);
    let registry = fixture.load(&[], &[plugin], &Default::default());
    assert_eq!(description(&registry, "lark-doc"), "bundled");
    assert_eq!(description(&registry, "kcoder-settings"), "builtin");
    assert_eq!(description(&registry, "lark-only"), "plugin lark@trae");
    assert!(!registry.get("lark-doc").unwrap().content.contains("plugin"));
    let candidates = registry.source_candidates();
    let copies: Vec<_> = candidates
        .iter()
        .filter(|candidate| candidate.name == "lark-doc")
        .collect();
    assert_eq!(copies.len(), 2);
    let bundled = copies.iter().find(|copy| copy.effective).unwrap();
    assert_eq!(bundled.layer, SkillLayer::Bundled);
    let plugin = copies.iter().find(|copy| !copy.effective).unwrap();
    assert_eq!(plugin.layer, SkillLayer::Plugin);
    assert_eq!(plugin.plugin_id.as_deref(), Some("lark@trae"));
    assert_eq!(plugin.marketplace_id.as_deref(), Some("trae"));
    assert!(
        candidates
            .iter()
            .any(|copy| copy.name == "kcoder-settings" && copy.layer == SkillLayer::Builtin)
    );
    // The catalog shown to Studio and the model sees exactly one copy per name.
    assert_eq!(
        registry
            .list_catalog()
            .iter()
            .filter(|skill| skill.name == "lark-doc")
            .count(),
        1
    );
}

#[test]
fn user_external_and_project_layers_keep_their_order_above_builtin() {
    let fixture = Fixture::new();
    let project = fixture.cwd.join(".kcoder/skills");
    let external = fixture.root.join("external");
    for name in ["shared", "no-user", "project-only"] {
        write_skill(&fixture.builtin, name, "bundled");
        write_skill(&project, name, "project");
    }
    for name in ["shared", "no-user"] {
        write_skill(&external, name, "external");
    }
    write_skill(&fixture.user, "shared", "user");
    let plugin = fixture.plugin("lark@trae", &["shared", "no-user", "project-only"]);
    let preference = SkillSourcePreferenceSettings {
        prefer_plugins: vec!["lark@trae".into()],
        ..Default::default()
    };
    let registry = fixture.load(&[external], &[plugin], &preference);
    assert_eq!(description(&registry, "shared"), "user");
    assert_eq!(description(&registry, "no-user"), "external");
    // Even an opted-in plugin copy stays below repository-owned project skills.
    assert_eq!(description(&registry, "project-only"), "project");
}

#[test]
fn opt_in_flips_one_name_or_one_plugin_without_touching_other_names() {
    let fixture = Fixture::new();
    for name in ["lark-doc", "lark-im"] {
        write_skill(&fixture.builtin, name, "bundled");
    }
    let plugin = fixture.plugin("lark@trae", &["lark-doc", "lark-im"]);
    let per_name = SkillSourcePreferenceSettings {
        prefer_plugin_skills: [("lark-doc".to_owned(), "lark@trae".to_owned())].into(),
        ..Default::default()
    };
    let registry = fixture.load(&[], std::slice::from_ref(&plugin), &per_name);
    assert_eq!(description(&registry, "lark-doc"), "plugin lark@trae");
    assert_eq!(description(&registry, "lark-im"), "bundled");
    assert!(
        registry
            .source_candidates()
            .iter()
            .any(|copy| copy.name == "lark-doc"
                && copy.layer == SkillLayer::Plugin
                && copy.preferred
                && copy.effective)
    );
    let per_plugin = SkillSourcePreferenceSettings {
        prefer_plugins: vec!["lark@trae".into()],
        ..Default::default()
    };
    let registry = fixture.load(&[], std::slice::from_ref(&plugin), &per_plugin);
    assert_eq!(description(&registry, "lark-doc"), "plugin lark@trae");
    assert_eq!(description(&registry, "lark-im"), "plugin lark@trae");
    // A per-name pin to another plugin overrides the per-plugin preference.
    let pinned_elsewhere = SkillSourcePreferenceSettings {
        prefer_plugin_skills: [("lark-im".to_owned(), "other@market".to_owned())].into(),
        prefer_plugins: vec!["lark@trae".into()],
    };
    let registry = fixture.load(&[], &[plugin], &pinned_elsewhere);
    assert_eq!(description(&registry, "lark-im"), "bundled");
}

#[test]
fn two_plugins_with_one_name_resolve_by_plugin_id_and_pins_choose_explicitly() {
    let fixture = Fixture::new();
    let first = fixture.plugin("zeta@market", &["shared-plugin-skill"]);
    let second = fixture.plugin("alpha@market", &["shared-plugin-skill"]);
    for order in [
        vec![first.clone(), second.clone()],
        vec![second.clone(), first.clone()],
    ] {
        let registry = fixture.load(&[], &order, &Default::default());
        assert_eq!(
            description(&registry, "shared-plugin-skill"),
            "plugin alpha@market"
        );
    }
    let pin = SkillSourcePreferenceSettings {
        prefer_plugin_skills: [("shared-plugin-skill".to_owned(), "zeta@market".to_owned())].into(),
        ..Default::default()
    };
    let registry = fixture.load(&[], &[second, first], &pin);
    assert_eq!(
        description(&registry, "shared-plugin-skill"),
        "plugin zeta@market"
    );
}

#[test]
fn partial_family_overlap_and_mixed_versions_are_reported() {
    let fixture = Fixture::new();
    for name in ["lark-doc", "lark-im", "lark-base"] {
        write_skill(&fixture.builtin, name, "bundled");
    }
    let partial = fixture.plugin("lark@qoder", &["lark-doc", "lark-im", "lark-legacy"]);
    let full = fixture.plugin("lark@trae", &["lark-doc", "lark-im", "lark-base"]);
    let registry = fixture.load(&[], &[partial.clone(), full.clone()], &Default::default());
    let overlaps = registry.family_overlaps();
    assert_eq!(overlaps.len(), 1, "{overlaps:?}");
    assert_eq!(overlaps[0].family, "lark");
    assert_eq!(overlaps[0].plugin_id, "lark@qoder");
    assert_eq!(overlaps[0].provided, ["lark-doc", "lark-im"]);
    assert_eq!(overlaps[0].missing, ["lark-base"]);
    assert_eq!(overlaps[0].extra, ["lark-legacy"]);
    // Opting in only one name of a complete family mixes versions.
    let mixed = SkillSourcePreferenceSettings {
        prefer_plugin_skills: [("lark-doc".to_owned(), "lark@trae".to_owned())].into(),
        ..Default::default()
    };
    let registry = fixture.load(&[], &[full], &mixed);
    let overlaps = registry.family_overlaps();
    assert_eq!(overlaps.len(), 1);
    assert_eq!(overlaps[0].plugin_id, "lark@trae");
    assert!(overlaps[0].missing.is_empty());
    assert_eq!(overlaps[0].effective_from_plugin, ["lark-doc"]);
}

#[test]
fn reload_and_removal_keep_the_source_policy() {
    let fixture = Fixture::new();
    write_skill(&fixture.builtin, "lark-doc", "bundled");
    write_skill(&fixture.builtin, "kcoder-settings", "builtin");
    let plugin = fixture.plugin("lark@trae", &["lark-doc", "kcoder-settings"]);
    let mut registry = fixture.load(&[], std::slice::from_ref(&plugin), &Default::default());
    assert!(registry.remove_named("kcoder-settings"));
    // Removing the winner never promotes a shadowed copy of the same name.
    assert!(registry.get_active("kcoder-settings").is_none());
    let reloaded = registry
        .reload_with_external_dirs(&fixture.cwd, [plugin.root.clone()])
        .unwrap();
    assert_eq!(description(&reloaded, "lark-doc"), "bundled");
    assert!(reloaded.get_active("kcoder-settings").is_none());
    assert!(
        reloaded
            .source_candidates()
            .iter()
            .any(|copy| copy.name == "lark-doc" && copy.layer == SkillLayer::Plugin)
    );
}

#[test]
fn install_preview_simulates_a_plugin_copy_without_its_existing_copies() {
    let fixture = Fixture::new();
    write_skill(&fixture.builtin, "lark-doc", "bundled");
    let installed = fixture.plugin("lark@trae", &["lark-doc", "lark-unique"]);
    let registry = fixture.load(&[], &[installed], &Default::default());
    let preview = registry.preview_plugin_copy("lark-doc", "lark@trae");
    assert!(!preview.plugin_wins);
    assert_eq!(preview.existing.unwrap().layer, SkillLayer::Bundled);
    // The plugin's own copy is not "existing"; it would win when alone.
    let unique = registry.preview_plugin_copy("lark-unique", "lark@trae");
    assert!(unique.plugin_wins);
    assert!(unique.existing.is_none());
    // A second plugin with a smaller ID would take over the plugin-only name.
    let other = registry.preview_plugin_copy("lark-unique", "alpha@market");
    assert!(other.plugin_wins);
    assert_eq!(
        other.existing.unwrap().plugin_id.as_deref(),
        Some("lark@trae")
    );
}
