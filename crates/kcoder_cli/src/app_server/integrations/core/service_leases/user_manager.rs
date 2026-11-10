//! A fixed OS-managed native process owns workers independently of UI process trees.
use super::native_code::diagnostics::{self, Stage};
use super::*;
use anyhow::{Context, ensure};
#[cfg(target_os = "linux")]
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    process::Child,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

pub(crate) const MANAGER_ENTRY: &str = "--internal-native-user-service-manager-v1";
const LEGACY_CODE_MANAGER_ENTRY: &str = "--internal-native-code-service-manager-v1";
#[cfg(target_os = "linux")]
static STOP: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "linux")]
extern "C" fn stop_signal(_: i32) {
    STOP.store(true, Ordering::Release);
}

pub(crate) fn try_run(arguments: &[std::ffi::OsString]) -> Option<Result<()>> {
    if arguments
        .get(1)
        .is_none_or(|argument| argument != MANAGER_ENTRY && argument != LEGACY_CODE_MANAGER_ENTRY)
    {
        return None;
    }
    Some(run(arguments))
}
#[cfg(not(target_os = "linux"))]
fn run(_arguments: &[std::ffi::OsString]) -> Result<()> {
    anyhow::bail!("SERVICE_NATIVE_PLATFORM_UNSUPPORTED")
}

#[cfg(target_os = "linux")]
use kcoder_native_service_runtime::manager_scope::address;
#[cfg(target_os = "linux")]
fn native(profile: &Path, workspace: &Path) -> Result<NativeIntegrationContext> {
    NativeIntegrationContext::capture_existing(
        profile,
        workspace,
        "native-code-manager-read",
        "native-code-manager-read-only",
    )
}
#[cfg(target_os = "linux")]
struct Managed {
    child: Child,
    ready: Option<serde_json::Value>,
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
pub(super) struct OriginalOwnerBusy;
#[cfg(target_os = "linux")]
impl std::fmt::Display for OriginalOwnerBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("NATIVE_CODE_ORIGINAL_OWNER_BUSY")
    }
}
#[cfg(target_os = "linux")]
impl std::error::Error for OriginalOwnerBusy {}

#[cfg(target_os = "linux")]
fn restore_original(
    profile: &Path,
    workspace: &Path,
    id: &str,
    workers: &mut BTreeMap<String, Managed>,
) -> bool {
    let result = start_one(profile, workspace, id, Duration::from_secs(30), workers);
    // Retry only a pre-spawn existing kernel lock. Once any actual child was
    // spawned, its unknown readiness belongs to that child and cannot replay.
    !workers.contains_key(id)
        && result
            .as_ref()
            .is_err_and(|error| error.downcast_ref::<OriginalOwnerBusy>().is_some())
}

