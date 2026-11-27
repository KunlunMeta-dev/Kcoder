use super::super::DomainStorageGuard;
use super::*;
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationScope};

const SENTINEL: &[u8] = b"legacy-secret-sentinel-7f3a";

fn scope() -> IntegrationScope {
    IntegrationScope {
        account_id: "account".into(),
        target_id: "target".into(),
        workspace_id: IntegrationNullable::Value("workspace".into()),
        identity_generation: "generation".into(),
        target_revision: "configuration".into(),
        organization_id: None,
    }
}

fn seed(profile: &PrivateDirectory, domain: StorageDomain) -> Result<String> {
    let (guard, ()) =
        DomainStorageGuard::initialize(profile, &scope(), domain, "legacy-seed", |directory| {
            directory.append(OsStr::new("token"), SENTINEL)?;
            Ok(())
        })?;
    Ok(guard.namespace_id().to_owned())
}

fn fixture() -> Result<(tempfile::TempDir, PrivateDirectory)> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    Ok((temp, profile))
}

#[test]
fn persisted_legacy_names_stay_stable() {
    for (domain, name) in LEGACY_CHANNEL_DOMAINS
        .iter()
        .zip(LEGACY_CHANNEL_DOMAIN_NAMES)
    {
        assert_eq!(domain.persisted_name(), name);
        assert!(domain.is_legacy_channel());
    }
    assert!(!StorageDomain::ConnectivitySources.is_legacy_channel());
    assert!(!StorageDomain::Policy.is_legacy_channel());
}

#[test]
fn detection_reports_only_legacy_domains_without_contents() -> Result<()> {
    let (temp, profile) = fixture()?;
    assert!(detect_legacy_channel_data(temp.path())?.entries.is_empty());
    let credentials = seed(&profile, StorageDomain::ConnectivityCredentials)?;
    seed(&profile, StorageDomain::ConnectivityBots)?;
    let kept = seed(&profile, StorageDomain::ConnectivitySources)?;
    let report = detect_legacy_channel_data(temp.path())?;
    assert_eq!(report.entries.len(), 2);
    assert_eq!(report.removable().count(), 2);
    let entry = report
        .entries
        .iter()
        .find(|entry| entry.namespace_id == credentials)
        .unwrap();
    assert_eq!(entry.domain, Some(StorageDomain::ConnectivityCredentials));
    assert_eq!(entry.status, LegacyChannelDataStatus::Present);
    assert_eq!(entry.top_level_entries, 1);
    assert_eq!(entry.top_level_bytes, SENTINEL.len() as u64);
    assert!(!format!("{report:?}").contains(std::str::from_utf8(SENTINEL)?));
    assert!(
        report
            .entries
            .iter()
            .all(|entry| entry.namespace_id != kept)
    );
    // Detection is read-only.
    assert!(temp.path().join(&credentials).join("token").is_file());
    Ok(())
}

#[test]
fn cleanup_removes_only_legacy_domains_and_is_idempotent() -> Result<()> {
    let (temp, profile) = fixture()?;
    let credentials = seed(&profile, StorageDomain::ConnectivityCredentials)?;
    seed(&profile, StorageDomain::ConnectivitySecretContexts)?;
    let kept = seed(&profile, StorageDomain::ConnectivitySources)?;
    let first = clean_legacy_channel_data(temp.path())?;
    assert_eq!(first.removed.len(), 2);
    assert!(first.refused.is_empty());
    assert!(!temp.path().join(&credentials).exists());
    assert!(!temp.path().join(format!(".{credentials}.jsonl")).exists());
    assert!(
        DomainStorageGuard::observe(&profile, &scope(), StorageDomain::ConnectivityCredentials)?
            .is_none(),
        "the task-workspace fence observes the domain as absent"
    );
    assert!(temp.path().join(&kept).join("token").is_file());
    DomainStorageGuard::observe(&profile, &scope(), StorageDomain::ConnectivitySources)?
        .unwrap()
        .directory(&profile)?;
    let second = clean_legacy_channel_data(temp.path())?;
    assert!(second.removed.is_empty() && second.refused.is_empty());
    assert!(detect_legacy_channel_data(temp.path())?.entries.is_empty());
    Ok(())
}

