//! Explicit sealed verification or one consented, fixed bundled search query.
use kcoder_tools::web_search::{BundledSearchBackend, SearchDispatchGuard, SearchFailure};
use kcoder_types::web_search::{WebSearchErrorKind, WebSearchProvider};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

fn main() -> anyhow::Result<()> {
    let arguments = std::env::args_os().collect::<Vec<_>>();
    #[cfg(target_os = "linux")]
    {
        if arguments.get(1).is_some_and(|arg| {
            arg == kcoder_process_supervisor::linux_stdio::INTERNAL_STDIO_OWNER_V1
        }) {
            std::process::exit(kcoder_process_supervisor::linux_stdio::entry(&arguments)?);
        }
    }
    let mode = probe_mode(&arguments[1..])?;
    if mode == ProbeMode::VerifyOnly {
        let receipt = verify_only(
            std::env::var_os("KCODER_SEARXNG_RUNTIME"),
            std::env::var_os("KCODER_CONFIG_DIR"),
        );
        println!("{receipt}");
        if receipt["passed"] != true {
            std::process::exit(1);
        }
        return Ok(());
    }
    anyhow::ensure!(
        std::env::var("KCODER_E2E_WEB_EXTERNAL_NETWORK").as_deref() == Ok("1"),
        "Explicit external-provider consent is required"
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(probe())
}

#[derive(Debug, PartialEq, Eq)]
enum ProbeMode {
    Live,
    VerifyOnly,
}

fn probe_mode(arguments: &[std::ffi::OsString]) -> anyhow::Result<ProbeMode> {
    match arguments {
        [] => Ok(ProbeMode::Live),
        [argument] if argument == "--verify-only" => Ok(ProbeMode::VerifyOnly),
        _ => anyhow::bail!("Unsupported bundled probe arguments"),
    }
}

fn checked_directory(path: &std::path::Path) -> anyhow::Result<()> {
    anyhow::ensure!(
        path.is_absolute(),
        "An explicit absolute directory is required"
    );
    #[cfg(windows)]
    anyhow::ensure!(
        matches!(
            path.components().next(),
            Some(std::path::Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_))
        ),
        "An explicit local directory is required"
    );
    // Inspect ancestors first, so a linked parent is rejected before traversal.
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let metadata = std::fs::symlink_metadata(ancestor)?;
        anyhow::ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "A regular owned directory is required"
        );
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            anyhow::ensure!(
                metadata.file_attributes() & 0x400 == 0,
                "A regular owned directory is required"
            );
        }
    }
    Ok(())
}

fn verification_runtime(
    runtime: Option<std::ffi::OsString>,
    profile: Option<std::ffi::OsString>,
) -> anyhow::Result<std::path::PathBuf> {
    let runtime = runtime.ok_or_else(|| anyhow::anyhow!("Explicit owned runtime is required"))?;
    let profile = profile.ok_or_else(|| anyhow::anyhow!("Explicit owned profile is required"))?;
    let runtime = std::path::PathBuf::from(runtime);
    let profile = std::path::PathBuf::from(profile);
    checked_directory(&runtime)?;
    checked_directory(&profile)?;
    anyhow::ensure!(
        std::fs::read_dir(profile)?.next().is_none(),
        "A fresh empty owned profile is required"
    );
    Ok(runtime)
}

fn verify_only(
    runtime: Option<std::ffi::OsString>,
    profile: Option<std::ffi::OsString>,
) -> serde_json::Value {
    let inputs_started = Instant::now();
    let mut metrics = kcoder_mcp::searxng_runtime::VerifyMetrics::default();
    let (phase, elapsed, passed) = match verification_runtime(runtime, profile) {
        Ok(runtime) => {
            let started = Instant::now();
            let passed =
                kcoder_mcp::searxng_runtime::verify_with_metrics(&runtime, &mut metrics).is_ok();
            ("sealed_verify", started.elapsed(), passed)
        }
        Err(_) => ("verify_inputs", inputs_started.elapsed(), false),
    };
    // Never serialize the runtime path, manifest body, or underlying error.
    serde_json::json!({"mode":"verify-only","phase":phase,
        "elapsedMs":elapsed.as_millis().min(u64::MAX as u128) as u64,"passed":passed,
        "pythonStarts":0,"dnsRequests":0,"httpRequests":0,"logicalRequests":0,
        "verification":metrics.json()})
}