#[cfg(target_os = "linux")]
fn run(arguments: &[std::ffi::OsString]) -> Result<()> {
    ensure!(arguments.len() == 4, "NATIVE_CODE_MANAGER_ENTRY_INVALID");
    let profile = PathBuf::from(&arguments[2]);
    let workspace = PathBuf::from(&arguments[3]);
    ensure!(
        profile.is_absolute() && workspace.is_absolute(),
        "NATIVE_CODE_MANAGER_ENTRY_INVALID"
    );
    kcoder_native_scope::service_identity::verify_current_unix_account()?;
    kcoder_config::PrivateDirectory::open_existing(&profile)?.verify_private_directory()?;
    // SAFETY: this dedicated synchronous OS-service entry has not created threads.
    unsafe {
        std::env::set_var("KCODER_CONFIG_DIR", &profile);
        std::env::remove_var("KCODER_HISTORY_DIR");
    }
    ensure!(
        unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } == 0,
        "SERVICE_ACCOUNT_RESTRICTION_UNAVAILABLE"
    );
    let image =
        super::image::NativeServiceImage::capture(&tokio_util::sync::CancellationToken::new())?;
    let listener = UnixListener::bind_addr(&address(&profile, &workspace)?)?;
    listener.set_nonblocking(true)?;
    // This public observation carries no lease or authority. Service managers
    // can wait for the actual private listener instead of retrying a mutation.
    let _ = writeln!(
        std::io::stdout().lock(),
        "{{\"event\":\"native_code_service_manager_ready\"}}"
    );
    // SAFETY: the handlers perform only one lock-free atomic flag store.
    unsafe {
        libc::signal(
            libc::SIGTERM,
            stop_signal as *const () as libc::sighandler_t,
        );
        libc::signal(libc::SIGINT, stop_signal as *const () as libc::sighandler_t);
    }
    let mut workers = BTreeMap::<String, Managed>::new();
    let mut pending_restore = BTreeSet::new();
    for id in enabled_originals(&profile, &workspace).unwrap_or_default() {
        if restore_original(&profile, &workspace, &id, &mut workers) {
            pending_restore.insert(id);
        }
    }
    let mut next_restore = Instant::now();
    while !STOP.load(Ordering::Acquire) {
        workers.retain(|_, worker| !worker.child.try_wait().is_ok_and(|status| status.is_some()));
        if Instant::now() >= next_restore {
            pending_restore.retain(|id| restore_original(&profile, &workspace, id, &mut workers));
            next_restore = Instant::now() + Duration::from_secs(2);
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let response = (|| -> Result<serde_json::Value> {
                    diagnostics::mark(Stage::ManagerPeer, peer(&stream, image.sha256()))?;
                    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
                    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
                    let mut bytes = Vec::new();
                    let mut buffer = [0u8; 1];
                    while bytes.len() <= 2048 {
                        ensure!(
                            stream.read(&mut buffer)? == 1,
                            "NATIVE_CODE_MANAGER_REQUEST_INVALID"
                        );
                        if buffer[0] == b'\n' {
                            break;
                        }
                        bytes.push(buffer[0]);
                    }
                    ensure!(bytes.len() <= 2048, "NATIVE_CODE_MANAGER_REQUEST_INVALID");
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct Start {
                        lease_id: String,
                        budget_ms: u64,
                        #[serde(default = "default_action")]
                        action: String,
                    }
                    fn default_action() -> String {
                        "start".into()
                    }
                    let request: Start = serde_json::from_slice(&bytes)?;
                    ensure!(
                        !request.lease_id.is_empty()
                            && request.lease_id.len() <= 256
                            && (1..=60000).contains(&request.budget_ms),
                        "NATIVE_CODE_MANAGER_REQUEST_INVALID"
                    );
                    ensure!(
                        matches!(request.action.as_str(), "start" | "read" | "stop"),
                        "SERVICE_MANAGER_ACTION_INVALID"
                    );
                    if request.action != "start" {
                        return observe_or_stop(
                            &profile,
                            &workspace,
                            &request.lease_id,
                            &request.action,
                            Duration::from_millis(request.budget_ms),
                            &mut workers,
                        );
                    }
                    let started = start_one(
                        &profile,
                        &workspace,
                        &request.lease_id,
                        Duration::from_millis(request.budget_ms),
                        &mut workers,
                    );
                    diagnostics::mark(Stage::ManagerStart, started)
                })();
                let value = match response {
                    Ok(value) => serde_json::json!({"ready":value}),
                    Err(error) => {
                        let error =
                            diagnostics::mark::<()>(Stage::ManagerStart, Err(error)).unwrap_err();
                        serde_json::json!({"error":diagnostics::describe(&error)})
                    }
                };
                if let Ok(mut bytes) = serde_json::to_vec(&value) {
                    bytes.push(b'\n');
                    let _ = stream.write_all(&bytes);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(error) => return Err(error.into()),
        }
    }
    // Only these still-unreaped actual children belong to this manager. No PID
    // history, process-name matching or peer profile participates in cleanup.
    for worker in workers.values_mut() {
        if worker.child.stdin.take().is_none() {
            unsafe {
                libc::kill(worker.child.id() as i32, libc::SIGTERM);
            }
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    for (_, mut worker) in workers {
        loop {
            if worker.child.try_wait()?.is_some() {
                break;
            }
            if Instant::now() >= deadline {
                worker.child.kill()?;
                worker.child.wait()?;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn start_one(
    profile: &Path,
    workspace: &Path,
    id: &str,
    budget: Duration,
    workers: &mut BTreeMap<String, Managed>,
) -> Result<serde_json::Value> {
    if let Some(worker) = workers.get_mut(id)
        && worker.child.try_wait()?.is_none()
    {
        return worker
            .ready
            .clone()
            .context("NATIVE_CODE_ORIGINAL_READY_UNCONFIRMED");
    }
    workers.remove(id);
    ensure!(workers.len() < 64, "SERVICE_LEASE_CAPACITY");
    let context = native(profile, workspace)?;
    let storage =
        NativeServiceLeases::load(&context)?.context("SERVICE_ORIGINAL_STORE_REQUIRED")?;
    let store = storage.store(&context)?;
    ensure!(
        store.read_native_code(id)?.is_some(),
        "SERVICE_ORIGINAL_CODE_PURPOSE_REQUIRED"
    );
    let (mut child, ready) =
        super::native_code::manager::spawn_original(profile, workspace, id, budget)?;
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            // Drain owned diagnostics with bounded buffering; channel service events are retired.
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        });
    }
    let value = ready.as_ref().ok().cloned();
    workers.insert(
        id.into(),
        Managed {
            child,
            ready: value,
        },
    );
    ready
}

#[cfg(target_os = "linux")]
fn observe_or_stop(
    profile: &Path,
    workspace: &Path,
    id: &str,
    action: &str,
    budget: Duration,
    workers: &mut BTreeMap<String, Managed>,
) -> Result<serde_json::Value> {
    let native = native(profile, workspace)?;
    let storage = NativeServiceLeases::load(&native)?.context("SERVICE_ORIGINAL_STORE_REQUIRED")?;
    storage.verify(&native)?;
    let Some(worker) = workers.get_mut(id) else {
        return Ok(serde_json::json!({"leaseId":id,"currentOsState":"unknown"}));
    };
    if action == "stop" && worker.child.try_wait()?.is_none() {
        if worker.child.stdin.take().is_none() {
            unsafe {
                libc::kill(worker.child.id() as i32, libc::SIGTERM);
            }
        }
        let until = Instant::now() + budget;
        while worker.child.try_wait()?.is_none() {
            ensure!(Instant::now() < until, "SERVICE_OWNER_STOP_UNCONFIRMED");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    let ended = worker.child.try_wait()?.is_some();
    Ok(
        serde_json::json!({"leaseId":id,"currentOsState":if ended {"stopped"} else if worker.ready.is_some() {"running"} else {"unknown"}}),
    )
}

#[cfg(target_os = "linux")]
fn peer(stream: &UnixStream, expected_sha: &str) -> Result<()> {
    super::user_peer::NativeUserServicePeer::capture(stream, expected_sha)?.verify()
}

#[cfg(target_os = "linux")]
pub(super) fn request_start(
    profile: &Path,
    workspace: &Path,
    id: &str,
    budget: Duration,
) -> Result<serde_json::Value> {
    request_control(profile, workspace, id, "start", budget)
}
#[cfg(target_os = "linux")]
pub(super) fn request_control(
    profile: &Path,
    workspace: &Path,
    id: &str,
    action: &str,
    budget: Duration,
) -> Result<serde_json::Value> {
    let mut stream = UnixStream::connect_addr(&address(profile, workspace)?)
        .context("NATIVE_CODE_SERVICE_MANAGER_UNAVAILABLE")?;
    let image =
        super::image::NativeServiceImage::capture(&tokio_util::sync::CancellationToken::new())?;
    peer(&stream, image.sha256())?;
    stream.set_read_timeout(Some(budget))?;
    stream.set_write_timeout(Some(budget))?;
    let mut bytes = serde_json::to_vec(
        &serde_json::json!({"leaseId":id,"action":action,"budgetMs":budget.as_millis().min(60000)}),
    )?;
    bytes.push(b'\n');
    stream.write_all(&bytes)?;
    let mut data = Vec::new();
    let mut buffer = [0u8; 1];
    while data.len() <= 16384 {
        ensure!(
            stream.read(&mut buffer)? == 1,
            "NATIVE_CODE_SERVICE_START_UNCONFIRMED"
        );
        if buffer[0] == b'\n' {
            break;
        }
        data.push(buffer[0]);
    }
    ensure!(data.len() <= 16384, "NATIVE_CODE_READY_RECEIPT_INVALID");
    let response: serde_json::Value = serde_json::from_slice(&data)?;
    if let Some(failure) = response.get("error") {
        return Err(diagnostics::Failure::from_private(failure.clone())?.into());
    }
    response
        .get("ready")
        .cloned()
        .context("NATIVE_CODE_SERVICE_START_UNCONFIRMED")
}
#[cfg(not(target_os = "linux"))]
pub(super) fn request_control(
    _profile: &std::path::Path,
    _workspace: &std::path::Path,
    _id: &str,
    _action: &str,
    _budget: std::time::Duration,
) -> Result<serde_json::Value> {
    anyhow::bail!("SERVICE_NATIVE_PLATFORM_UNSUPPORTED")
}
#[cfg(not(target_os = "linux"))]
pub(super) fn request_start(
    _profile: &std::path::Path,
    _workspace: &std::path::Path,
    _id: &str,
    _budget: std::time::Duration,
) -> Result<serde_json::Value> {
    anyhow::bail!("SERVICE_NATIVE_PLATFORM_UNSUPPORTED")
}

#[cfg(target_os = "linux")]
fn enabled_originals(profile: &Path, workspace: &Path) -> Result<Vec<String>> {
    let context = native(profile, workspace)?;
    let Some(storage) = NativeServiceLeases::load(&context)? else {
        return Ok(Vec::new());
    };
    let store = storage.store(&context)?;
    let ids = store
        .list_native_code()?
        .into_iter()
        .filter(|record| record.enabled && record.state != NativeCodeServiceState::Revoked)
        .map(|record| record.intent.lease_id)
        .collect::<Vec<_>>();
    ensure!(ids.len() <= 64, "SERVICE_LEASE_CAPACITY");
    Ok(ids)
}

#[cfg(target_os = "linux")]
pub(super) fn capture_current_manager(
    profile: &Path,
    workspace: &Path,
    image: &str,
) -> Result<super::user_peer::NativeUserServicePeer> {
    let stream = UnixStream::connect_addr(&address(profile, workspace)?)
        .context("CHANNEL_HOST_ORIGINAL_MANAGER_REQUIRED")?;
    super::user_peer::NativeUserServicePeer::capture(&stream, image)
}