#[test]
fn interrupted_cleanup_is_detected_and_finished() -> Result<()> {
    let (temp, profile) = fixture()?;
    let credentials = seed(&profile, StorageDomain::ConnectivityCredentials)?;
    let digest = credentials.strip_prefix("integration-").unwrap();
    let trash = format!("{LEGACY_CHANNEL_TRASH_PREFIX}{digest}");
    // Crash after the rename, before recursive removal and marker removal.
    std::fs::rename(temp.path().join(&credentials), temp.path().join(&trash))?;
    let report = detect_legacy_channel_data(temp.path())?;
    assert_eq!(report.entries.len(), 1);
    assert_eq!(
        report.entries[0].status,
        LegacyChannelDataStatus::InterruptedCleanup
    );
    assert_eq!(clean_legacy_channel_data(temp.path())?.removed.len(), 1);
    assert_eq!(std::fs::read_dir(temp.path())?.count(), 0);

    // An orphaned trash directory without its marker is still ours by name.
    let orphan = format!("{LEGACY_CHANNEL_TRASH_PREFIX}{}", "a".repeat(64));
    profile.create_private_child(OsStr::new(&orphan))?;
    std::fs::write(temp.path().join(&orphan).join("token"), SENTINEL)?;
    let report = detect_legacy_channel_data(temp.path())?;
    assert_eq!(report.entries[0].domain, None);
    assert_eq!(clean_legacy_channel_data(temp.path())?.removed.len(), 1);
    assert_eq!(std::fs::read_dir(temp.path())?.count(), 0);
    Ok(())
}

#[test]
fn marker_without_directory_is_removed() -> Result<()> {
    let (temp, profile) = fixture()?;
    let events = seed(&profile, StorageDomain::ConnectivityEvents)?;
    profile.remove_child_entry(OsStr::new(&events), true)?;
    let report = detect_legacy_channel_data(temp.path())?;
    assert_eq!(
        report.entries[0].status,
        LegacyChannelDataStatus::MarkerOnly
    );
    assert_eq!(clean_legacy_channel_data(temp.path())?.removed.len(), 1);
    assert_eq!(std::fs::read_dir(temp.path())?.count(), 0);
    Ok(())
}

#[cfg(unix)]
#[test]
fn cleanup_refuses_symlinks_files_and_escapes() -> Result<()> {
    let (temp, profile) = fixture()?;
    let outside = tempfile::tempdir()?;
    std::fs::write(outside.path().join("retained"), SENTINEL)?;
    let linked = seed(&profile, StorageDomain::ConnectivityCredentials)?;
    let replaced = seed(&profile, StorageDomain::ConnectivityChatBindings)?;
    // Replace the namespace directory with a link escaping the profile.
    profile.remove_child_entry(OsStr::new(&linked), true)?;
    std::os::unix::fs::symlink(outside.path(), temp.path().join(&linked))?;
    // Replace another with an ordinary file.
    profile.remove_child_entry(OsStr::new(&replaced), true)?;
    std::fs::write(temp.path().join(&replaced), b"not a directory")?;
    // A trash-named link to the outside must not be followed either.
    let trap = format!("{LEGACY_CHANNEL_TRASH_PREFIX}{}", "b".repeat(64));
    std::os::unix::fs::symlink(outside.path(), temp.path().join(&trap))?;

    let report = detect_legacy_channel_data(temp.path())?;
    assert_eq!(report.entries.len(), 3);
    assert_eq!(report.refused().count(), 3);
    let cleanup = clean_legacy_channel_data(temp.path())?;
    assert!(cleanup.removed.is_empty());
    assert_eq!(cleanup.refused.len(), 3);
    assert_eq!(std::fs::read(outside.path().join("retained"))?, SENTINEL);
    assert!(
        std::fs::symlink_metadata(temp.path().join(&linked))?
            .file_type()
            .is_symlink()
    );
    assert!(temp.path().join(&replaced).is_file());
    assert!(temp.path().join(format!(".{linked}.jsonl")).is_file());
    Ok(())
}

#[test]
fn cleanup_refuses_busy_marker() -> Result<()> {
    let (temp, profile) = fixture()?;
    let open = seed(&profile, StorageDomain::ConnectivityBots)?;
    let busy = seed(&profile, StorageDomain::ConnectivityEvents)?;
    let holder = std::fs::File::open(temp.path().join(format!(".{busy}.jsonl")))?;
    fs2::FileExt::try_lock_shared(&holder)?;
    let cleanup = clean_legacy_channel_data(temp.path())?;
    assert_eq!(cleanup.removed.len(), 1);
    assert_eq!(cleanup.removed[0].namespace_id, open);
    let reasons = cleanup
        .refused
        .iter()
        .map(|entry| (entry.namespace_id.clone(), entry.status.clone()))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        reasons[&busy],
        LegacyChannelDataStatus::Refused("LEGACY_CHANNEL_DATA_BUSY")
    );
    assert!(temp.path().join(&busy).join("token").is_file());
    drop(holder);
    assert_eq!(clean_legacy_channel_data(temp.path())?.removed.len(), 1);
    assert!(!temp.path().join(&busy).exists());
    Ok(())
}

#[test]
fn missing_profile_reports_nothing() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let missing = temp.path().join("absent");
    assert!(detect_legacy_channel_data(&missing)?.entries.is_empty());
    assert_eq!(
        clean_legacy_channel_data(&missing)?,
        LegacyChannelCleanup::default()
    );
    assert!(!missing.exists());
    Ok(())
}
