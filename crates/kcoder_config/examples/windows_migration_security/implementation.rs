use anyhow::{Context, Result, ensure};
use kcoder_config::{CredentialBackend, OsCredentialBackend, PrivateDirectory};
use kcoder_process_supervisor::suspended_child::{SUSPENDED_CHILD_FLAGS, SuspendedChildJob};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::{BufRead, Read, Write},
    os::windows::{io::AsHandle, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};

#[path = "vault_logon.rs"]
mod vault_logon;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Authority {
    owner: String,
    secret: String,
}
impl Drop for Authority {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    owner: String,
    account: String,
    secret_sha256: String,
    write_attempted: bool,
}
const INTENT: &str = "synthetic-vault-intent.json";

fn owner_valid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(at, byte)| {
            if [8, 13, 18, 23].contains(&at) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}
fn account(owner: &str) -> String {
    format!("__kcoder_migration_e2e_{owner}")
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn baseline() -> &'static str {
    option_env!("KCODER_NATIVE_PROBE_BASELINE").unwrap_or("unknown")
}

fn record_process(directory: &PrivateDirectory, owner: &str) -> Result<()> {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    // SAFETY: the pseudo handle is current and each FILETIME is valid output storage.
    ensure!(
        unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        } != 0,
        "process_identity_unavailable"
    );
    let ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
    let dotnet = ticks
        .checked_add(504_911_232_000_000_000)
        .context("process_identity_overflow")?;
    directory.atomic_replace(OsStr::new("probe-owner.json"), &serde_json::to_vec(&json!({"owner":owner,"pid":std::process::id(),"creationTicks":dotnet.to_string(),"creationKind":"process-start-time"}))?)
}

fn bound_root(root: &Path, owner: &str) -> Result<PrivateDirectory> {
    ensure!(owner_valid(owner), "invalid_owner");
    ensure!(
        root.is_absolute()
            && root.file_name() == Some(OsStr::new(&format!("kcoder-package-{owner}"))),
        "invalid_owned_root"
    );
    let directory = PrivateDirectory::open_existing(root)?;
    directory.verify_trusted_config_directory()?;
    let input = directory.open_single_link_regular_file(OsStr::new(".owner.json"))?;
    let mut bytes = Vec::new();
    input.take(4097).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 4096, "owner_record_budget");
    let record: Value =
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid_owner_record"))?;
    ensure!(record["owner"] == owner, "owner_mismatch");
    Ok(directory)
}

fn error_status(error: &anyhow::Error, stage: &str) -> Value {
    let code = error.chain().find_map(|cause| {
        cause
            .downcast_ref::<keyring::windows::Error>()
            .map(|error| error.0)
    });
    json!({"status":if code==Some(1312)||code==Some(5){"blocked"}else{"failed"},
        "stage":stage,"platformCode":code,"reason":if code==Some(1312){"no_such_logon_session"}else if code==Some(5){"access_denied"}else{"system_backend_error"},
        "backend":"Windows Credential Manager","fileBackendUsed":false})
}

fn load_intent(directory: &PrivateDirectory, owner: &str) -> Result<Option<Intent>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(INTENT)) {
        Ok(file) => file,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 4096, "intent_budget");
    let intent: Intent =
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid_intent"))?;
    ensure!(
        intent.owner == owner
            && intent.account == account(owner)
            && intent.secret_sha256.len() == 64
            && intent
                .secret_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()),
        "intent_binding_mismatch"
    );
    Ok(Some(intent))
}

fn clean_credential(directory: &PrivateDirectory, owner: &str) -> Result<Value> {
    let Some(intent) = load_intent(directory, owner)? else {
        return Ok(
            json!({"safeToRemoveRoot":true,"disposition":"not_written","systemEntryAbsenceVerified":false}),
        );
    };
    if !intent.write_attempted {
        return Ok(
            json!({"safeToRemoveRoot":true,"disposition":"not_written","systemEntryAbsenceVerified":true}),
        );
    }
    let backend = OsCredentialBackend::new();
    let current = match backend.get(&intent.account) {
        Ok(value) => value.map(Zeroizing::new),
        Err(error) => {
            return Ok(
                json!({"safeToRemoveRoot":false,"osVault":error_status(&error,"cleanup_read")}),
            );
        }
    };
    if let Some(value) = current {
        if digest(&value) != intent.secret_sha256 {
            return Ok(json!({"safeToRemoveRoot":false,"disposition":"changed_entry_not_deleted"}));
        }
        if let Err(error) = backend.delete(&intent.account) {
            return Ok(
                json!({"safeToRemoveRoot":false,"osVault":error_status(&error,"cleanup_delete")}),
            );
        }
    }
    match backend.get(&intent.account) {
        Ok(None) => Ok(
            json!({"safeToRemoveRoot":true,"disposition":"deleted_or_absent","systemEntryAbsenceVerified":true}),
        ),
        Ok(Some(value)) => {
            let _ = Zeroizing::new(value);
            Ok(json!({"safeToRemoveRoot":false,"disposition":"entry_still_present"}))
        }
        Err(error) => {
            Ok(json!({"safeToRemoveRoot":false,"osVault":error_status(&error,"cleanup_verify")}))
        }
    }
}

