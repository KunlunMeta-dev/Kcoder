//! Owned-child path provenance. Business admission still verifies the live selection.
use super::*;
use anyhow::{Context, Result, ensure};
use std::sync::OnceLock;

static STARTUP_CONTEXT: OnceLock<StorageStartupContext> = OnceLock::new();

/// The synchronous executable entry removes the environment field before workers start.
pub fn capture_storage_startup_context(raw: Option<&OsStr>) -> Result<()> {
    if let Some(raw) = raw {
        STARTUP_CONTEXT
            .set(decode(raw)?)
            .map_err(|_| anyhow::anyhow!("STORAGE_CONTEXT_ALREADY_CAPTURED"))?;
    }
    Ok(())
}

pub(super) fn captured() -> Option<StorageStartupContext> {
    STARTUP_CONTEXT.get().cloned()
}

pub(super) fn decode(raw: &OsStr) -> Result<StorageStartupContext> {
    let text = raw.to_str().context("STORAGE_CONTEXT_INVALID")?;
    ensure!(
        text.len() <= kcoder_types::STORAGE_STARTUP_MAX_BYTES,
        "STORAGE_CONTEXT_INVALID"
    );
    serde_json::from_str(text).context("STORAGE_CONTEXT_INVALID")
}

pub(super) fn apply(
    mut input: StorageResolveInput,
) -> Result<(StorageResolveInput, Option<StoragePaths>)> {
    input.validate_environment(cfg!(windows))?;
    let Some(context) = input.startup_context.take() else {
        return Ok((input, None));
    };
    ensure!(context.version == 1, "STORAGE_CONTEXT_VERSION_UNSUPPORTED");
    ensure!(context.home == input.home, "STORAGE_CONTEXT_HOME_CHANGED");
    let mut inherited = StorageResolveInput {
        home: context.home,
        platform_config: context.platform_config,
        env: BTreeMap::new(),
        record: context.record,
        consumer: context.consumer,
        development: context.development,
        startup_context: None,
    };
    for (name, path) in context.overrides {
        ensure!(
            OVERRIDE_NAMES.contains(&name.as_str()),
            "STORAGE_CONTEXT_INVALID"
        );
        let path = super::resolve::absolute(&path)?;
        inherited.env.insert(name, path.into_os_string());
    }
    ensure!(
        !inherited.ignores_personal_selection() || inherited.record.is_none(),
        "STORAGE_CONTEXT_INVALID"
    );
    let paths =
        super::project_deferred_legacy_paths(&inherited, resolve_storage_paths(&inherited)?)?;
    for name in OVERRIDE_NAMES {
        let Some(actual) = input.value(name) else {
            continue;
        };
        let derived = match *name {
            "KCODER_HOME" | "KCODER_CONFIG_DIR" => paths.data_root.clone(),
            "KCODER_CACHE_DIR" => paths.cache_root.clone(),
            "KCODER_STUDIO_DATA_DIR" => paths.gateway_root.clone(),
            "KCODER_STUDIO_DESKTOP_USER_DATA_DIR" => paths.desktop_root.clone(),
            "KCODER_STUDIO_SERVERS_STORE" => paths.gateway_root.join("servers.json"),
            _ => unreachable!(),
        };
        let expected = inherited.value(name).map(PathBuf::from).unwrap_or(derived);
        ensure!(
            super::resolve::absolute(std::path::Path::new(actual))? == expected,
            "STORAGE_CONTEXT_CONFLICT"
        );
    }
    Ok((inherited, Some(paths)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn context(home: &std::path::Path) -> StorageStartupContext {
        StorageStartupContext {
            version: 1,
            home: Some(home.to_owned()),
            platform_config: Some(home.join("Platform")),
            overrides: BTreeMap::new(),
            record: Some(StorageLocationRecord {
                version: 1,
                revision: 1,
                data_root: home.join("Data"),
                cache_root: home.join("Cache"),
                operation_id: None,
            }),
            consumer: StorageConsumer::Desktop,
            development: false,
        }
    }

    #[test]
    fn inherited_paths_preserve_sources_and_queries_do_not_reread_the_locator() {
        let owned = tempfile::tempdir().unwrap();
        let context = context(owned.path());
        let input = || StorageResolveInput {
            home: Some(owned.path().to_owned()),
            env: BTreeMap::from([(
                "KCODER_HOME".into(),
                owned.path().join("Data").into_os_string(),
            )]),
            startup_context: Some(context.clone()),
            ..Default::default()
        };
        let paths = load_storage_paths(input()).unwrap();
        assert_eq!(paths.layout, kcoder_types::StorageLayout::Unified);
        assert_eq!(
            paths.sources.data_root,
            kcoder_types::StorageLocationSource::Selection
        );
        assert_eq!(paths.selection_revision, Some(1));
        assert!(!paths.externally_configured);
        assert!(fs::read_dir(owned.path()).unwrap().next().is_none());
        assert_eq!(
            StorageInstance::open(input()).err().unwrap().to_string(),
            "STORAGE_SELECTION_CHANGED"
        );
        assert!(!owned.path().join("Data").exists());
    }

    #[test]
    fn inherited_context_cannot_switch_home_overrides_or_hide_pending_migration() {
        let owned = tempfile::tempdir().unwrap();
        let context = context(owned.path());
        let input = |home| StorageResolveInput {
            home: Some(owned.path().to_owned()),
            env: BTreeMap::from([("KCODER_CONFIG_DIR".into(), home)]),
            startup_context: Some(context.clone()),
            ..Default::default()
        };
        assert_eq!(
            load_storage_paths(input(owned.path().join("Other").into_os_string()))
                .unwrap_err()
                .to_string(),
            "STORAGE_CONTEXT_CONFLICT"
        );
        let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
        let from = resolve_storage_paths(&StorageResolveInput {
            home: Some(owned.path().to_owned()),
            ..Default::default()
        })
        .unwrap();
        coordinator
            .begin(kcoder_types::StorageMigrationPlan {
                version: 1,
                operation_id: "inherited-busy".into(),
                original: None,
                from,
                target: StorageLocationRecord {
                    operation_id: Some("inherited-busy".into()),
                    ..context.record.unwrap()
                },
                components: vec![],
                target_bindings: vec![],
                launch_intent: kcoder_types::StorageLaunchIntent::Desktop,
            })
            .unwrap();
        drop(coordinator);
        let mut context = self::context(owned.path());
        context.record = None;
        let error = StorageInstance::open(StorageResolveInput {
            home: Some(owned.path().to_owned()),
            startup_context: Some(context),
            ..Default::default()
        })
        .err()
        .unwrap();
        assert_eq!(error.to_string(), "STORAGE_MIGRATION_PENDING");
    }
}