fn profile_files(path: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut pending = vec![path.to_owned()];
    let mut files = Vec::new();
    while let Some(path) = pending.pop() {
        let entries = match std::fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(_) => return vec![path.join("unreadable-profile")],
        };
        {
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => return vec![path.join("unreadable-profile-entry")],
                };
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    pending.push(entry.path());
                } else {
                    files.push(entry.path());
                }
                if files.len() > 1024 || pending.len() > 1024 {
                    files.push(path.join("profile-scan-limit"));
                    return files;
                }
            }
        }
    }
    files
}

fn remaining_payloads(profile: &std::path::Path) -> Vec<String> {
    profile_files(profile)
        .into_iter()
        .filter(|path| {
            !(path == &profile.join("tmp/.manager.lock")
                && path
                    .symlink_metadata()
                    .is_ok_and(|m| m.is_file() && m.len() == 0))
        })
        .map(|path| {
            path.strip_prefix(profile)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}
fn manager_released(profile: &std::path::Path) -> bool {
    let path = profile.join("tmp/.manager.lock");
    if !path.exists() {
        return true;
    }
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .is_ok_and(|file| fs2::FileExt::try_lock_exclusive(&file).is_ok())
}
async fn probe() -> anyhow::Result<()> {
    let profile = std::env::var_os("KCODER_CONFIG_DIR")
        .ok_or_else(|| anyhow::anyhow!("Owned profile is required"))?;
    let profile = std::path::PathBuf::from(profile);
    anyhow::ensure!(
        profile.is_absolute() && profile_files(&profile).is_empty(),
        "A fresh empty owned profile is required"
    );
    let started = Instant::now();
    let backend = kcoder_mcp::web_search::BundledWebSearch::new();
    let constructed_micros = started.elapsed().as_micros();
    let checks = Arc::new(AtomicUsize::new(0));
    let observations = checks.clone();
    let guard = SearchDispatchGuard::new(move |provider| {
        observations.fetch_add(1, Ordering::SeqCst);
        if provider == WebSearchProvider::Searxng {
            Ok(())
        } else {
            Err(SearchFailure::new(
                WebSearchErrorKind::PolicyDenied,
                "Only the owned bundled source is selected",
                false,
            ))
        }
    })
    .with_network_settings(kcoder_config::WebFetchSettings::default());
    let query = "Rust programming language official documentation doc.rust-lang.org";
    let input = serde_json::from_value(serde_json::json!({"query":query,"num_results":3}))?;
    let outcome =
        tokio::time::timeout(Duration::from_secs(70), backend.search(&input, &guard)).await;
    let cold_request_ms = started.elapsed().as_millis();
    let cleanup_start = Instant::now();
    backend.close().await;
    while (!remaining_payloads(&profile).is_empty() || !manager_released(&profile))
        && cleanup_start.elapsed() < Duration::from_secs(5)
    {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let cleanup_observed = remaining_payloads(&profile).is_empty() && manager_released(&profile);
    let (page, error) = match outcome {
        Ok(Ok(page)) => (Some(page), None),
        Ok(Err(error)) => (
            None,
            Some(
                serde_json::json!({"kind":error.kind,"message":error.message,"requestSent":error.request_sent}),
            ),
        ),
        Err(_) => (
            None,
            Some(serde_json::json!({"kind":"timeout","requestSent":true})),
        ),
    };
    let result_count = page.as_ref().map_or(0, |page| page.results.len());
    let official_count = page.as_ref().map_or(0, |page| {
        page.results
            .iter()
            .filter(|hit| url_is_official(&hit.url))
            .count()
    });
    let receipt = serde_json::json!({"provider":"searxng","query":query,"logicalRequests":1,"completedAtUnixMs":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis(),"modelCalls":0,"searchKeyUsed":false,
        "constructedMicros":constructed_micros,"coldRequestMs":cold_request_ms,"startupOnlyMs":null,"timingScope":"cold request includes verified component startup and upstream query",
        "dispatchGuardChecks":checks.load(Ordering::SeqCst),"resultCount":result_count,"officialResultCount":official_count,
        "page":page,"error":error,"retainedControlFiles":profile_files(&profile).iter().filter_map(|path|path.strip_prefix(&profile).ok()).map(|path|path.to_string_lossy().into_owned()).collect::<Vec<_>>(),"remainingPayloads":remaining_payloads(&profile),"managerLockReleased":manager_released(&profile),"cleanupObserved":cleanup_observed,"cleanupMs":cleanup_start.elapsed().as_millis(),"passed":result_count > 0 && cleanup_observed});
    println!("{receipt}");
    anyhow::ensure!(
        result_count > 0 && cleanup_observed,
        "The real bundled query did not return a nonempty result or complete owned cleanup"
    );
    Ok(())
}

fn url_is_official(raw: &str) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|url| {
        matches!(
            url.host_str(),
            Some(
                "doc.rust-lang.org" | "rust-lang.org" | "www.rust-lang.org" | "blog.rust-lang.org"
            )
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verification_is_explicit_and_unknown_arguments_never_select_live_query() {
        assert_eq!(probe_mode(&[]).unwrap(), ProbeMode::Live);
        assert_eq!(
            probe_mode(&["--verify-only".into()]).unwrap(),
            ProbeMode::VerifyOnly
        );
        for args in [
            vec!["--help".into()],
            vec!["--verify-only".into(), "--query".into()],
            vec!["--verify-only".into(), "--verify-only".into()],
        ] {
            assert!(probe_mode(&args).is_err());
        }
    }

    #[test]
    fn verification_requires_existing_absolute_runtime_and_fresh_empty_profile() {
        let runtime = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let inputs =
            || verification_runtime(Some(runtime.path().into()), Some(profile.path().into()));
        assert_eq!(inputs().unwrap(), runtime.path());
        assert!(verification_runtime(None, Some(profile.path().into())).is_err());
        assert!(verification_runtime(Some(runtime.path().into()), None).is_err());
        assert!(
            verification_runtime(Some("relative".into()), Some(profile.path().into())).is_err()
        );
        assert!(
            verification_runtime(Some(runtime.path().into()), Some("relative".into())).is_err()
        );
        std::fs::create_dir(profile.path().join("not-fresh")).unwrap();
        assert!(inputs().is_err());
        std::fs::remove_dir(profile.path().join("not-fresh")).unwrap();
        std::fs::write(profile.path().join("settings.json"), b"{}").unwrap();
        assert!(inputs().is_err());
    }

    #[test]
    fn sealed_verification_failure_is_fixed_json_without_paths_or_error_body() {
        let runtime = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let receipt = verify_only(Some(runtime.path().into()), Some(profile.path().into()));
        assert_eq!(receipt["phase"], "sealed_verify");
        assert_eq!(receipt["passed"], false);
        assert!(receipt["elapsedMs"].is_u64());
        for key in [
            "pythonStarts",
            "dnsRequests",
            "httpRequests",
            "logicalRequests",
        ] {
            assert_eq!(receipt[key], 0);
        }
        assert!(
            !receipt
                .to_string()
                .contains(&runtime.path().display().to_string())
        );
        assert!(profile.path().read_dir().unwrap().next().is_none());
        std::fs::write(
            runtime.path().join("runtime-manifest.json"),
            b"UNTRUSTED_MANIFEST_BODY",
        )
        .unwrap();
        let malformed = verify_only(Some(runtime.path().into()), Some(profile.path().into()));
        assert_eq!(malformed["phase"], "sealed_verify");
        assert_eq!(malformed["passed"], false);
        assert!(!malformed.to_string().contains("UNTRUSTED_MANIFEST_BODY"));
        assert_eq!(verify_only(None, None)["phase"], "verify_inputs");
    }

    #[cfg(unix)]
    #[test]
    fn verification_rejects_a_linked_runtime_parent() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("runtime");
        std::fs::create_dir(&runtime).unwrap();
        let link = root.path().join("linked");
        std::os::unix::fs::symlink(root.path(), &link).unwrap();
        assert!(checked_directory(&link.join("runtime")).is_err());
    }

    #[test]
    fn cleanup_accepts_only_the_empty_released_manager_control_file() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("tmp")).unwrap();
        let manager = root.path().join("tmp/.manager.lock");
        std::fs::write(&manager, b"").unwrap();
        assert!(remaining_payloads(root.path()).is_empty());
        assert!(manager_released(root.path()));
        let held = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&manager)
            .unwrap();
        fs2::FileExt::lock_exclusive(&held).unwrap();
        assert!(!manager_released(root.path()));
        drop(held);
        std::fs::write(root.path().join("tmp/unknown.lock"), b"owned payload").unwrap();
        assert_eq!(
            remaining_payloads(root.path()),
            [std::path::Path::new("tmp")
                .join("unknown.lock")
                .to_string_lossy()
                .into_owned()]
        );
        assert!(!remaining_payloads(&root.path().join("missing")).is_empty());
    }
}
