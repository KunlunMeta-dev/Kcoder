//! Shared training-mode skill attenuation for CLI and app-server Engines.
use kcoder_config::Settings;
use kcoder_skills::SkillRegistry;

pub fn apply_training_skill_isolation(settings: &Settings, registry: &mut SkillRegistry) {
    if settings.training_mode {
        registry.remove_named("kcoder-settings");
    }
}