fn credential_roundtrip(directory: &PrivateDirectory, owner: &str, secret: &str) -> Result<Value> {
    ensure!(
        load_intent(directory, owner)?.is_none(),
        "existing_intent_cleanup_only"
    );
    let backend = OsCredentialBackend::new();
    let name = account(owner);
    // available() probes a fixed legacy account; this acceptance only reads its UUID name.
    match backend.get(&name) {
        Ok(None) => {}
        Ok(Some(value)) => {
            let _ = Zeroizing::new(value);
            return Ok(
                json!({"status":"failed","reason":"random_account_collision","writeAttempted":false}),
            );
        }
        Err(error) => return Ok(error_status(&error, "preflight_exact_account")),
    }
    let mut intent = Intent {
        owner: owner.into(),
        account: name.clone(),
        secret_sha256: digest(secret),
        write_attempted: false,
    };
    directory.atomic_replace(OsStr::new(INTENT), &serde_json::to_vec(&intent)?)?;
    intent.write_attempted = true;
    directory.atomic_replace(OsStr::new(INTENT), &serde_json::to_vec(&intent)?)?;
    let attempt = (|| -> Result<Value> {
        if let Err(error) = backend.set(&name, secret) {
            return Ok(error_status(&error, "write"));
        }
        let value = match backend.get(&name) {
            Ok(Some(value)) => Zeroizing::new(value),
            Ok(None) => return Ok(json!({"status":"failed","reason":"missing_after_write"})),
            Err(error) => return Ok(error_status(&error, "readback")),
        };
        ensure!(value.as_str() == secret, "synthetic_credential_mismatch");
        Ok(
            json!({"status":"passed","backend":backend.describe(),"fileBackendUsed":false,
            "exactRandomAccountOnly":true,"readbackMatched":true,"enumeratedAccounts":false}),
        )
    })();
    let cleanup = clean_credential(directory, owner)?;
    let mut result = attempt
        .unwrap_or_else(|_| json!({"status":"failed","reason":"synthetic_roundtrip_failed"}));
    if cleanup["safeToRemoveRoot"] != true {
        result["status"] = json!("failed");
    }
    result["cleanup"] = cleanup;
    Ok(result)
}

fn paths(root: &Path) -> Result<Value> {
    let drive = root.to_string_lossy();
    ensure!(
        drive.as_bytes().get(1) == Some(&b':') && !drive.starts_with(['C', 'c']),
        "non_c_drive_required"
    );
    let safe_path = root.join("资料 空格");
    let safe = PrivateDirectory::open_existing(&safe_path)?;
    safe.verify_trusted_config_directory()?;
    safe.atomic_replace(OsStr::new("报告.txt"), "中文路径成功".as_bytes())?;
    let mut text = String::new();
    safe.open_single_link_regular_file(OsStr::new("报告.txt"))?
        .read_to_string(&mut text)?;
    ensure!(text == "中文路径成功", "unicode_roundtrip_failed");
    ensure!(
        safe.open_child(OsStr::new("linked"), false).is_err(),
        "junction_leaf_accepted"
    );
    ensure!(
        PrivateDirectory::open_existing(&safe_path.join("linked/nested")).is_err(),
        "junction_ancestor_accepted"
    );
    ensure!(
        PrivateDirectory::open_or_create(&safe_path.join("linked/must-not-create")).is_err(),
        "junction_write_accepted"
    );
    ensure!(
        !root.join("peer/must-not-create").exists(),
        "junction_write_escaped"
    );
    // Migration source grants bind directories through this handle API before reading.
    // The generic settings parser alone does not enforce a source-grant boundary.
    ensure!(
        safe.open_single_link_regular_file(OsStr::new("hardlink.txt"))
            .is_err(),
        "hardlink_alias_accepted"
    );
    ensure!(
        std::fs::read(root.join("peer/sentinel.txt"))? == b"owned peer sentinel",
        "peer_changed"
    );
    Ok(
        json!({"status":"passed","nonCDrive":true,"unicodeAndSpaces":true,"junctionLeafRejected":true,
        "junctionAncestorRejected":true,"junctionWriteRejected":true,
        "hardlinkRejected":true,"ownedPeerUnchanged":true}),
    )
}

