use super::super::{NativeIntegrationContext, NativeServiceLeases, process::NativeServiceProcess};
use super::launch::OriginalScopeHostLaunch;
use anyhow::{Context, Result, ensure};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

pub struct NativeScopeHostBootstrap {
    native: NativeIntegrationContext,
    storage: NativeServiceLeases,
    launch: OriginalScopeHostLaunch,
    reference: String,
    process: NativeServiceProcess,
    #[cfg(windows)]
    gateway_fence: Option<kcoder_config::VerifiedPrivateLease>,
    stopped: CancellationToken,
    original_main: Mutex<OriginalMain>,
}
#[derive(Default)]
struct OriginalMain {
    started: bool,
    parent: Option<std::sync::Weak<crate::connectivity::NativeConnectivityParent>>,
    exited: Option<crate::connectivity::main_exit::NativeConnectivityMainExitReceipt>,
}
impl std::fmt::Debug for NativeScopeHostBootstrap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeScopeHostBootstrap { original_scope_kernel_owner: held }")
    }
}
impl NativeScopeHostBootstrap {
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub fn open_gateway(mut native: NativeIntegrationContext) -> Result<Arc<Self>> {
        native.pin_lifecycle_revision()?;
        let storage = NativeServiceLeases::initialize(&native, "gateway-app-server")?;
        let image = super::super::image::NativeServiceImage::capture(&CancellationToken::new())?;
        let launch = OriginalScopeHostLaunch::gateway(&native, image.sha256().to_owned())?;
        let reference = "gateway-stdio";
        let fence = launch
            .claim(&native, &storage, reference)?
            .context("APP_SERVER_HOST_ORIGINAL_OWNER_BUSY")?;
        #[cfg(unix)]
        let descriptor = fence.into_inherited_lock();
        #[cfg(windows)]
        let descriptor = fence.file().try_clone()?;
        let process = NativeServiceProcess::capture_scope_host(
            &native, &storage, reference, &launch, descriptor,
        )?;
        let value = Arc::new(Self {
            native,
            storage,
            launch,
            reference: reference.into(),
            process,
            stopped: CancellationToken::new(),
            original_main: Mutex::new(OriginalMain::default()),
            #[cfg(windows)]
            gateway_fence: Some(fence),
        });
        value.verify()?;
        Ok(value)
    }

