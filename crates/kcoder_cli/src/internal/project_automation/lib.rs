//! Owned project automation admission, diagnostics, and trigger delivery.

#[path = "../../app_server/cron_processor.rs"]
pub mod cron_processor;
#[path = "../../app_server/project_automations.rs"]
pub mod project_automations;

#[cfg(test)]
#[path = "../../../../kcoder_config/src/test_isolated_profile.rs"]
mod isolated_test_profile;
