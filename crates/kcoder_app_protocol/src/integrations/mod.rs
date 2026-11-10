//! Integration wire contracts. Business capabilities are negotiated separately.
pub use kcoder_integration_protocol::*;
pub use kcoder_types::integrations::core::*;
pub mod channel_peer;
pub mod code_services;
pub use kcoder_channel_protocol::connectivity;
pub use kcoder_channel_protocol::connectivity_settings;
pub use kcoder_channel_protocol::task_capability_scope;
pub use kcoder_channel_protocol::task_workspace;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integration_contract_is_the_shared_native_type() {
        let value = serde_json::json!({
            "contractVersion": "parallel-v1", "requestId": "request-1",
            "scope": {
                "accountId": "account-1", "targetId": "target-1", "workspaceId": null,
                "identityGeneration": "generation-1", "targetRevision": "revision-1"
            },
            "timeoutMs": 1000, "payload": {}
        });
        let request: IntegrationRequest = serde_json::from_value(value.clone()).unwrap();
        request.validate(false).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), value);
    }

    #[test]
    fn contract_slots_do_not_advertise_unimplemented_business_features() {
        let capabilities = crate::ServerCapabilities::default();
        for name in [
            "assistantProfilesV1",
            "channelControlV1",
            "channelTaskV1",
            "knowledgePublicationsV1",
        ] {
            assert_ne!(capabilities.experimental.get(name), Some(&true));
        }
    }
}