    pub fn verify(&self) -> Result<()> {
        ensure!(!self.stopped.is_cancelled(), "CHANNEL_HOST_OWNER_ENDED");
        #[cfg(windows)]
        if let Some(fence) = &self.gateway_fence {
            self.launch.verify_descriptor(
                &self.native,
                &self.storage,
                &self.reference,
                fence.file(),
            )?;
        }
        self.process.verify_scope_host_descriptor(
            &self.native,
            &self.storage,
            &self.reference,
            &self.launch,
        )
    }
    pub fn native(&self) -> &NativeIntegrationContext {
        &self.native
    }
    pub fn launch(&self) -> &OriginalScopeHostLaunch {
        &self.launch
    }
    /// Only a running Gateway-owned app-server may reuse its captured transport.
    pub fn gateway_transport_open(&self) -> Result<bool> {
        if !self.launch.gateway_owned() {
            return Ok(false);
        }
        ensure!(!self.stopped.is_cancelled(), "CHANNEL_HOST_OWNER_ENDED");
        Ok(true)
    }
    #[cfg(windows)]
    pub fn cancellation(&self) -> CancellationToken {
        self.stopped.clone()
    }
    pub fn request_stop(&self) {
        self.stopped.cancel();
    }
    /// The Core's own descriptor stays CLOEXEC. Only the fixed original Native
    /// Main/SDK spawn receives a duplicate; tools and other children do not.
    #[cfg(unix)]
    pub fn inherit_scope_fence(&self, command: &mut tokio::process::Command) -> Result<()> {
        use std::os::fd::AsRawFd;
        self.verify()?;
        let fence = self.process.duplicate_scope_host_fence()?;
        // The duplicate is deliberately held by both the original subreaper
        // and actual verified Node. Either surviving owner fences a new Core.
        unsafe {
            command.pre_exec(move || {
                let inherited = libc::fcntl(fence.as_raw_fd(), libc::F_DUPFD, 64);
                if inherited < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Ok(())
    }
    #[cfg(windows)]
    pub fn inherit_scope_fence(&self, _command: &mut tokio::process::Command) -> Result<()> {
        // The original Core is already inside the manager's private named Job;
        // its children inherit membership, while the Job handle stays private.
        self.verify()
    }
    #[cfg(windows)]
    pub fn verify_scope_child_job(
        &self,
        process: std::os::windows::io::BorrowedHandle<'_>,
    ) -> Result<()> {
        if self.launch.gateway_owned() {
            // spawn_owned has already verified and assigned the child to its
            // own private Job before resuming it.
            return self.verify();
        }
        self.process.verify_scope_child_job(process)
    }
    pub fn begin_original_main_spawn(&self) -> Result<()> {
        self.verify()?;
        let mut original = self
            .original_main
            .lock()
            .map_err(|_| anyhow::anyhow!("CHANNEL_SCOPE_ORIGINAL_MAIN_UNAVAILABLE"))?;
        if original.started {
            if self.launch.persistent_task_host() {
                let parent = original
                    .parent
                    .as_ref()
                    .context("APP_SERVER_ADAPTER_PREDECESSOR_NOT_QUIESCED")?;
                original
                    .exited
                    .as_ref()
                    .context("APP_SERVER_ADAPTER_PREDECESSOR_NOT_QUIESCED")?
                    .verify(parent)?;
            } else {
                self.request_stop();
                anyhow::bail!("CHANNEL_SCOPE_REPLACEMENT_MAIN_REQUIRES_FRESH_CORE");
            }
        }
        original.started = true;
        original.parent = None;
        original.exited = None;
        Ok(())
    }
    pub fn register_original_main(
        &self,
        main: &Arc<crate::connectivity::NativeConnectivityParent>,
    ) -> Result<()> {
        self.verify()?;
        main.verify_scope_owner_process(self.native())?;
        let mut original = self
            .original_main
            .lock()
            .map_err(|_| anyhow::anyhow!("CHANNEL_SCOPE_ORIGINAL_MAIN_UNAVAILABLE"))?;
        ensure!(
            original.started && original.parent.is_none() && original.exited.is_none(),
            "CHANNEL_SCOPE_ORIGINAL_MAIN_ALREADY_BOUND"
        );
        original.parent = Some(Arc::downgrade(main));
        Ok(())
    }
    pub fn retire_original_main(
        &self,
        main: &Arc<crate::connectivity::NativeConnectivityParent>,
        receipt: crate::connectivity::main_exit::NativeConnectivityMainExitReceipt,
    ) -> Result<()> {
        self.verify()?;
        let mut original = self
            .original_main
            .lock()
            .map_err(|_| anyhow::anyhow!("CHANNEL_SCOPE_ORIGINAL_MAIN_UNAVAILABLE"))?;
        let parent = original
            .parent
            .as_ref()
            .context("CHANNEL_SCOPE_ORIGINAL_MAIN_REQUIRED")?;
        ensure!(
            parent.ptr_eq(&Arc::downgrade(main)),
            "CHANNEL_SCOPE_ORIGINAL_MAIN_CHANGED"
        );
        receipt.verify(parent)?;
        original.exited = Some(receipt);
        Ok(())
    }
    pub fn verify_original_main(
        &self,
        main: &Arc<crate::connectivity::NativeConnectivityParent>,
    ) -> Result<()> {
        self.verify()?;
        let original = self
            .original_main
            .lock()
            .map_err(|_| anyhow::anyhow!("CHANNEL_SCOPE_ORIGINAL_MAIN_UNAVAILABLE"))?
            .parent
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
            .context("CHANNEL_SCOPE_ORIGINAL_MAIN_REQUIRED")?;
        ensure!(
            Arc::ptr_eq(&original, main),
            "CHANNEL_SCOPE_ORIGINAL_MAIN_CHANGED"
        );
        main.verify_scope_owner_process(self.native())
    }
    pub fn verify_original_main_lifetime(&self) -> Result<()> {
        self.verify()?;
        // A platform adapter is not the lifetime owner of the persistent task
        // dispatcher. Its own identity and execution gates still fail closed.
        if self.launch.persistent_task_host() {
            return Ok(());
        }
        if let Some(original) = self
            .original_main
            .lock()
            .map_err(|_| anyhow::anyhow!("CHANNEL_SCOPE_ORIGINAL_MAIN_UNAVAILABLE"))?
            .parent
            .as_ref()
        {
            let main = original
                .upgrade()
                .context("CHANNEL_SCOPE_ORIGINAL_MAIN_ENDED")?;
            ensure!(
                main.scope_original_tree_alive()?,
                "CHANNEL_SCOPE_ORIGINAL_MAIN_ENDED"
            );
        }
        Ok(())
    }
    pub fn connectivity_launch(&self) -> Result<Option<std::ffi::OsString>> {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
        self.verify()?;
        let Some(resource) = &self.launch.resources else {
            return Ok(None);
        };
        resource.validate_runtime()?;
        Ok(Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({"schemaVersion":1,
            "componentRoot":resource.component_root,"manifestSha256":resource.component_manifest_sha256,
            "nodeProgram":resource.node_program,"nodeSha256":resource.node_image_sha256,
            "nodeMode":resource.runtime_mode,"nodeVersion":resource.node_version,"electronVersion":resource.electron_version}))?).into()))
    }
}
// Match the existing configuration catalog rule: object order is not semantics.
// Keep every field and preserve all array order, including explicit tool choices.
fn canonical_configuration(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(fields) => serde_json::Value::Object(
            fields
                .into_iter()
                .map(|(name, value)| (name, canonical_configuration(value)))
                .collect::<std::collections::BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(canonical_configuration).collect())
        }
        other => other,
    }
}

