//! Test-only resource assembly; native parent authentication is tested by actual stdio consumers.
use super::*;

pub(in super::super) fn controlled_workspace_root() -> std::path::PathBuf {
    // Only this cfg(test) fixture consumes the explicit owned source copy.
    // Normal installed resource resolution has no environment override.
    std::env::var_os("KCODER_CONNECTIVITY_TEST_WORKSPACE_ROOT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(env!("KCODER_WORKSPACE_ROOT")))
}

pub(in super::super) async fn controlled_resource_stage(
    context: &NativeIntegrationContext,
    output: &Path,
) -> Result<Arc<NativeConnectivityResourceLease>> {
    Ok(controlled_installed_stage(context, output).await?.verifier)
}

pub(in super::super) async fn controlled_installed_stage(
    context: &NativeIntegrationContext,
    output: &Path,
) -> Result<NativeConnectivityInstalledPaths> {
    controlled_startup_binding(context, output)
        .await?
        .resolve(context, &CancellationToken::new())
        .await
}

pub(in super::super) async fn controlled_startup_binding(
    context: &NativeIntegrationContext,
    output: &Path,
) -> Result<Arc<NativeConnectivityStartupBinding>> {
    let node = which::which("node")?.canonicalize()?;
    let mut command = tokio::process::Command::new(&node);
    command
        .arg(
            controlled_workspace_root()
                .join("apps/kcoder-channel-host/scripts/stage-native-resources.mjs"),
        )
        .arg(output)
        .arg(&node)
        .kill_on_drop(true);
    let staged =
        tokio::time::timeout(std::time::Duration::from_secs(30), command.output()).await??;
    ensure!(staged.status.success(), "CONTROLLED_RESOURCE_STAGE_FAILED");
    let value: Startup = serde_json::from_slice(&staged.stdout)?;
    let binding = NativeConnectivityStartupBinding {
        value,
        profile_identity: context.profile()?.directory_identity()?,
        workspace_identity: context.workspace_directory_identity()?,
        resolved: Default::default(),
    };
    Ok(Arc::new(binding))
}
