//! Public failures contain finite reasons, never raw application-host diagnostics.
use anyhow::Error;
use kcoder_types::integrations::core::IntegrationRecovery;

pub(super) fn public_failure(error: &Error) -> (&'static str, &'static str, IntegrationRecovery) {
    let reasons: Vec<_> = error.chain().take(12).map(ToString::to_string).collect();
    let has = |codes: &[&str]| {
        reasons
            .iter()
            .any(|reason| codes.contains(&reason.as_str()))
    };
    if has(&[
        "INTEGRATION_IDENTITY_REVOKED",
        "DELEGATION_REVOKED",
        "DELEGATION_POLICY_DENIED",
    ]) {
        return (
            "CHANNEL_AUTHORIZATION_REVOKED",
            "integrations.connectivity.authorizationRevoked",
            IntegrationRecovery::RepairConfiguration,
        );
    }
    if has(&[
        "CHANNEL_HOST_CONFIGURATION_CHANGED",
        "CHANNEL_HOST_IMAGE_CHANGED",
        "CHANNEL_HOST_ORIGINAL_LAUNCH_CHANGED",
        "CHANNEL_HOST_READ_REQUIRES_EXISTING_OWNER",
        "CHANNEL_HOST_ORIGINAL_SCOPE_AMBIGUOUS",
    ]) {
        return (
            "CHANNEL_HOST_CONFIGURATION_CHANGED",
            "integrations.connectivity.hostConfigurationChanged",
            IntegrationRecovery::RepairConfiguration,
        );
    }
    if has(&[
        "CHANNEL_HOST_ORIGINAL_STORE_REQUIRED",
        "CHANNEL_HOST_ORIGINAL_LAUNCH_REQUIRED",
        "CHANNEL_HOST_ORIGINAL_OWNER_UNAVAILABLE",
        "CHANNEL_HOST_ORIGINAL_READY_REQUIRED",
        "CHANNEL_HOST_ORIGINAL_READY_UNCONFIRMED",
        "CHANNEL_HOST_READY_UNCONFIRMED",
        "CHANNEL_HOST_ORIGINAL_OWNER_BUSY",
        "CHANNEL_HOST_READ_REQUIRES_EXISTING_OWNER",
        "CHANNEL_HOST_NATIVE_MANAGER_UNAVAILABLE",
        "CHANNEL_HOST_ORIGINAL_MANAGER_REQUIRED",
        "CHANNEL_HOST_MANAGER_RECEIPT_UNKNOWN",
        "APP_SERVER_ADAPTER_PREDECESSOR_NOT_QUIESCED",
        "CONNECTIVITY_HOST_CLEANUP_UNCONFIRMED",
        "CHANNEL_SCOPE_ORIGINAL_MAIN_UNAVAILABLE",
    ]) {
        return (
            "CHANNEL_HOST_NOT_RECOVERED",
            "integrations.connectivity.hostNotRecovered",
            IntegrationRecovery::RetryRead,
        );
    }
    (
        "CONNECTIVITY_NATIVE_UNAVAILABLE",
        "integrations.connectivity.nativeUnavailable",
        IntegrationRecovery::RetryRead,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_safe_reasons_without_publishing_private_context() {
        for (reason, expected) in [
            (
                "CHANNEL_HOST_CONFIGURATION_CHANGED",
                "CHANNEL_HOST_CONFIGURATION_CHANGED",
            ),
            (
                "CHANNEL_HOST_ORIGINAL_STORE_REQUIRED",
                "CHANNEL_HOST_NOT_RECOVERED",
            ),
            (
                "CONNECTIVITY_HOST_CLEANUP_UNCONFIRMED",
                "CHANNEL_HOST_NOT_RECOVERED",
            ),
            (
                "APP_SERVER_ADAPTER_PREDECESSOR_NOT_QUIESCED",
                "CHANNEL_HOST_NOT_RECOVERED",
            ),
            (
                "INTEGRATION_IDENTITY_REVOKED",
                "CHANNEL_AUTHORIZATION_REVOKED",
            ),
            (
                "CHANNEL_CREDENTIAL_EXPIRED",
                "CONNECTIVITY_NATIVE_UNAVAILABLE",
            ),
            (
                "private SDK failure with credentials",
                "CONNECTIVITY_NATIVE_UNAVAILABLE",
            ),
        ] {
            let error = Error::msg(reason).context("private /profile/location");
            assert_eq!(public_failure(&error).0, expected);
        }
    }
}