fn remove_owned_junction(root: &Path) -> Result<()> {
    use std::os::windows::fs::MetadataExt;
    let link = root.join("资料 空格/linked");
    match std::fs::symlink_metadata(&link) {
        Ok(metadata) => {
            ensure!(
                metadata.file_attributes() & 0x400 != 0,
                "fixture_junction_changed"
            );
            std::fs::remove_dir(&link)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn read_authority(input: &mut impl BufRead, owner: &str) -> Result<Authority> {
    let mut bytes = Zeroizing::new(Vec::new());
    input.take(8193).read_until(b'\n', &mut bytes)?;
    ensure!(bytes.len() <= 8192, "input_budget");
    let authority: Authority =
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid_authority"))?;
    ensure!(
        authority.owner == owner && (32..=256).contains(&authority.secret.len()),
        "invalid_authority"
    );
    Ok(authority)
}

pub(super) fn entry() -> Result<()> {
    let args = std::env::args_os().collect::<Vec<_>>();
    ensure!((4..=5).contains(&args.len()), "invalid_arguments");
    let mode = args[1].to_str().context("invalid_mode")?;
    let root = PathBuf::from(&args[2]);
    let owner = args[3].to_str().context("invalid_owner")?;
    let directory = bound_root(&root, owner)?;
    if matches!(
        mode,
        "--vault-root" | "--vault-write" | "--vault-reopen" | "--vault-cleanup"
    ) {
        let expected = args.get(4).and_then(|value| value.to_str());
        println!(
            "{}",
            vault_logon::execute(&directory, &root, owner, mode, expected)?
        );
        return Ok(());
    }
    ensure!(args.len() == 4, "invalid_arguments");
    if mode == "--cleanup" {
        let mut result = clean_credential(&directory, owner)?;
        if result["safeToRemoveRoot"] == true {
            remove_owned_junction(&root)?;
            result["ownedJunctionRemoved"] = json!(true);
        }
        println!("{}", result);
        return Ok(());
    }
    let mut input = std::io::BufReader::new(std::io::stdin());
    let mut authority = read_authority(&mut input, owner)?;
    if mode == "--worker" {
        let secret = Zeroizing::new(std::mem::take(&mut authority.secret));
        let path_result = paths(&root)
            .unwrap_or_else(|error| json!({"status":"failed","reason":error.to_string().chars().take(160).collect::<String>()}));
        let credential = credential_roundtrip(&directory, owner, &secret)?;
        println!(
            "{}",
            json!({"baselineSource":baseline(),"paths":path_result,"osVault":credential})
        );
        return Ok(());
    }
    ensure!(mode == "--host", "invalid_mode");
    record_process(&directory, owner)?;
    let mut job = SuspendedChildJob::new()?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([OsStr::new("--worker"), root.as_os_str(), OsStr::new(owner)])
        .creation_flags(SUSPENDED_CHILD_FLAGS)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear();
    for name in ["SystemRoot", "WINDIR", "PATH"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    for name in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "KCODER_CONFIG_DIR",
    ] {
        command.env(name, root.join("isolated-profile"));
    }
    command
        .env("TEMP", root.join("temp"))
        .env("TMP", root.join("temp"));
    let mut child = command.spawn()?;
    if let Err(error) = job.assign_and_resume(child.as_handle()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.context("owned_job_assignment_failed"));
    }
    let mut payload = Zeroizing::new(serde_json::to_vec(&authority)?);
    payload.push(b'\n');
    let mut pipe = child.stdin.take().context("worker_input_missing")?;
    pipe.write_all(&payload)?;
    drop(pipe);
    drop(payload);
    drop(authority);
    let output = child.stdout.take().context("worker_output_missing")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output.take(65537).read_to_end(&mut bytes).map(|_| bytes)
    });
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut byte = String::new();
        let _ = input.read_line(&mut byte);
        let _ = send.send(());
    });
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        if let Some(status) = child.try_wait()? {
            ensure!(status.success(), "worker_failed");
            break;
        }
        if receive.try_recv().is_ok() || Instant::now() > deadline {
            let _ = job.terminate();
            let _ = child.wait();
            let _ = clean_credential(&directory, owner);
            anyhow::bail!("owner_disconnected_or_deadline");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let bytes = reader
        .join()
        .map_err(|_| anyhow::anyhow!("worker_reader_failed"))??;
    ensure!(bytes.len() <= 65536, "worker_output_budget");
    let result: Value =
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("worker_invalid_result"))?;
    // Process signaling and Job accounting need not become observable atomically.
    let observer = job.exit_handle();
    let cleanup_deadline = Instant::now() + Duration::from_secs(2);
    while !observer.is_empty()? {
        ensure!(
            Instant::now() < cleanup_deadline,
            "owned_worker_still_running"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    println!("{}", result);
    Ok(())
}
