//! Authentication and envelope routing precede every Native transfer operation.
use super::*;
use crate::migration_source_authority::MigrationSourceAuthority;

impl MigrationProcessor {
    pub fn process_source_transfer(
        &self,
        authority: &MigrationSourceAuthority,
        factory: std::sync::Arc<dyn MigrationHost>,
        request: PrivateMigrationSourceRequestV1,
    ) -> Value {
        let id = serde_json::to_value(&request.id).unwrap_or(Value::Null);
        let private_credentials = request
            .method
            .strip_prefix(kcoder_app_protocol::MIGRATION_SOURCE_INTERNAL_PREFIX)
            .is_some_and(|operation| {
                operation.starts_with("source/private/") || operation.starts_with("target/private/")
            });
        let result = (|| -> Result<Value> {
            let operation = migration_source_internal_operation(&request.method)
                .ok_or_else(|| anyhow::anyhow!("source_transfer_method_unavailable"))?;
            match operation {
                "identity" => {
                    ensure!(
                        request
                            .params
                            .as_object()
                            .is_some_and(|value| value.is_empty()),
                        "source_transfer_invalid_request"
                    );
                    Ok(serde_json::json!({"authority":authority.identity()?,
                        "chunkBytes":kcoder_migration::source_transfer::TRANSFER_CHUNK_BYTES,
                        "maxManifestBytes":kcoder_migration::source_transfer::TRANSFER_MANIFEST_MAX_BYTES}))
                }
                "source/private/observe" => {
                    let params: kcoder_app_protocol::MigrationSourceCredentialObserveParamsV1 =
                        serde_json::from_value(request.params)
                            .map_err(|_| anyhow::anyhow!("private_credentials_invalid_request"))?;
                    let observation =
                        authority.observe_private_source(&params.request_id, &params.offer_id)?;
                    Ok(serde_json::to_value(
                        kcoder_app_protocol::MigrationSourceCredentialSourceObservationV1 {
                            control: serde_json::from_value(serde_json::to_value(
                                &observation.control,
                            )?)?,
                            writer_running: observation.writer_running,
                        },
                    )?)
                }
                "peer/accept" => {
                    let params: MigrationSourcePeerAcceptV1 =
                        serde_json::from_value(request.params)
                            .map_err(|_| anyhow::anyhow!("source_transfer_invalid_request"))?;
                    let proof = request
                        .private_source
                        .ok_or_else(|| anyhow::anyhow!("source_transfer_authority_unavailable"))?;
                    ensure!(
                        params.request_id == proof.request_id,
                        "source_transfer_request_changed"
                    );
                    Ok(serde_json::json!({"peerRef":authority.accept(params.role, proof)?}))
                }
                "peer/recover-target" => {
                    let params: kcoder_app_protocol::MigrationSourceTargetRecoverV1 =
                        serde_json::from_value(request.params)
                            .map_err(|_| anyhow::anyhow!("source_transfer_invalid_request"))?;
                    let (reference, target) = authority.recover_target(&params.request_id)?;
                    Ok(serde_json::json!({"peerRef":reference,"targetAuthority":target}))
                }
                _ => {
                    let request_id = request
                        .params
                        .get("requestId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow::anyhow!("source_transfer_invalid_request"))?;
                    let reference = request
                        .params
                        .get("peerRef")
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow::anyhow!("source_transfer_invalid_request"))?;
                    let peer = authority.peer(request_id, reference)?;
                    ensure!(
                        operation.split('/').next() == Some(peer.role()),
                        "source_transfer_role_mismatch"
                    );
                    if operation.starts_with("source/private/")
                        || operation.starts_with("target/private/")
                    {
                        source_transfer::private_credentials::execute(
                            self,
                            &peer,
                            factory,
                            operation,
                            request.params,
                        )
                    } else if operation == "target/received/read"
                        || operation.starts_with("target/adoption/")
                    {
                        source_transfer::adoption::execute(
                            self,
                            &peer,
                            factory,
                            operation,
                            request.params,
                        )
                    } else {
                        source_transfer::execute(self, &peer, operation, request.params)
                    }
                }
            }
        })();
        match result {
            Ok(result) => success_response(id, result),
            Err(error) => {
                let code = error.to_string();
                let private_code = if private_credentials {
                    serde_json::from_value::<kcoder_app_protocol::MigrationSourceCredentialError>(
                        Value::String(code.clone()),
                    )
                    .ok()
                } else {
                    None
                };
                let safe = if let Some(private_code) = private_code {
                    private_code.code()
                } else if code.starts_with("source_transfer_")
                    && code.len() < 128
                    && code
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                {
                    code.as_str()
                } else {
                    "source_transfer_operation_unconfirmed"
                };
                error_response(id, -32047, safe)
            }
        }
    }
}
