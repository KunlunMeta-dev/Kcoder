//! Explicit OS-trusted stdio parent boundary. It validates authority only;
//! four retained receipt handlers use the captured service; producer/proof
//! lifecycle capability remains disabled. Workspace V2 readiness is
//! advertised only after actual capture by the connection boundary.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::*;
use kcoder_config::PrivateDirectory;
use kcoder_types::PrivateFileIdentityV1;
use serde_json::Value;
#[cfg(target_os = "linux")]
use std::fs::File;
use std::path::PathBuf;

pub struct RetentionLaunchConfiguration {
    pub parent: RetentionParentLaunchV1,
    pub account_root: PathBuf,
    /// Valid inherited env facts may leave ordinary functionality available when
    /// platform/root/FS capture is unavailable. Explicit CLI flags stay strict.
    pub optional: bool,
    pub revocation_verifier: Option<PrivateRetentionVerifierV1>,
}

pub struct VerifiedRetentionAuthority {
    parent: RetentionParentLaunchV1,
    account_path: PathBuf,
    account: PrivateDirectory,
    account_identity: PrivateFileIdentityV1,
    workspace_path: PathBuf,
    #[cfg(target_os = "linux")]
    workspace: File,
    #[cfg(target_os = "linux")]
    workspace_native: (u64, u64),
    workspace_digest: String,
    service: crate::RetentionService,
    revocation_verifier: Option<PrivateRetentionVerifierV1>,
}