pub fn configuration_sha(
    settings: &kcoder_config::Settings,
    resources: &kcoder_types::integrations::core::NativeScopeHostResources,
) -> Result<String> {
    use sha2::{Digest, Sha256};
    ensure!(
        settings.integrations.connectivity.enabled,
        "CHANNEL_HOST_CONNECTIVITY_DISABLED"
    );
    resources.validate_runtime()?;
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical_configuration(
            serde_json::to_value((
                "native-channel-host-configuration-v2",
                &settings.integrations.connectivity,
                settings.integrations.services.enabled,
                &settings.credential_store,
                &resources.component_manifest_sha256,
                &resources.node_image_sha256,
                &resources.runtime_mode,
                &resources.node_version,
                &resources.electron_version
            ))?
        ))?)
    ))
}
pub fn configuration_sha_with_office(
    settings: &kcoder_config::Settings,
    resources: &kcoder_types::integrations::core::NativeScopeHostResources,
    office: Option<&kcoder_types::integrations::core::NativeOfficeScopeLaunch>,
) -> Result<String> {
    let original = configuration_sha(settings, resources)?;
    let Some(office) = office else {
        return Ok(original);
    };
    office.validate()?;
    use sha2::{Digest, Sha256};
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            "native-channel-host-office-configuration-v1",
            original,
            office.schema_version,
            &office.configuration_sha256,
        ))?)
    ))
}

impl kcoder_host_transport::native_component_parent::NativeComponentParentAuthority
    for NativeScopeHostBootstrap
{
    #[cfg(windows)]
    fn verified_windows_parent_process(&self) -> Result<std::os::windows::io::BorrowedHandle<'_>> {
        self.verify()?;
        self.process.windows_parent()
    }
    fn administrative_workspace_binding(
        &self,
    ) -> Result<(&str, kcoder_app_protocol::RetentionPrincipalV1)> {
        // The infrastructure owner does not impersonate a retained administrative
        // session. Office startup is bound separately from its original producer.
        anyhow::bail!("CHANNEL_HOST_ADMINISTRATIVE_BRIDGE_UNAVAILABLE")
    }
    fn verify_native_component_roots(
        &self,
        profile: &kcoder_config::PrivateDirectory,
        workspace: &kcoder_config::PrivateDirectory,
    ) -> Result<()> {
        self.verify()?;
        ensure!(
            profile.directory_identity()? == self.native.profile()?.directory_identity()?
                && workspace.directory_identity()? == self.native.workspace_directory_identity()?,
            "CHANNEL_HOST_COMPONENT_ROOTS_CHANGED"
        );
        Ok(())
    }
}

#[cfg(test)]
mod fingerprint_tests {
    use super::*;
    use crate::configuration;
    use kcoder_types::integrations::core::NativeScopeHostResources;

