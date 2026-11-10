//! One inherited OS-parent declaration, captured before dotenv and never reread.
use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use kcoder_app_protocol::{
    PRIVATE_RETENTION_PARENT_JSON_LIMIT_V1, RetentionParentLaunchV1,
    decode_private_retention_parent_environment,
};
pub(crate) use kcoder_host_transport::parent_identity::validate_identity;
use std::ffi::OsString;

pub(crate) fn decode(raw: Option<OsString>) -> Result<Option<RetentionParentLaunchV1>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let failure = || anyhow::anyhow!("invalid private parent launch declaration");
    let raw = raw.into_string().map_err(|_| failure())?;
    // Bound encoded input before allocating decoded JSON.
    ensure!(
        raw.len() <= 3 + PRIVATE_RETENTION_PARENT_JSON_LIMIT_V1.div_ceil(3) * 4,
        "invalid private parent launch declaration"
    );
    let encoded = raw.strip_prefix("v1.").ok_or_else(failure)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| failure())?;
    let json = std::str::from_utf8(&bytes).map_err(|_| failure())?;
    let parent = decode_private_retention_parent_environment(json).map_err(|_| failure())?;
    validate_identity(&parent)?;
    Ok(Some(parent))
}

pub(crate) fn decode_verifier(
    raw: Option<OsString>,
) -> Result<Option<kcoder_app_protocol::PrivateRetentionVerifierV1>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let failure = || anyhow::anyhow!("invalid private retention verifier");
    let raw = raw.into_string().map_err(|_| failure())?;
    ensure!(raw.len() <= 1024, "invalid private retention verifier");
    let bytes = URL_SAFE_NO_PAD
        .decode(raw.strip_prefix("v1.").ok_or_else(failure)?)
        .map_err(|_| failure())?;
    let json = std::str::from_utf8(&bytes).map_err(|_| failure())?;
    Ok(Some(
        kcoder_app_protocol::decode_private_retention_verifier(json).map_err(|_| failure())?,
    ))
}
