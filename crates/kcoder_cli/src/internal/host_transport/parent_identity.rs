//! Shared validation of the declared operating-system parent identity.
#[cfg(unix)]
use anyhow::bail;
use anyhow::{Result, ensure};
use kcoder_app_protocol::RetentionParentLaunchV1;

/// This verifies declared identity, not filesystem availability. Identity errors
/// must never become optional-capability fallback.
pub fn validate_identity(parent: &RetentionParentLaunchV1) -> Result<()> {
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
