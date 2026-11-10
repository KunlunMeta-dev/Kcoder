//! Trusted host-only record/byte channel. Never register in ordinary RPC dispatch.
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_state::integrations::office::{OfficeInputMetadata, OfficeNativeInput, OfficeStore};
use kcoder_types::integrations::{core::*, office::*};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

#[async_trait]
pub trait OfficePrivateHost: Send + Sync {
    fn validate_scope(&self, scope: &IntegrationScope) -> Result<()>;
    async fn authorize_private(
        &self,
        scope: &IntegrationScope,
        action: &str,
        resources: &Value,
        cancel: &CancellationToken,
    ) -> Result<()>;
    fn current_connection_id(&self) -> &str;
    /// Verify the real native upload/retention receipt and return its canonical
    /// owned mapping. A caller-provided path or scope is not sufficient.
    fn validate_native_receipt(
        &self,
        scope: &IntegrationScope,
        native: &OfficeNativeInput,
    ) -> Result<OfficeNativeInput>;
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Begin {
    operation_id: String,
    input_id: String,
    metadata: OfficeInputMetadata,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    input_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Finish {
    operation_id: String,
    input_id: String,
    bytes: u64,
    sha256: String,
    native: OfficeNativeInput,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fail {
    operation_id: String,
    input_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Chunk {
    reference: OfficeArtifactRef,
    offset: u64,
    length: usize,
    #[serde(default)]
    destination: Option<OfficeResourceRef>,
}

pub async fn dispatch_private(
    method: &str,
    request: &IntegrationRequest,
    store: &OfficeStore,
    host: &dyn OfficePrivateHost,
    cancel: &CancellationToken,
) -> Result<Value> {
    let action = match method {
        "office/input/begin" | "office/input/complete" | "office/input/fail" => {
            "office.input.prepare"
        }
        "office/input/read" => "office.input.read",
        "office/artifact/read" | "office/artifact/chunk" => "office.artifact.export",
        _ => anyhow::bail!("OFFICE_PRIVATE_METHOD_UNSUPPORTED"),
    };
    request.validate(
        method.ends_with("/begin") || method.ends_with("/complete") || method.ends_with("/fail"),
    )?;
    ensure!(
        IntegrationOwner::from(&request.scope) == *store.owner() && !cancel.is_cancelled(),
        "OFFICE_OWNER_MISMATCH"
    );
    host.validate_scope(&request.scope)?;
    host.authorize_private(
        &request.scope,
        action,
        &Value::Object(request.payload.clone()),
        cancel,
    )
    .await?;
    host.validate_scope(&request.scope)?;
    ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
    match method {
        "office/input/begin" => {
            let params: Begin = serde_json::from_value(Value::Object(request.payload.clone()))?;
            ensure!(
                request.operation_id.as_deref() == Some(params.operation_id.as_str()),
                "OFFICE_OPERATION_CONFLICT"
            );
            let (fresh, record) = store.begin_input_attempt(
                &params.operation_id,
                &params.input_id,
                params.metadata,
            )?;
            Ok(json!({"existing":!fresh,"record":record}))
        }
        "office/input/read" => {
            let params: Read = serde_json::from_value(Value::Object(request.payload.clone()))?;
            Ok(json!({"record":store.read_input(&params.input_id)?}))
        }
        "office/input/complete" => {
            let params: Finish = serde_json::from_value(Value::Object(request.payload.clone()))?;
            ensure!(
                request.operation_id.as_deref() == Some(params.operation_id.as_str())
                    && params.native.connection_id == host.current_connection_id(),
                "OFFICE_SCOPE_CHANGED"
            );
            let canonical = host.validate_native_receipt(&request.scope, &params.native)?;
            let receipt = store.complete_input(
                &params.operation_id,
                &params.input_id,
                params.bytes,
                &params.sha256,
                canonical,
            )?;
            Ok(json!({"receipt":receipt}))
        }
        "office/input/fail" => {
            let params: Fail = serde_json::from_value(Value::Object(request.payload.clone()))?;
            ensure!(
                request.operation_id.as_deref() == Some(params.operation_id.as_str()),
                "OFFICE_OPERATION_CONFLICT"
            );
            Ok(json!({"receipt":store.fail_input(&params.operation_id,&params.input_id)?}))
        }
        "office/artifact/read" => {
            let reference: OfficeArtifactRef = rpc_codec::decode(
                request
                    .payload
                    .get("reference")
                    .cloned()
                    .context("OFFICE_INVALID_INPUT")?,
            )?;
            let manifest = store
                .read_artifact(&reference)?
                .context("OFFICE_ARTIFACT_NOT_FOUND")?;
            Ok(json!({"manifest":manifest}))
        }
        "office/artifact/chunk" => {
            let params: Chunk = serde_json::from_value(Value::Object(request.payload.clone()))?;
            let _destination = params.destination;
            let (bytes, total) =
                store.read_artifact_chunk(&params.reference, params.offset, params.length)?;
            Ok(
                json!({"contentBase64":STANDARD.encode(bytes),"totalBytes":total,"offset":params.offset}),
            )
        }
        _ => anyhow::bail!("OFFICE_PRIVATE_METHOD_UNSUPPORTED"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::attachments::{
        AttachmentDirectories, attachment_upload_chunk, attachment_upload_finish,
        attachment_upload_start,
    };
    use kcoder_app_protocol::{
        AttachmentUploadChunkParams, AttachmentUploadFinishParams, AttachmentUploadStartParams,
    };
    use sha2::{Digest, Sha256};
    use std::sync::Mutex;
    struct Host {
        scope: IntegrationScope,
        staged: Mutex<AttachmentDirectories>,
    }
    #[async_trait]
    impl OfficePrivateHost for Host {
        fn validate_scope(&self, scope: &IntegrationScope) -> Result<()> {
            ensure!(scope == &self.scope, "OFFICE_SCOPE_CHANGED");
            Ok(())
        }
        async fn authorize_private(
            &self,
            scope: &IntegrationScope,
            _: &str,
            _: &Value,
            _: &CancellationToken,
        ) -> Result<()> {
            self.validate_scope(scope)
        }
        fn current_connection_id(&self) -> &str {
            "actual-native-connection-fixture"
        }
        fn validate_native_receipt(
            &self,
            scope: &IntegrationScope,
            native: &OfficeNativeInput,
        ) -> Result<OfficeNativeInput> {
            self.validate_scope(scope)?;
            ensure!(
                native.connection_id == self.current_connection_id()
                    && self
                        .staged
                        .lock()
                        .unwrap()
                        .contains(std::path::Path::new(&native.path)),
                "OFFICE_OWNER_MISMATCH"
            );
            let meta = std::fs::symlink_metadata(&native.path)?;
            ensure!(
                meta.is_file() && !meta.file_type().is_symlink(),
                "OFFICE_OWNER_MISMATCH"
            );
            Ok(native.clone())
        }
    }
    #[tokio::test]
    async fn native_attachment_receipt_and_office_store_use_real_owned_files() {
        let Some(root) = std::env::var_os("KCODER_OFFICE_NATIVE_INPUT_FIXTURE_ROOT") else {
            let root = tempfile::tempdir().unwrap();
            let status=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","app_server::integrations::office::private::tests::native_attachment_receipt_and_office_store_use_real_owned_files","--nocapture"]).env("KCODER_OFFICE_NATIVE_INPUT_FIXTURE_ROOT",root.path()).env("TMPDIR",root.path()).env("TMP",root.path()).env("TEMP",root.path()).status().unwrap();
            assert!(status.success());
            return;
        };
        let root = std::path::PathBuf::from(root);
        let scope = IntegrationScope {
            account_id: "fixture-account".into(),
            target_id: "fixture-target".into(),
            workspace_id: IntegrationNullable::Value("fixture-workspace".into()),
            identity_generation: "fixture-generation".into(),
            target_revision: "fixture-target-revision".into(),
            organization_id: None,
        };
        let store =
            OfficeStore::create(&root.join("office"), IntegrationOwner::from(&scope)).unwrap();
        let host = Host {
            scope: scope.clone(),
            staged: Mutex::new(AttachmentDirectories::default()),
        };
        let bytes = vec![b'a'; 1024 * 1024 + 17];
        let sha = format!("{:x}", Sha256::digest(&bytes));
        let native = {
            let mut staged = host.staged.lock().unwrap();
            let start = attachment_upload_start(
                "fixture-session",
                &AttachmentUploadStartParams {
                    filename: "真实材料.txt".into(),
                    size: bytes.len() as u64,
                    retention: None,
                },
                &mut staged,
            )
            .unwrap();
            for (index, chunk) in bytes.chunks(512 * 1024).enumerate() {
                attachment_upload_chunk(
                    &AttachmentUploadChunkParams {
                        upload_id: start.upload_id.clone(),
                        index: index as u32,
                        content_base64: STANDARD.encode(chunk),
                        retention: None,
                    },
                    &mut staged,
                )
                .unwrap();
            }
            let saved = attachment_upload_finish(
                &AttachmentUploadFinishParams {
                    office_input: None,
                    upload_id: start.upload_id,
                    retention: None,
                },
                &mut staged,
            )
            .unwrap();
            assert_eq!(std::fs::read(&saved.path).unwrap(), bytes);
            OfficeNativeInput {
                path: saved.path,
                stage_ref: None,
                connection_id: host.current_connection_id().into(),
            }
        };
        let mut request=IntegrationRequest{contract_version:IntegrationContractVersion::ParallelV1,request_id:"private-request".into(),scope,operation_id:Some("material-op".into()),expected_revision:None,timeout_ms:1000,cancellation_ref:None,payload:json!({"operationId":"material-op","inputId":"opaque-input","metadata":{"filename":"真实材料.txt","mediaType":"text/plain","expectedBytes":bytes.len(),"expectedSha256":sha}}).as_object().unwrap().clone()};
        let cancel = CancellationToken::new();
        let first = dispatch_private("office/input/begin", &request, &store, &host, &cancel)
            .await
            .unwrap();
        assert_eq!(first["existing"], false);
        request.payload=json!({"operationId":"material-op","inputId":"opaque-input","bytes":bytes.len(),"sha256":sha,"native":native}).as_object().unwrap().clone();
        let completed = dispatch_private("office/input/complete", &request, &store, &host, &cancel)
            .await
            .unwrap();
        assert_eq!(completed["receipt"]["status"], "accepted");
        assert!(completed["receipt"].get("native").is_none());
        let mut foreign = native.clone();
        foreign.path = root
            .join("not-staged-by-this-connection")
            .to_string_lossy()
            .into_owned();
        std::fs::write(&foreign.path, b"foreign").unwrap();
        assert!(
            host.validate_native_receipt(&request.scope, &foreign)
                .is_err()
        );
        drop(store);
        let reopened = OfficeStore::open_existing(
            &root.join("office"),
            IntegrationOwner::from(&request.scope),
        )
        .unwrap()
        .unwrap();
        let record = reopened.read_input("opaque-input").unwrap().unwrap();
        assert_eq!(record.receipt.sha256.as_deref(), Some(sha.as_str()));
        assert_eq!(record.native, Some(native));
    }
}
