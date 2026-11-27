//! Shared lease fixtures for this crate's tests and for `test-oracle` consumers.
//! They create only temporary private directories and short-lived child processes.
use super::*;
use std::{ffi::OsStr, process::Stdio};

pub fn fixture() -> Result<(tempfile::TempDir, NativeIntegrationContext)> {
    let temp = tempfile::tempdir()?;
    let parent = PrivateDirectory::open_or_create(temp.path())?;
    parent.create_private_child(OsStr::new("profile"))?;
    parent.create_private_child(OsStr::new("workspace"))?;
    let context = NativeIntegrationContext::capture(
        &temp.path().join("profile"),
        &temp.path().join("workspace"),
        "connection-1",
        "configuration-1",
    )?;
    Ok((temp, context))
}

pub async fn owned_parent(
    context: &NativeIntegrationContext,
) -> Result<(tokio::process::Child, Arc<NativeConnectivityParent>)> {
    owned_parent_for(context, 30).await
}
pub async fn owned_parent_for(
    context: &NativeIntegrationContext,
    seconds: u64,
) -> Result<(tokio::process::Child, Arc<NativeConnectivityParent>)> {
    ensure!(
        (1..=180).contains(&seconds),
        "CONTROLLED_PARENT_LIFETIME_INVALID"
    );
    #[cfg(unix)]
    let mut command = {
        let mut command = tokio::process::Command::new("/bin/sleep");
        command.arg(seconds.to_string());
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = tokio::process::Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("Start-Sleep -Seconds {seconds}"),
        ]);
        command
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let parent = Arc::new(NativeConnectivityParent::capture(
        context,
        &mut child,
        super::super::parent::NativeConnectivityExitProof::OwnedNoDescendantsFixture,
    )?);
    Ok((child, parent))
}

/// Run the original Node store bootstrap against this facade's held lease
/// files. Callers resolve the `node` program and the module URL themselves.
pub fn initialize_node_files_with(
    factory: &NativeConnectivityLeaseFacade,
    context: &NativeIntegrationContext,
    node: &Path,
    store_bootstrap_url: &str,
) -> Result<String> {
    let script = "const{createStoreFiles}=await import(process.argv[1]);const{readFileSync}=await import('node:fs');const{resolve}=await import('node:path');const{createHash}=await import('node:crypto');createStoreFiles(process.argv[2],{namespaceId:process.argv[3],initializationId:process.argv[4],nativeWindowsProof:path=>resolve(path)===resolve(process.argv[2]),assertExclusiveLease:()=>true});const value=JSON.parse(readFileSync(process.argv[2]+'.binding.json','utf8'));function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}console.log(createHash('sha256').update(JSON.stringify(sort(value))).digest('hex'));";
    let (data_path, namespace_id, initialization_id) =
        factory.store_bootstrap_arguments(context)?;
    #[cfg(windows)]
    let (lease_id, parent) = {
        let leases = factory
            .leases
            .lock()
            .map_err(coded("CONNECTIVITY_LEASE_STATE_UNAVAILABLE"))?;
        ensure!(
            leases.len() == 1,
            "owned fixture requires one original lease"
        );
        let (id, lease) = leases.iter().next().unwrap();
        ensure!(
            lease.create,
            "owned fixture requires original initialization"
        );
        (id.clone(), lease.parent.clone())
    };
    #[cfg(windows)]
    factory.verify_private_path(context, Some(&parent), &lease_id, &data_path)?;
    let output = std::process::Command::new(node)
        .args(["--input-type=module", "-e", script, store_bootstrap_url])
        .arg(&data_path)
        .arg(namespace_id)
        .arg(initialization_id)
        .output()?;
    ensure!(
        output.status.success(),
        "owned Node DDL fixture failed (no platform credentials used): {}",
        String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(4096)
            .collect::<String>()
    );
    #[cfg(windows)]
    for path in [
        data_path.with_extension("binding.json"),
        data_path.join("connectivity.sqlite3"),
        data_path.join("connectivity.lock"),
        data_path.join("connectivity.ready.json"),
    ] {
        // The real Native owner records each created file before Ready; the
        // creation-only child received a proof for this held empty root only.
        factory.verify_private_path(context, Some(&parent), &lease_id, &path)?;
    }
    Ok(String::from_utf8(output.stdout)?.trim().into())
}
