//! Private target-side queue worker. The database is the bounded, durable IPC;
//! no model credentials, client-provided identity, or public listener are stored.
use super::{knowledge_job_runner, knowledge_model::ProviderWikiModel, knowledge_requests};
use anyhow::{Context, Result, ensure};
use clap::Parser;
use fs2::FileExt;
use kcoder_engine::ClientModelConfiguration;
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub(super) fn is_remote() -> bool {
    cfg!(unix)
        && (std::env::var_os("SSH_CONNECTION").is_some()
            || std::env::var_os("KCODER_ACCOUNT_PRINCIPAL_ID").is_some())
}

pub(super) fn ensure_started(path: &Path) -> Result<()> {
    // Account workers must remain under the root-owned revision supervisor.
    // Never detach an account-owned child from the connection supervisor here.
    if std::env::var_os("KCODER_ACCOUNT_PRINCIPAL_ID").is_some() {
        ensure!(
            std::env::var("KCODER_WIKI_WORKER_MANAGED").as_deref() == Ok("1"),
            "This account launcher must be updated to support persistent Wiki jobs"
        );
        return Ok(());
    }
    let lock = worker_lock(path)?;
    match lock.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    FileExt::unlock(&lock)?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--internal-wiki-worker")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_clear();
    // Credentials are resolved from the target's private profile per operation,
    // not copied from the interactive process environment into a durable child.
    for name in [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "XDG_CONFIG_HOME",
        "KCODER_CONFIG_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // No inherited terminal/session descriptors survive the child boundary.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = command
        .spawn()
        .context("Cannot start private Wiki worker")?;
    // Reap an eventual child exit without binding the worker to a Tokio task.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn worker_lock(path: &Path) -> Result<File> {
    let directory = path.parent().context("Wiki profile unavailable")?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(directory.join(".wiki-worker.lock"))?;
    ensure!(file.metadata()?.is_file(), "Invalid Wiki worker lock");
    Ok(file)
}

pub(crate) fn entry(path: &Path, pause_only: bool) -> Result<()> {
    ensure!(
        path.is_absolute() && path.is_file(),
        "Wiki worker needs an existing absolute profile path"
    );
    let path = path.canonicalize()?;
    if pause_only {
        return pause_existing(&path);
    }
    let lock = worker_lock(&path)?;
    match lock.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?
        .block_on(worker_loop(path))
}

fn pause_existing(path: &Path) -> Result<()> {
    if path
        .parent()
        .is_some_and(|p| p.join("knowledge/state.sqlite").is_file())
    {
        let (mut store, scope) = knowledge_requests::open_catalog(path)?;
        store.pause_all_jobs(&scope)?;
    }
    Ok(())
}

async fn worker_loop(path: PathBuf) -> Result<()> {
    let cancel = CancellationToken::new();
    let signal_cancel = cancel.clone();
    let signal_task = tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            if let (Ok(mut term), Ok(mut interrupt)) = (
                signal(SignalKind::terminate()),
                signal(SignalKind::interrupt()),
            ) {
                tokio::select! { _ = term.recv() => {}, _ = interrupt.recv() => {} }
                signal_cancel.cancel();
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
            signal_cancel.cancel();
        }
    });
    let result = async {
        let mut paused_while_disabled = false;
        loop {
            if cancel.is_cancelled() || !path.is_file() {
                break;
            }
            if !knowledge_requests::organization_enabled(&path).unwrap_or(false) {
                if !paused_while_disabled {
                    pause_existing(&path)?;
                }
                paused_while_disabled = true;
                // Stay idle until the profile is removed or the worker is stopped.
                // Exiting here races with a quick off/on followed by enqueue:
                // the enqueuer can observe our lock just before we exit.
            } else if path
                .parent()
                .is_some_and(|p| p.join("knowledge/state.sqlite").is_file())
            {
                paused_while_disabled = false;
                // Recover expired running leases; paused/review/failed jobs are
                // never silently revived by login, restart or an on/off toggle.
                if scan(&path, &cancel).await.is_err() {
                    tracing::warn!("Wiki worker scan stopped; persisted jobs remain recoverable");
                }
            }
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(500)) => {},
            }
        }
        pause_existing(&path)
    }
    .await;
    signal_task.abort();
    result
}

