//! Shared training-mode skill attenuation for CLI and app-server Engines.
use kcoder_config::Settings;
use kcoder_skills::SkillRegistry;

pub fn apply_training_skill_isolation(settings: &Settings, registry: &mut SkillRegistry) {
    if settings.training_mode {
        registry.remove_named("kcoder-settings");
    }
}

/// Attribute plugin skill copies and apply the target user's same-name source
/// preference. Every host that builds a skill registry from a plugin snapshot
/// calls this so invocation, catalogs and inventory share one effective winner.
pub fn apply_skill_source_policy(
    settings: &Settings,
    plugins: &kcoder_plugins::EffectivePluginSnapshot,
    registry: &mut SkillRegistry,
) {
    let roots: Vec<kcoder_skills::PluginSkillRoot> = plugins
        .skill_root_owners
        .iter()
        .map(|owner| kcoder_skills::PluginSkillRoot::new(owner.root.clone(), &owner.plugin_id))
        .collect();
    registry.apply_source_policy(&roots, &settings.skills.source_preference);
}
