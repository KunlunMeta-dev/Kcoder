//! Consent-gated native startup observation; no search or model request is sent.
#[cfg(windows)]
use crate::searxng_proxy_routes;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

fn consent(external: Option<OsString>, native: Option<OsString>) -> anyhow::Result<()> {
    anyhow::ensure!(
        external.as_deref() == Some(std::ffi::OsStr::new("1"))
            && native.as_deref() == Some(std::ffi::OsStr::new("1")),
        "Explicit external and native diagnostic gates are required"
    );
    Ok(())
}

struct Inputs {
    runtime: PathBuf,
    profile: PathBuf,
}

fn checked_directory(path: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(
        path.is_absolute()
            && !path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir)),
        "Explicit absolute ordinary directories are required"
    );
    #[cfg(windows)]
    anyhow::ensure!(
        matches!(path.components().next(), Some(std::path::Component::Prefix(prefix))
            if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_))),
        "Explicit local directories are required"
    );
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let metadata = std::fs::symlink_metadata(ancestor)?;
        anyhow::ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "Ordinary directories are required"
        );
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            anyhow::ensure!(
                metadata.file_attributes() & 0x400 == 0,
                "Ordinary directories are required"
            );
        }
    }
    Ok(())
}

fn inputs(runtime: Option<OsString>, profile: Option<OsString>) -> anyhow::Result<Inputs> {
    let runtime = PathBuf::from(
        runtime.ok_or_else(|| anyhow::anyhow!("Explicit owned runtime is required"))?,
    );
    let profile = PathBuf::from(
        profile.ok_or_else(|| anyhow::anyhow!("Explicit owned profile is required"))?,
    );
    checked_directory(&runtime)?;
    checked_directory(&profile)?;
    kcoder_config::PrivateDirectory::open_existing(&profile)?.verify_private_directory()?;
    anyhow::ensure!(
        std::fs::read_dir(&profile)?.next().is_none(),
        "A fresh empty owned profile is required"
    );
    anyhow::ensure!(
        runtime.canonicalize()? != profile.canonicalize()?,
        "Runtime and profile must be distinct"
    );
    Ok(Inputs { runtime, profile })
}

#[cfg(windows)]
fn rejected(phase: &str, class: &str, errno: Option<i32>) -> serde_json::Value {
    serde_json::json!({"mode":"startup-only","phase":phase,"passed":false,
        "failureClass":class,"ioErrno":errno,"logicalQueries":0,"modelCalls":0,
        "startupMayInitializeEnginesOrResolvePac":true})
}

#[cfg(windows)]
fn failure(error: &anyhow::Error) -> (&'static str, Option<i32>) {
    for cause in error.chain() {
        if cause.is::<tokio::time::error::Elapsed>() {
            return ("timeout", None);
        }
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            return ("io", io.raw_os_error());
        }
        if cause.is::<serde_json::Error>() {
            return ("invalid_document", None);
        }
    }
    ("startup_failed", None)
}

#[cfg(windows)]
fn profile_payload_count(profile: &Path) -> Option<usize> {
    let mut pending = vec![profile.to_owned()];
    let mut payloads = 0;
    let mut entries = 0;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory).ok()? {
            let entry = entry.ok()?;
            entries += 1;
            if entries > 2048 {
                return None;
            }
            let kind = entry.file_type().ok()?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else if !(entry.path() == profile.join("tmp/.manager.lock")
                && kind.is_file()
                && entry.metadata().ok()?.len() == 0)
            {
                payloads += 1;
            }
        }
    }
    Some(payloads)
}

#[cfg(windows)]
fn manager_released(profile: &Path) -> bool {
    let path = profile.join("tmp/.manager.lock");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
        Ok(info) if info.is_file() && !info.file_type().is_symlink() && info.len() == 0 => {}
        _ => return false,
    }
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .is_ok_and(|file| fs2::FileExt::try_lock_exclusive(&file).is_ok())
}