    fn resources() -> NativeScopeHostResources {
        NativeScopeHostResources {
            component_root: std::env::temp_dir(),
            component_manifest_sha256: "a".repeat(64),
            node_program: std::env::current_exe().unwrap(),
            node_image_sha256: "b".repeat(64),
            runtime_mode: "standalone_node".into(),
            node_version: Some("22.0.0".into()),
            electron_version: None,
        }
    }

    #[test]
    fn original_host_fingerprint_survives_map_order_and_process_reload() {
        const CHILD: &str = "KCODER_HOST_FINGERPRINT_UNIT_CHILD";
        if let Some(profile) = std::env::var_os(CHILD) {
            let profile = std::path::PathBuf::from(profile);
            let settings = configuration::load_host_settings(
                &profile,
                &profile,
                &profile.join("settings.json"),
            )
            .unwrap();
            assert_eq!(
                configuration_sha(&settings, &resources()).unwrap(),
                std::env::var("KCODER_HOST_FINGERPRINT_UNIT_EXPECTED").unwrap()
            );
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let profile = directory.path().canonicalize().unwrap();
        let rule = serde_json::json!({"schema_sha256":"c".repeat(64),
            "uri_input_pointer":"/uri","input_template":{"uri":null}});
        let document = serde_json::json!({"integrations":{"connectivity":{"enabled":true}},
            "mcp_servers":[{"name":"owned-resource","command":"owned-fixture",
                "args":["first","second"],"policy":{"task_resource_reads":{
                    "read_document":rule,"read_deferred":rule}}}]});
        std::fs::write(
            profile.join("settings.json"),
            serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();
        let load = || {
            configuration::load_host_settings(&profile, &profile, &profile.join("settings.json"))
                .unwrap()
        };
        let settings = load();
        let expected = configuration_sha(&settings, &resources()).unwrap();
        // Legacy stored digests are never rewritten or accepted as current bindings.
        let resource = resources();
        use sha2::{Digest, Sha256};
        let legacy = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    "native-channel-host-configuration-v1",
                    &settings,
                    &resource.component_manifest_sha256,
                    &resource.node_image_sha256,
                    &resource.runtime_mode,
                    &resource.node_version,
                    &resource.electron_version,
                ))
                .unwrap()
            )
        );
        assert_ne!(legacy, expected);
        for _ in 0..16 {
            assert_eq!(configuration_sha(&load(), &resources()).unwrap(), expected);
        }
        let mut reordered = settings.clone();
        let rules = &mut reordered.mcp_servers[0].policy.task_resource_reads;
        let original = std::mem::take(rules);
        for name in ["read_deferred", "read_document"] {
            rules.insert(name.into(), original[name].clone());
        }
        assert_eq!(
            configuration_sha(&reordered, &resources()).unwrap(),
            expected
        );
        reordered.mcp_servers[0]
            .policy
            .task_resource_reads
            .get_mut("read_document")
            .unwrap()
            .schema_sha256 = "d".repeat(64);
        assert_eq!(
            configuration_sha(&reordered, &resources()).unwrap(),
            expected
        );
        let mut changed = settings.clone();
        changed.mcp_servers[0].args.reverse();
        assert_eq!(configuration_sha(&changed, &resources()).unwrap(), expected);
        changed = settings.clone();
        changed.max_retries += 1;
        assert_eq!(configuration_sha(&changed, &resources()).unwrap(), expected);
        changed.knowledge.enabled = !changed.knowledge.enabled;
        changed.model = "unavailable-model-after-consent".into();
        assert_eq!(configuration_sha(&changed, &resources()).unwrap(), expected);
        changed.integrations.connectivity.max_connections += 1;
        assert_ne!(configuration_sha(&changed, &resources()).unwrap(), expected);
        let mut changed_resources = resources();
        changed_resources.node_image_sha256 = "e".repeat(64);
        assert_ne!(
            configuration_sha(&settings, &changed_resources).unwrap(),
            expected
        );
        let filter = format!(
            "{}::original_host_fingerprint_survives_map_order_and_process_reload",
            module_path!().split_once("::").unwrap().1
        );
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &filter, "--nocapture"])
            .env(CHILD, &profile)
            .env("KCODER_HOST_FINGERPRINT_UNIT_EXPECTED", &expected)
            .output()
            .unwrap();
        assert!(
            child.status.success(),
            "owned fingerprint child failed: {}",
            String::from_utf8_lossy(&child.stderr)
        );
        assert!(String::from_utf8_lossy(&child.stdout).contains("1 passed"));
    }
}