pub(super) fn model(path: &Path) -> Result<(kcoder_config::Settings, ProviderWikiModel)> {
    let root = path.parent().context("Wiki profile unavailable")?;
    // Use a profile-only directory, never the client's current project hooks,
    // plugins, shell settings or configuration overlays.
    let loader = kcoder_config::SettingsLoader::new(root).with_config_dir(root);
    let mut settings = loader.load()?.settings;
    ensure!(
        settings.knowledge.can_organize(),
        "Wiki organization is disabled"
    );
    let mut cli = crate::Cli::try_parse_from(["kcoder"])?;
    let kind = kcoder_api::ProviderKind::from_settings(&settings)?
        .context("Wiki model is not configured")?;
    let dotenv = root.join(".env");
    if kcoder_api::ProviderFactory::new(&settings)
        .credential_resolution(kind)
        .is_none()
        && dotenv.is_file()
    {
        cli.credential_env_file = Some(dotenv.clone());
        crate::apply_credential_env_file(&mut settings, &dotenv)?;
    }
    let configuration = crate::model_configuration::ModelConfiguration::new(loader, cli);
    let provider = configuration.provider(&settings)?;
    let model = ProviderWikiModel {
        provider,
        model: settings.model.clone(),
        max_output_tokens: settings.max_tokens,
        reasoning: settings.model_reasoning_effort.clone(),
    };
    Ok((settings, model))
}

async fn scan(path: &Path, cancel: &CancellationToken) -> Result<()> {
    let (mut store, scope) = knowledge_requests::open_catalog(path)?;
    let mut after_library = None;
    loop {
        let libraries = store.list(&scope, after_library.as_deref(), 100)?;
        if libraries.is_empty() {
            break;
        }
        for library in &libraries {
            if cancel.is_cancelled() || !knowledge_requests::organization_enabled(path)? {
                return Ok(());
            }
            if library.archived {
                continue;
            }
            let mut after_job = None;
            loop {
                let jobs = store.list_jobs(&scope, &library.id, after_job.as_deref(), 100)?;
                if jobs.is_empty() {
                    break;
                }
                for job in &jobs {
                    if cancel.is_cancelled() || !knowledge_requests::organization_enabled(path)? {
                        return Ok(());
                    }
                    if !matches!(job.status.as_str(), "queued" | "running") {
                        continue;
                    }
                    let frozen = job.recipe_key.starts_with("wiki-v2:")
                        || job.recipe_key.starts_with("wiki-v3:");
                    let prepared = if frozen {
                        super::knowledge_worker_model::load(path, &job.recipe_key, &library.purpose)
                    } else {
                        model(path)
                    };
                    let (settings, model) = match prepared {
                        Ok(model) => model,
                        Err(error) => {
                            if let Some(lease) = store.claim_job(&scope, &library.id, &job.id)? {
                                let detail =
                                    super::knowledge_worker_model::record_failure(path, &error);
                                store.record_job_provider_error(
                                    &scope,
                                    &library.id,
                                    &lease,
                                    &detail,
                                )?;
                                store.stop_job_with_reason(
                                    &scope,
                                    &library.id,
                                    &lease,
                                    "paused",
                                    "provider_error",
                                )?;
                            }
                            continue;
                        }
                    };
                    if !frozen
                        && knowledge_job_runner::recipe_key(&settings, &model, &library.purpose)?
                            != job.recipe_key
                    {
                        if let Some(lease) = store.claim_job(&scope, &library.id, &job.id)? {
                            store.stop_job_with_reason(
                                &scope,
                                &library.id,
                                &lease,
                                "paused",
                                "configuration_changed",
                            )?;
                        }
                        continue;
                    }
                    let _ = knowledge_job_runner::run(
                        path,
                        &library.id,
                        &job.id,
                        &model,
                        settings.context_window_tokens.unwrap_or(32_768),
                        cancel,
                    )
                    .await;
                }
                after_job = jobs.last().map(|job| job.id.clone());
            }
        }
        after_library = libraries.last().map(|library| library.id.clone());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn single_worker_lock_and_pause_do_not_materialize_a_catalog() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{}")?;
        let first = worker_lock(&path)?;
        first.try_lock_exclusive()?;
        assert!(worker_lock(&path)?.try_lock_exclusive().is_err());
        pause_existing(&path)?;
        assert!(!dir.path().join("knowledge").exists());
        Ok(())
    }
}
