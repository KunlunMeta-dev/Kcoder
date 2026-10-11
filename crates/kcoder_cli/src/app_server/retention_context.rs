//! Explicit OS-trusted stdio parent boundary. It validates authority only;
//! four retained receipt handlers use the captured service; producer/proof
//! lifecycle capability remains disabled. Workspace V2 readiness is
//! advertised only after actual capture by the connection boundary.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::*;
use kcoder_config::PrivateDirectory;
use kcoder_types::PrivateFileIdentityV1;
use serde_json::Value;
use std::{fs::File, path::PathBuf};

pub(crate) struct RetentionLaunchConfiguration {
    pub parent: RetentionParentLaunchV1,
    pub account_root: PathBuf,
    /// Valid inherited env facts may leave ordinary functionality available when
    /// platform/root/FS capture is unavailable. Explicit CLI flags stay strict.
    pub optional: bool,
}

pub(super) struct VerifiedRetentionAuthority {
    parent: RetentionParentLaunchV1,
    account_path: PathBuf,
    account: PrivateDirectory,
    account_identity: PrivateFileIdentityV1,
    workspace_path: PathBuf,
    workspace: File,
    workspace_native: (u64, u64),
    workspace_digest: String,
    service: super::attachment_retention::RetentionService,
}

impl VerifiedRetentionAuthority {
    #[cfg(target_os = "linux")]
    pub(super) fn capture(
        configuration: RetentionLaunchConfiguration,
        engine: &kcoder_engine::QueryEngine,
    ) -> Result<Self> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let uid = unsafe { libc::geteuid() };
        if let RetentionParentLaunchV1::VerifiedAccount {
            principal_id,
            uid: declared_uid,
        } = &configuration.parent
        {
            ensure!(
                *declared_uid == uid && valid_atom(principal_id),
                "retention launch identity unavailable"
            );
        }
        let account = PrivateDirectory::open_existing(&configuration.account_root)?;
        let account_identity = account.retention_identity()?;
        ensure!(
            account.retention_filesystem_supported()?,
            "retention filesystem unavailable"
        );
        let workspace_path = engine
            .cwd
            .canonicalize()
            .context("retention workspace unavailable")?;
        let workspace = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&workspace_path)?;
        let metadata = workspace.metadata()?;
        let workspace_native = (metadata.dev(), metadata.ino());
        let workspace_digest = super::private_files::hex_sha256(&serde_json::to_vec(&(
            "kcoder.retention.workspace.v1",
            uid,
            &account_identity,
            &workspace_path,
            workspace_native,
        ))?);
        let service = super::attachment_retention::RetentionService::open_account_root(
            &configuration.account_root,
            engine.durable_client_storage_root().is_some(),
        )?;
        Ok(Self {
            parent: configuration.parent,
            account_path: configuration.account_root,
            account,
            account_identity,
            workspace_path,
            workspace,
            workspace_native,
            workspace_digest,
            service,
        })
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn capture(
        _: RetentionLaunchConfiguration,
        _: &kcoder_engine::QueryEngine,
    ) -> Result<Self> {
        anyhow::bail!("retention authority unavailable on this platform")
    }

    fn verify_roots(&self) -> Result<()> {
        self.account
            .verify_retention_identity(&self.account_identity)?;
        PrivateDirectory::open_existing(&self.account_path)?
            .verify_retention_identity(&self.account_identity)?;
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
            let held = self.workspace.metadata()?;
            let current = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&self.workspace_path)?
                .metadata()?;
            ensure!(
                (held.dev(), held.ino()) == self.workspace_native
                    && (current.dev(), current.ino()) == self.workspace_native,
                "retention workspace changed"
            );
        }
        Ok(())
    }

    pub(super) fn validate(
        &self,
        request: &PrivateRetentionRequestV1,
    ) -> std::result::Result<(), i64> {
        let context = &request.private_retention.context;
        macro_rules! check {
            ($kind:ty) => {{
                let params: $kind =
                    serde_json::from_value(request.params.clone()).map_err(|_| -32602i64)?;
                params.validate_batch().map_err(|_| -32602i64)?;
                if params.trusted_context != *context {
                    return Err(-32602);
                }
            }};
        }
        match request.method.as_str() {
            METHOD_ATTACHMENT_RETENTION_RESERVE => check!(AttachmentRetentionReserveParams),
            METHOD_ATTACHMENT_RETENTION_READ => check!(AttachmentRetentionReadParams),
            METHOD_ATTACHMENT_RETENTION_RELEASE => check!(AttachmentRetentionReleaseParams),
            METHOD_ATTACHMENT_RETENTION_CONSUME => check!(AttachmentRetentionConsumeParams),
            method if is_retention_upload_method(method) => {
                let params: RetentionUploadParamsV1 =
                    serde_json::from_value(request.params.clone()).map_err(|_| -32602i64)?;
                params.validate_for(method).map_err(|_| -32602i64)?;
                if params.trusted_context != *context {
                    return Err(-32602);
                }
            }
            method if is_workspace_operation_v2(method) => {
                super::workspace_operation_receipts_v2::validate_request(request)
                    .map_err(|_| -32602i64)?;
            }
            _ => return Err(-32602),
        }
        // Pure full-envelope validation precedes all root or ledger IO.
        if is_attachment_retention_method(&request.method) {
            self.service
                .full_scope(
                    context,
                    &self.workspace_digest,
                    request.private_retention.workspace_account.as_ref(),
                    request
                        .private_retention
                        .workspace_target_id
                        .as_deref()
                        .ok_or(-32602i64)?,
                )
                .map_err(|_| -32602i64)?;
        }
        let authorized = match (&self.parent, &context.principal) {
            (RetentionParentLaunchV1::LocalOs, RetentionPrincipalV1::LocalOs) => true,
            (
                RetentionParentLaunchV1::VerifiedAccount {
                    principal_id: expected,
                    ..
                },
                RetentionPrincipalV1::VerifiedAccount { principal_id },
            ) => expected == principal_id,
            _ => false,
        };
        if !authorized {
            return Err(-32001);
        }
        if self
            .service
            .validate_adapter_scope(context, &self.workspace_digest)
            .is_err()
        {
            return Err(-32602);
        }
        if self.verify_roots().is_err() {
            return Err(-32001);
        }
        Ok(())
    }

    pub(super) fn retention_service(&self) -> &super::attachment_retention::RetentionService {
        &self.service
    }
    pub(super) fn retention_scope(
        &self,
        request: &PrivateRetentionRequestV1,
    ) -> Result<super::attachment_retention::model::Scope> {
        ensure!(
            is_attachment_retention_method(&request.method),
            "Invalid retention method"
        );
        self.validate(request)
            .map_err(|_| anyhow::anyhow!("Retention authority unavailable"))?;
        self.service.full_scope(
            &request.private_retention.context,
            &self.workspace_digest,
            request.private_retention.workspace_account.as_ref(),
            request
                .private_retention
                .workspace_target_id
                .as_deref()
                .context("Retention target missing")?,
        )
    }

    pub(super) fn workspace_scope(
        &self,
        request: &PrivateRetentionRequestV1,
    ) -> Result<WorkspaceOperationScopeV2> {
        ensure!(
            is_workspace_operation_v2(&request.method),
            "Invalid workspace receipt method"
        );
        self.validate(request)
            .map_err(|_| anyhow::anyhow!("Workspace authority unavailable"))?;
        let root_id = super::private_files::hex_sha256(&serde_json::to_vec(&(
            "kcoder.workspace.root.v2",
            &self.workspace_digest,
        ))?);
        let scope_id = super::private_files::hex_sha256(&serde_json::to_vec(&(
            "kcoder.workspace.scope.v2",
            &root_id,
            &request.private_retention.context,
            &request.private_retention.workspace_account,
            &request.private_retention.workspace_target_id,
        ))?);
        let family_id = super::private_files::hex_sha256(&serde_json::to_vec(&(
            "kcoder.workspace.family.v2",
            &request.private_retention.context.gateway_namespace_id,
            &request.private_retention.workspace_target_id,
        ))?);
        Ok(WorkspaceOperationScopeV2 {
            version: 2,
            root_id,
            scope_id,
            family_id,
        })
    }

    pub(super) fn workspace_receipts_directory(&self, create: bool) -> Result<PrivateDirectory> {
        self.verify_roots()?;
        self.account
            .open_child(std::ffi::OsStr::new("workspace-operations-v2"), create)
    }
}

pub(crate) fn valid_atom(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

/// Detection is not authentication: private frames are decoded again from raw
/// bytes by the duplicate-rejecting typed visitor.
pub(super) fn has_private_authority(request: &Value) -> bool {
    if request.get(PRIVATE_RETENTION_FIELD_V1).is_some() {
        return true;
    }
    fn reserved(value: &Value) -> bool {
        match value {
            Value::Object(object) => object.iter().any(|(key, value)| {
                key == "trustedContext" || key == PRIVATE_RETENTION_FIELD_V1 || reserved(value)
            }),
            Value::Array(values) => values.iter().any(reserved),
            _ => false,
        }
    }
    request
        .get("method")
        .and_then(Value::as_str)
        .is_some_and(|method| method.starts_with("attachment/"))
        && request.get("params").is_some_and(reserved)
}
