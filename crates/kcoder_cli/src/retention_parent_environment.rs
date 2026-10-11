//! One inherited OS-parent declaration, captured before dotenv and never reread.
use anyhow::{Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use kcoder_app_protocol::{
    PRIVATE_RETENTION_PARENT_JSON_LIMIT_V1, RetentionParentLaunchV1,
    decode_private_retention_parent_environment,
};
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

/// This verifies declared identity, not filesystem availability. Identity errors
/// must never become optional-capability fallback.
pub(crate) fn validate_identity(parent: &RetentionParentLaunchV1) -> Result<()> {
    if let RetentionParentLaunchV1::VerifiedAccount { principal_id, uid } = parent {
        ensure!(
            !principal_id.is_empty()
                && principal_id.len() <= 256
                && !principal_id.chars().any(char::is_control),
            "invalid private parent launch identity"
        );
        #[cfg(unix)]
        if *uid != unsafe { libc::geteuid() } {
            bail!("private parent launch identity mismatch");
        }
        #[cfg(not(unix))]
        let _ = uid; // Valid facts remain unavailable on unsupported platforms.
    }
    Ok(())
}