impl VerifiedRetentionAuthority {
    pub fn verify_native_component_roots(
        &self,
        profile: &PrivateDirectory,
        workspace: &PrivateDirectory,
    ) -> Result<()> {
        self.verify_roots()?;
        ensure!(
            profile.directory_identity()? == self.account.directory_identity()?,
            "NATIVE_COMPONENT_PROFILE_MISMATCH"
        );
        #[cfg(target_os = "linux")]
        ensure!(
            workspace.directory_identity()?
                == format!(
                    "unix:{}:{}",
                    self.workspace_native.0, self.workspace_native.1
                ),
            "NATIVE_COMPONENT_WORKSPACE_MISMATCH"
        );
        #[cfg(not(target_os = "linux"))]
        {
            let _ = workspace;
            anyhow::bail!("NATIVE_COMPONENT_PARENT_UNAVAILABLE");
        }
        #[cfg(target_os = "linux")]
        Ok(())
    }
    #[cfg(target_os = "linux")]
    pub fn capture(
        configuration: RetentionLaunchConfiguration,
        workspace_root: &std::path::Path,
        durable_client_storage: bool,
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
        let workspace_path = workspace_root
            .canonicalize()
            .context("retention workspace unavailable")?;
        let workspace = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&workspace_path)?;
        let metadata = workspace.metadata()?;
        let workspace_native = (metadata.dev(), metadata.ino());
        let workspace_digest = crate::storage::digest(&serde_json::to_vec(&(
            "kcoder.retention.workspace.v1",
            uid,
            &account_identity,
            &workspace_path,
            workspace_native,
        ))?);
        let service = crate::RetentionService::open_account_root(
            &configuration.account_root,
            durable_client_storage,
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
            revocation_verifier: configuration.revocation_verifier,
        })
    }

    #[cfg(not(target_os = "linux"))]
    pub fn capture(_: RetentionLaunchConfiguration, _: &std::path::Path, _: bool) -> Result<Self> {
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

    pub fn validate(&self, request: &PrivateRetentionRequestV1) -> std::result::Result<(), i64> {
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
            "turn/start" => {
                let params: TurnStartParams =
                    serde_json::from_value(request.params.clone()).map_err(|_| -32602i64)?;
                let retained = params.retention.as_ref().ok_or(-32602i64)?;
                retained.validate().map_err(|_| -32602i64)?;
                if params.client_message_id.as_deref().is_none_or(|id| {
                    id.is_empty() || id.len() > 256 || id.chars().any(char::is_control)
                }) || params.resubmit.unwrap_or(false)
                    || params.retry_from_turn_id.is_some()
                    || params.retry_operation_id.is_some()
                {
                    return Err(-32602);
                }
            }
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
                crate::workspace_receipt_request::validate_request(request)
                    .map_err(|_| -32602i64)?;
            }
            _ => return Err(-32602),
        }
        // Pure full-envelope validation precedes all root or ledger IO.
        if is_attachment_retention_method(&request.method) || request.method == "turn/start" {
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

    pub fn retention_service(&self) -> &crate::RetentionService {
        &self.service
    }

    /// Verified outside namespace transactions; no secret is copied into the
    /// returned token, response, retained scope, or administrative journal.
    pub fn verify_device_revocation(&self, request: &PrivateDeviceRevocationV1) -> Result<()> {
        use hmac::{Hmac, Mac};
        use sha2::{Digest, Sha256};
        ensure!(
            request.validate() && matches!(self.parent, RetentionParentLaunchV1::LocalOs),
            "private revocation authority unavailable"
        );
        self.verify_roots()?;
        let verifier = self
            .revocation_verifier
            .as_ref()
            .context("private revocation verifier unavailable")?;
        ensure!(
            verifier.gateway_namespace_id == request.statement.gateway_namespace_id
                && request.route.workspace_path
                    == self
                        .workspace_path
                        .to_str()
                        .context("workspace encoding unavailable")?
                && request.statement_sha256
                    == format!("{:x}", Sha256::digest(request.statement.canonical_bytes()?))
                && request.route.route_id
                    == format!("{:x}", Sha256::digest(request.route.canonical_bytes()?)),
            "private revocation binding rejected"
        );
        let decode = |hex: &str| -> Vec<u8> {
            hex.as_bytes()
                .chunks_exact(2)
                .map(|pair| {
                    let digit = |b| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
                    digit(pair[0]) * 16 + digit(pair[1])
                })
                .collect()
        };
        let mut mac = Hmac::<Sha256>::new_from_slice(&decode(&verifier.key))
            .map_err(|_| anyhow::anyhow!("private verifier unavailable"))?;
        mac.update(&request.authenticated_bytes()?);
        mac.verify_slice(&decode(&request.authenticator))
            .map_err(|_| anyhow::anyhow!("private revocation authenticator rejected"))?;
        Ok(())
    }

    /// Administrative deletion uses the captured process parent/account root,
    /// not request-provided device fields or a formerly authenticated socket.
    pub fn administrative_workspace_binding(&self) -> Result<(&str, RetentionPrincipalV1)> {
        self.verify_roots()?;
        let principal = match &self.parent {
            RetentionParentLaunchV1::LocalOs => RetentionPrincipalV1::LocalOs,
            RetentionParentLaunchV1::VerifiedAccount { principal_id, .. } => {
                RetentionPrincipalV1::VerifiedAccount {
                    principal_id: principal_id.clone(),
                }
            }
        };
        Ok((&self.workspace_digest, principal))
    }
    pub fn retention_scope(
        &self,
        request: &PrivateRetentionRequestV1,
    ) -> Result<crate::model::Scope> {
        ensure!(
            is_attachment_retention_method(&request.method) || request.method == "turn/start",
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

    pub fn workspace_scope(
        &self,
        request: &PrivateRetentionRequestV1,
    ) -> Result<WorkspaceOperationScopeV2> {
        ensure!(
            is_workspace_operation_v2(&request.method),
            "Invalid workspace receipt method"
        );
        self.validate(request)
            .map_err(|_| anyhow::anyhow!("Workspace authority unavailable"))?;
        let root_id = crate::storage::digest(&serde_json::to_vec(&(
            "kcoder.workspace.root.v2",
            &self.workspace_digest,
        ))?);
        let scope_id = crate::storage::digest(&serde_json::to_vec(&(
            "kcoder.workspace.scope.v2",
            &root_id,
            &request.private_retention.context,
            &request.private_retention.workspace_account,
            &request.private_retention.workspace_target_id,
        ))?);
        let family_id = crate::storage::digest(&serde_json::to_vec(&(
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

    pub fn workspace_receipts_directory(&self, create: bool) -> Result<PrivateDirectory> {
        self.verify_roots()?;
        self.account
            .open_child(std::ffi::OsStr::new("workspace-operations-v2"), create)
    }
}

#[cfg(target_os = "linux")]
fn valid_atom(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

/// Detection is not authentication: private frames are decoded again from raw
/// bytes by the duplicate-rejecting typed visitor.
pub fn has_private_authority(request: &Value) -> bool {
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
