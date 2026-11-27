use super::*;
use kcoder_config::PrivateDirectory;
use kcoder_state::domain_storage::{DomainStorageGuard, StorageDomain};
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationScope};
use std::ffi::OsStr;

const SENTINEL: &str = "doctor-legacy-secret-sentinel-91c2";

fn seeded() -> Result<(tempfile::TempDir, String)> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    let scope = IntegrationScope {
        account_id: "account".into(),
        target_id: "target".into(),
        workspace_id: IntegrationNullable::Value("workspace".into()),
        identity_generation: "generation".into(),
        target_revision: "configuration".into(),
        organization_id: None,
    };
    let (guard, ()) = DomainStorageGuard::initialize(
        &profile,
        &scope,
        StorageDomain::ConnectivityCredentials,
        "legacy-seed",
        |directory| {
            directory.append(OsStr::new("token"), SENTINEL.as_bytes())?;
            Ok(())
        },
    )?;
    Ok((temp, guard.namespace_id().to_owned()))
}

fn run(
    profile: &Path,
    assume_yes: bool,
    interactive: bool,
    answer: bool,
) -> (Result<()>, String, usize) {
    let mut asked = 0;
    let mut confirm = |_: &str| {
        asked += 1;
        Ok(answer)
    };
    let mut out = Vec::new();
    let result = run_cleanup(
        profile,
        CleanupConsent {
            assume_yes,
            interactive,
            confirm: &mut confirm,
        },
        &mut out,
    );
    (result, String::from_utf8(out).unwrap(), asked)
}

#[test]
fn doctor_detection_lists_labels_and_never_contents() -> Result<()> {
    let (temp, namespace) = seeded()?;
    let lines = gather(temp.path()).join("\n");
    assert!(lines.contains("legacy channel data: 1 removable, 0 refused"));
    assert!(lines.contains(CLEAN_FLAG));
    assert!(lines.contains("legacy connectivity_credentials"));
    assert!(lines.contains(&namespace));
    assert!(!lines.contains(SENTINEL));
    assert!(temp.path().join(&namespace).join("token").is_file());
    let empty = tempfile::tempdir()?;
    assert_eq!(gather(empty.path()), vec!["legacy channel data: none"]);
    Ok(())
}

#[test]
fn non_interactive_cleanup_without_yes_refuses_and_keeps_data() -> Result<()> {
    let (temp, namespace) = seeded()?;
    let (result, out, asked) = run(temp.path(), false, false, true);
    let error = result.unwrap_err().to_string();
    assert!(error.contains("LEGACY_CHANNEL_CLEANUP_CONSENT_REQUIRED"));
    assert_eq!(asked, 0);
    assert!(!out.contains(SENTINEL) && !error.contains(SENTINEL));
    assert!(temp.path().join(&namespace).join("token").is_file());
    Ok(())
}

#[test]
fn interactive_decline_keeps_data_and_accept_removes_it() -> Result<()> {
    let (temp, namespace) = seeded()?;
    let (result, out, asked) = run(temp.path(), false, true, false);
    result?;
    assert_eq!(asked, 1);
    assert!(out.contains("cancelled; nothing removed"));
    assert!(temp.path().join(&namespace).is_dir());
    let (result, out, asked) = run(temp.path(), false, true, true);
    result?;
    assert_eq!(asked, 1);
    assert!(out.contains("1 removed, 0 refused"));
    assert!(!out.contains(SENTINEL));
    assert!(!temp.path().join(&namespace).exists());
    Ok(())
}

#[test]
fn explicit_yes_cleanup_is_idempotent() -> Result<()> {
    let (temp, namespace) = seeded()?;
    let (result, out, asked) = run(temp.path(), true, false, false);
    result?;
    assert_eq!(asked, 0);
    assert!(out.contains(&format!(
        "removed legacy connectivity_credentials: namespace={namespace}"
    )));
    let (result, out, _) = run(temp.path(), true, false, false);
    result?;
    assert!(out.contains("legacy channel data: none"));
    assert!(out.contains("nothing to remove"));
    Ok(())
}

#[cfg(unix)]
#[test]
fn refused_symlink_is_reported_as_failure_and_not_followed() -> Result<()> {
    let (temp, namespace) = seeded()?;
    let outside = tempfile::tempdir()?;
    std::fs::write(outside.path().join("retained"), SENTINEL)?;
    std::fs::remove_dir_all(temp.path().join(&namespace))?;
    std::os::unix::fs::symlink(outside.path(), temp.path().join(&namespace))?;
    let (result, out, asked) = run(temp.path(), true, false, false);
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("LEGACY_CHANNEL_CLEANUP_REFUSED")
    );
    assert_eq!(asked, 0);
    assert!(out.contains("refused (LEGACY_CHANNEL_ENTRY_NOT_DIRECTORY)"));
    assert!(!out.contains(SENTINEL));
    assert_eq!(
        std::fs::read_to_string(outside.path().join("retained"))?,
        SENTINEL
    );
    Ok(())
}

#[test]
fn cleanup_flags_parse_only_together_with_the_explicit_command() {
    use crate::cli_args::{Cli, Commands};
    use clap::Parser;
    let parse = |args: &[&str]| Cli::try_parse_from(args).map(|cli| cli.command);
    assert!(matches!(
        parse(&["kcoder", "doctor"]).unwrap(),
        Some(Commands::Doctor {
            clean_legacy_channel_data: false,
            yes: false
        })
    ));
    assert!(matches!(
        parse(&["kcoder", "doctor", CLEAN_FLAG, "--yes"]).unwrap(),
        Some(Commands::Doctor {
            clean_legacy_channel_data: true,
            yes: true
        })
    ));
    assert!(parse(&["kcoder", "doctor", "--yes"]).is_err());
}
