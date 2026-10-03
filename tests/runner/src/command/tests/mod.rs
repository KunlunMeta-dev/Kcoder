use super::environment::selected_credential_environment;
use super::prerequisite::exactly_one_env_is_enabled;
#[cfg(unix)]
use super::prerequisite::resolve_required_executable;
use super::*;
use crate::matrix::RequiredExecutable;
use kcoder_test_harness::{ModelPolicy, RunMetadata, TestTier};
use std::io::Read;
use std::path::PathBuf;

include!("prerequisite.rs");
include!("environment.rs");
include!("log_capture.rs");
include!("execution.rs");

fn test_suite(command: Vec<String>) -> Suite {
    Suite {
        id: "spawn-error".to_string(),
        tiers: vec!["pr".to_string()],
        command,
        summary: Some(crate::matrix::SummaryPolicy {
            parser: crate::matrix::SummaryParser::ExitCode,
            allow_zero: true,
            expected_skips: crate::matrix::ExpectedSkips::Exact(0),
        }),
        depends_on: vec![],
        setup: false,
        cwd: None,
        timeout_seconds: 1,
        requires_commands: vec![],
        requires_files: vec![],
        required_artifacts: vec![],
        requires_env: vec![],
        requires_executables: vec![],
        requires_any_env: vec![],
        platforms: vec![],
        consent: None,
        consent_env: None,
        pass_env: vec![],
        secret_env: vec![],
        secret_env_selectors: vec![],
        env: Default::default(),
    }
}