#[cfg(windows)]
async fn observe_startup(inputs: Inputs) -> serde_json::Value {
    use kcoder_tools::web_search::{SearchDispatchGuard, SearchFailure};
    use kcoder_types::web_search::{WebSearchErrorKind, WebSearchProvider};
    use std::time::{Duration, Instant};
    let started = Instant::now();
    let mut phase = "network_snapshot";
    let mut routes = None;
    let mut lease = None;
    let mut service = None;
    let network = kcoder_config::WebFetchSettings::default();
    let guard = SearchDispatchGuard::new(|provider| {
        if provider == WebSearchProvider::Searxng {
            Ok(())
        } else {
            Err(SearchFailure::new(
                WebSearchErrorKind::PolicyDenied,
                "Only owned startup is authorized",
                false,
            ))
        }
    })
    .with_network_settings(network.clone());
    let mut route_required = false;
    let mut launch_elapsed = None;
    let outcome: anyhow::Result<bool> = async {
        route_required = kcoder_tools::web_network::requires_system_proxy_resolution(&network)?;
        if route_required {
            phase = "parent_routes";
            routes = Some(searxng_proxy_routes::ProxyRoutes::start().await?);
            lease = Some(
                routes
                    .as_ref()
                    .expect("owned route service")
                    .activate(network.clone(), Some(&guard))?,
            );
        }
        let parent = routes
            .as_ref()
            .zip(lease.as_ref())
            .map(|(routes, lease)| routes.startup(lease));
        phase = "launch_to_ready";
        let launch_started = Instant::now();
        let launched = super::launch(&inputs.runtime, &network, parent).await;
        launch_elapsed = Some(launch_started.elapsed().as_millis());
        service = Some(launched?);
        Ok(service
            .as_mut()
            .expect("owned launched service")
            .is_healthy())
    }
    .await;
    let startup_elapsed = started.elapsed().as_millis();
    let healthy = outcome.as_ref().is_ok_and(|healthy| *healthy);
    let failure = outcome.as_ref().err().map(failure);
    let route_may_dispatch = lease.as_ref().is_some_and(|lease| lease.may_dispatch());
    // Revoke only this diagnostic's startup authority and original worker owner.
    drop(lease);
    drop(service);
    drop(routes);
    let cleanup_started = Instant::now();
    while (profile_payload_count(&inputs.profile) != Some(0) || !manager_released(&inputs.profile))
        && cleanup_started.elapsed() < Duration::from_secs(5)
    {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let payloads = profile_payload_count(&inputs.profile);
    let manager = manager_released(&inputs.profile);
    let cleanup = payloads == Some(0) && manager;
    let failure = failure.or({
        if !healthy {
            Some(("unhealthy", None))
        } else if !cleanup {
            Some(("cleanup_unobserved", None))
        } else {
            None
        }
    });
    serde_json::json!({"mode":"startup-only","phase":phase,"passed":healthy && cleanup,
        "readyObserved":outcome.is_ok(),"healthy":healthy,"launchToReadyElapsedMs":launch_elapsed,
        "fullSealedVerifyIncluded":true,
        "startupElapsedMs":startup_elapsed,"failureClass":failure.map(|value|value.0),"ioErrno":failure.and_then(|value|value.1),
        "systemProxyRoutesRequired":route_required,"parentRouteMayDispatch":route_may_dispatch,
        "logicalQueries":0,"modelCalls":0,"startupMayInitializeEnginesOrResolvePac":true,
        "remainingPayloadCount":payloads,"managerLockReleased":manager,"cleanupObserved":cleanup,"cleanupElapsedMs":cleanup_started.elapsed().as_millis()})
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "Explicit native/external gates and owned sealed runtime/private empty profile; startup may initialize engines or resolve PAC"]
async fn owned_startup_only_reports_ready_and_cleanup() {
    let preflight = consent(
        std::env::var_os("KCODER_E2E_WEB_EXTERNAL_NETWORK"),
        std::env::var_os("KCODER_E2E_WINDOWS_NATIVE_LIBTEST"),
    )
    .and_then(|()| {
        inputs(
            std::env::var_os("KCODER_SEARXNG_RUNTIME"),
            std::env::var_os("KCODER_CONFIG_DIR"),
        )
    });
    let receipt = match preflight {
        Ok(inputs) => observe_startup(inputs).await,
        Err(_) => rejected("inputs", "preflight_rejected", None),
    };
    println!("\n{receipt}");
    assert!(
        receipt["passed"] == true,
        "Owned startup-only diagnostic did not observe ready and cleanup"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn private_profile() -> tempfile::TempDir {
        let profile = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(profile.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        profile
    }

    #[test]
    fn both_native_and_external_gates_are_required() {
        assert!(consent(Some("1".into()), Some("1".into())).is_ok());
        for (external, native) in [
            (None, None),
            (Some("1".into()), None),
            (None, Some("1".into())),
            (Some("true".into()), Some("1".into())),
        ] {
            assert!(consent(external, native).is_err());
        }
    }

    #[test]
    fn inputs_need_absolute_existing_distinct_runtime_and_empty_private_profile() {
        let runtime = tempfile::tempdir().unwrap();
        let profile = private_profile();
        let valid = inputs(Some(runtime.path().into()), Some(profile.path().into())).unwrap();
        assert_eq!(valid.runtime, runtime.path());
        assert_eq!(valid.profile, profile.path());
        assert!(inputs(None, Some(profile.path().into())).is_err());
        assert!(inputs(Some(runtime.path().into()), None).is_err());
        assert!(inputs(Some("relative".into()), Some(profile.path().into())).is_err());
        assert!(inputs(Some(runtime.path().into()), Some("relative".into())).is_err());
        assert!(inputs(Some(profile.path().into()), Some(profile.path().into())).is_err());
        std::fs::create_dir(profile.path().join("not-fresh")).unwrap();
        assert!(inputs(Some(runtime.path().into()), Some(profile.path().into())).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn linked_ancestors_and_unprivate_profiles_are_rejected_without_repair() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let parent = tempfile::tempdir().unwrap();
        let runtime = tempfile::tempdir().unwrap();
        let profile = private_profile();
        let linked = parent.path().join("linked");
        symlink(runtime.path(), &linked).unwrap();
        assert!(inputs(Some(linked.into()), Some(profile.path().into())).is_err());
        std::fs::set_permissions(profile.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(inputs(Some(runtime.path().into()), Some(profile.path().into())).is_err());
        assert_eq!(
            profile.path().metadata().unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}
