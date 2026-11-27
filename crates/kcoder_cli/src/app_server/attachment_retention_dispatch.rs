//! Four bounded handlers over the once-captured account-root service. This does
//! not enable retained uploads, accepted transfer, deletion or Mobile capability.
use super::attachment_retention::RetentionFailure;
use super::retention_context::VerifiedRetentionAuthority;
use anyhow::Result;
use kcoder_app_protocol::*;

pub(super) use super::attachment_retention::dispatch::{
    dispatch_in_scope_with_proof, error_code, error_message,
};

pub(super) fn dispatch_upload(
    authority: &VerifiedRetentionAuthority,
    request: &PrivateRetentionRequestV1,
) -> Result<RetentionUploadResultV1> {
    use base64::Engine;
    let scope = authority.retention_scope(request)?;
    let params: RetentionUploadParamsV1 = serde_json::from_value(request.params.clone())?;
    params
        .validate_for(&request.method)
        .map_err(anyhow::Error::msg)?;
    let service = authority.retention_service();
    let bytes = params
        .content_base64
        .as_ref()
        .map(|value| base64::engine::general_purpose::STANDARD.decode(value))
        .transpose()?;
    match request.method.as_str() {
        METHOD_RETENTION_UPLOAD_START => service.start_wire_upload(&scope, &params),
        METHOD_RETENTION_UPLOAD_READ => service.read_wire_upload(&scope, &params),
        METHOD_RETENTION_UPLOAD_CHUNK => service.chunk_wire_upload(
            &scope,
            &params,
            bytes.as_deref().ok_or(RetentionFailure::Conflict)?,
        ),
        METHOD_RETENTION_UPLOAD_FINISH => service.finish_wire_upload(&scope, &params),
        METHOD_RETENTION_UPLOAD_CANCEL => service.cancel_wire_upload(&scope, &params),
        METHOD_RETENTION_UPLOAD_SAVE => {
            let bytes = bytes.as_deref().ok_or(RetentionFailure::Conflict)?;
            let size = params.size.ok_or(RetentionFailure::Conflict)?;
            anyhow::ensure!(
                bytes.len() as u64 == size
                    && size <= RETENTION_UPLOAD_SAVE_BYTES
                    && super::private_files::hex_sha256(bytes)
                        == params.content_sha256.as_deref().unwrap_or(""),
                RetentionFailure::Conflict
            );
            service.start_wire_upload(&scope, &params)?;
            if size > 0 {
                let mut chunk = params.clone();
                chunk.offset = Some(0);
                chunk.length = Some(size);
                chunk.chunk_sha256 = params.content_sha256.clone();
                service.chunk_wire_upload(&scope, &chunk, bytes)?;
            }
            service.finish_wire_upload(&scope, &params)
        }
        _ => anyhow::bail!(RetentionFailure::Conflict),
    }
}
