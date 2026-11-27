//! A closed diagnostic set prevents backend or parser text becoming public errors.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum MigrationSourceCredentialError {
    #[serde(rename = "private_credentials_plan_already_bound")]
    PrivateCredentialsPlanAlreadyBound,
    #[serde(rename = "private_credentials_plan_changed")]
    PrivateCredentialsPlanChanged,
    #[serde(rename = "private_credentials_source_ambiguous")]
    PrivateCredentialsSourceAmbiguous,

    #[serde(rename = "migration_target_controlled_by_overlay")]
    MigrationTargetControlledByOverlay,
    #[serde(rename = "migration_wrong_target")]
    MigrationWrongTarget,
    #[serde(rename = "migration_invalid_transition")]
    MigrationInvalidTransition,
    #[serde(rename = "migration_batch_plan_required")]
    MigrationBatchPlanRequired,
    #[serde(rename = "migration_revision_conflict")]
    MigrationRevisionConflict,
    #[serde(rename = "migration_credential_target_required")]
    MigrationCredentialTargetRequired,
    #[serde(rename = "migration_credential_destination_mismatch")]
    MigrationCredentialDestinationMismatch,
    #[serde(rename = "migration_mcp_private_destination_changed")]
    MigrationMcpPrivateDestinationChanged,
    #[serde(rename = "private_credentials_saved_plan_required")]
    PrivateCredentialsSavedPlanRequired,

    #[serde(rename = "private_credentials_selector_unavailable")]
    PrivateCredentialsSelectorUnavailable,
    #[serde(rename = "private_credentials_invalid_page")]
    PrivateCredentialsInvalidPage,
    #[serde(rename = "private_credentials_update_required")]
    PrivateCredentialsUpdateRequired,
    #[serde(rename = "private_credentials_outcome_unknown")]
    PrivateCredentialsOutcomeUnknown,
    #[serde(rename = "private_credentials_invalid_response")]
    PrivateCredentialsInvalidResponse,
    #[serde(rename = "private_credentials_invalid_request")]
    PrivateCredentialsInvalidRequest,
    #[serde(rename = "migration_configuration_layers_mcp_unsupported")]
    MigrationConfigurationLayersMcpUnsupported,
    #[serde(rename = "migration_credential_authentication_unsupported")]
    MigrationCredentialAuthenticationUnsupported,
    #[serde(rename = "migration_credential_invalid_api_key")]
    MigrationCredentialInvalidApiKey,
    #[serde(rename = "migration_credential_key_missing")]
    MigrationCredentialKeyMissing,
    #[serde(rename = "migration_credential_source_not_declared")]
    MigrationCredentialSourceNotDeclared,
    #[serde(rename = "migration_mcp_private_expansion_unsupported")]
    MigrationMcpPrivateExpansionUnsupported,
    #[serde(rename = "migration_mcp_private_source_ambiguous")]
    MigrationMcpPrivateSourceAmbiguous,
    #[serde(rename = "migration_mcp_private_source_invalid")]
    MigrationMcpPrivateSourceInvalid,
    #[serde(rename = "migration_mcp_private_source_missing")]
    MigrationMcpPrivateSourceMissing,
    #[serde(rename = "private_credentials_authentication_failed")]
    PrivateCredentialsAuthenticationFailed,
    #[serde(rename = "private_credentials_authority_changed")]
    PrivateCredentialsAuthorityChanged,
    #[serde(rename = "private_credentials_binding_changed")]
    PrivateCredentialsBindingChanged,
    #[serde(rename = "private_credentials_budget_exceeded")]
    PrivateCredentialsBudgetExceeded,
    #[serde(rename = "private_credentials_busy")]
    PrivateCredentialsBusy,
    #[serde(rename = "private_credentials_crypto_failed")]
    PrivateCredentialsCryptoFailed,
    #[serde(rename = "private_credentials_destination_mismatch")]
    PrivateCredentialsDestinationMismatch,
    #[serde(rename = "private_credentials_duplicate_selection")]
    PrivateCredentialsDuplicateSelection,
    #[serde(rename = "private_credentials_envelope_changed")]
    PrivateCredentialsEnvelopeChanged,
    #[serde(rename = "private_credentials_explicit_consent_required")]
    PrivateCredentialsExplicitConsentRequired,
    #[serde(rename = "private_credentials_field_not_declared")]
    PrivateCredentialsFieldNotDeclared,
    #[serde(rename = "private_credentials_field_set_changed")]
    PrivateCredentialsFieldSetChanged,
    #[serde(rename = "private_credentials_file_fallback_forbidden")]
    PrivateCredentialsFileFallbackForbidden,
    #[serde(rename = "private_credentials_invalid_binding")]
    PrivateCredentialsInvalidBinding,
    #[serde(rename = "private_credentials_invalid_destination")]
    PrivateCredentialsInvalidDestination,
    #[serde(rename = "private_credentials_invalid_envelope")]
    PrivateCredentialsInvalidEnvelope,
    #[serde(rename = "private_credentials_invalid_key")]
    PrivateCredentialsInvalidKey,
    #[serde(rename = "private_credentials_invalid_metadata")]
    PrivateCredentialsInvalidMetadata,
    #[serde(rename = "private_credentials_invalid_milestone")]
    PrivateCredentialsInvalidMilestone,
    #[serde(rename = "private_credentials_invalid_offer")]
    PrivateCredentialsInvalidOffer,
    #[serde(rename = "private_credentials_invalid_payload")]
    PrivateCredentialsInvalidPayload,
    #[serde(rename = "private_credentials_invalid_role")]
    PrivateCredentialsInvalidRole,
    #[serde(rename = "private_credentials_invalid_selection")]
    PrivateCredentialsInvalidSelection,
    #[serde(rename = "private_credentials_invalid_source")]
    PrivateCredentialsInvalidSource,
    #[serde(rename = "private_credentials_key_unknown")]
    PrivateCredentialsKeyUnknown,
    #[serde(rename = "private_credentials_keyring_unavailable")]
    PrivateCredentialsKeyringUnavailable,
    #[serde(rename = "private_credentials_noncanonical_fields")]
    PrivateCredentialsNoncanonicalFields,
    #[serde(rename = "private_credentials_operation_limit")]
    PrivateCredentialsOperationLimit,
    #[serde(rename = "private_credentials_owner_unknown")]
    PrivateCredentialsOwnerUnknown,
    #[serde(rename = "private_credentials_policy_changed")]
    PrivateCredentialsPolicyChanged,
    #[serde(rename = "private_credentials_previous_publication_unknown")]
    PrivateCredentialsPreviousPublicationUnknown,
    #[serde(rename = "private_credentials_project_scope_unsupported")]
    PrivateCredentialsProjectScopeUnsupported,
    #[serde(rename = "private_credentials_publication_binding_changed")]
    PrivateCredentialsPublicationBindingChanged,
    #[serde(rename = "private_credentials_preparation_pending")]
    PrivateCredentialsPreparationPending,
    #[serde(rename = "private_credentials_publication_unknown")]
    PrivateCredentialsPublicationUnknown,
    #[serde(rename = "private_credentials_publication_unsettled")]
    PrivateCredentialsPublicationUnsettled,
    #[serde(rename = "private_credentials_receive_unconfirmed")]
    PrivateCredentialsReceiveUnconfirmed,
    #[serde(rename = "private_credentials_source_not_selected")]
    PrivateCredentialsSourceNotSelected,
    #[serde(rename = "private_credentials_storage_unavailable")]
    PrivateCredentialsStorageUnavailable,
    #[serde(rename = "private_credentials_suite_unsupported")]
    PrivateCredentialsSuiteUnsupported,
    #[serde(rename = "private_credentials_unavailable")]
    PrivateCredentialsUnavailable,
    #[serde(rename = "private_credentials_version_unsupported")]
    PrivateCredentialsVersionUnsupported,
    #[serde(rename = "private_credentials_wrong_consumer")]
    PrivateCredentialsWrongConsumer,
}

impl MigrationSourceCredentialError {
    pub fn code(self) -> &'static str {
        match self {
            Self::PrivateCredentialsPlanAlreadyBound => "private_credentials_plan_already_bound",
            Self::PrivateCredentialsPlanChanged => "private_credentials_plan_changed",
            Self::PrivateCredentialsSourceAmbiguous => "private_credentials_source_ambiguous",

            Self::MigrationTargetControlledByOverlay => "migration_target_controlled_by_overlay",
            Self::MigrationWrongTarget => "migration_wrong_target",
            Self::MigrationInvalidTransition => "migration_invalid_transition",
            Self::MigrationBatchPlanRequired => "migration_batch_plan_required",
            Self::MigrationRevisionConflict => "migration_revision_conflict",
            Self::MigrationCredentialTargetRequired => "migration_credential_target_required",
            Self::MigrationCredentialDestinationMismatch => {
                "migration_credential_destination_mismatch"
            }
            Self::MigrationMcpPrivateDestinationChanged => {
                "migration_mcp_private_destination_changed"
            }
            Self::PrivateCredentialsSavedPlanRequired => "private_credentials_saved_plan_required",

            Self::PrivateCredentialsSelectorUnavailable => {
                "private_credentials_selector_unavailable"
            }
            Self::PrivateCredentialsInvalidPage => "private_credentials_invalid_page",
            Self::PrivateCredentialsUpdateRequired => "private_credentials_update_required",
            Self::PrivateCredentialsOutcomeUnknown => "private_credentials_outcome_unknown",
            Self::PrivateCredentialsInvalidResponse => "private_credentials_invalid_response",
            Self::PrivateCredentialsInvalidRequest => "private_credentials_invalid_request",
            Self::MigrationConfigurationLayersMcpUnsupported => {
                "migration_configuration_layers_mcp_unsupported"
            }
            Self::MigrationCredentialAuthenticationUnsupported => {
                "migration_credential_authentication_unsupported"
            }
            Self::MigrationCredentialInvalidApiKey => "migration_credential_invalid_api_key",
            Self::MigrationCredentialKeyMissing => "migration_credential_key_missing",
            Self::MigrationCredentialSourceNotDeclared => {
                "migration_credential_source_not_declared"
            }
            Self::MigrationMcpPrivateExpansionUnsupported => {
                "migration_mcp_private_expansion_unsupported"
            }
            Self::MigrationMcpPrivateSourceAmbiguous => "migration_mcp_private_source_ambiguous",
            Self::MigrationMcpPrivateSourceInvalid => "migration_mcp_private_source_invalid",
            Self::MigrationMcpPrivateSourceMissing => "migration_mcp_private_source_missing",
            Self::PrivateCredentialsAuthenticationFailed => {
                "private_credentials_authentication_failed"
            }
            Self::PrivateCredentialsAuthorityChanged => "private_credentials_authority_changed",
            Self::PrivateCredentialsBindingChanged => "private_credentials_binding_changed",
            Self::PrivateCredentialsBudgetExceeded => "private_credentials_budget_exceeded",
            Self::PrivateCredentialsBusy => "private_credentials_busy",
            Self::PrivateCredentialsCryptoFailed => "private_credentials_crypto_failed",
            Self::PrivateCredentialsDestinationMismatch => {
                "private_credentials_destination_mismatch"
            }
            Self::PrivateCredentialsDuplicateSelection => "private_credentials_duplicate_selection",
            Self::PrivateCredentialsEnvelopeChanged => "private_credentials_envelope_changed",
            Self::PrivateCredentialsExplicitConsentRequired => {
                "private_credentials_explicit_consent_required"
            }
            Self::PrivateCredentialsFieldNotDeclared => "private_credentials_field_not_declared",
            Self::PrivateCredentialsFieldSetChanged => "private_credentials_field_set_changed",
            Self::PrivateCredentialsFileFallbackForbidden => {
                "private_credentials_file_fallback_forbidden"
            }
            Self::PrivateCredentialsInvalidBinding => "private_credentials_invalid_binding",
            Self::PrivateCredentialsInvalidDestination => "private_credentials_invalid_destination",
            Self::PrivateCredentialsInvalidEnvelope => "private_credentials_invalid_envelope",
            Self::PrivateCredentialsInvalidKey => "private_credentials_invalid_key",
            Self::PrivateCredentialsInvalidMetadata => "private_credentials_invalid_metadata",
            Self::PrivateCredentialsInvalidMilestone => "private_credentials_invalid_milestone",
            Self::PrivateCredentialsInvalidOffer => "private_credentials_invalid_offer",
            Self::PrivateCredentialsInvalidPayload => "private_credentials_invalid_payload",
            Self::PrivateCredentialsInvalidRole => "private_credentials_invalid_role",
            Self::PrivateCredentialsInvalidSelection => "private_credentials_invalid_selection",
            Self::PrivateCredentialsInvalidSource => "private_credentials_invalid_source",
            Self::PrivateCredentialsKeyUnknown => "private_credentials_key_unknown",
            Self::PrivateCredentialsKeyringUnavailable => "private_credentials_keyring_unavailable",
            Self::PrivateCredentialsNoncanonicalFields => "private_credentials_noncanonical_fields",
            Self::PrivateCredentialsOperationLimit => "private_credentials_operation_limit",
            Self::PrivateCredentialsOwnerUnknown => "private_credentials_owner_unknown",
            Self::PrivateCredentialsPolicyChanged => "private_credentials_policy_changed",
            Self::PrivateCredentialsPreviousPublicationUnknown => {
                "private_credentials_previous_publication_unknown"
            }
            Self::PrivateCredentialsProjectScopeUnsupported => {
                "private_credentials_project_scope_unsupported"
            }
            Self::PrivateCredentialsPublicationBindingChanged => {
                "private_credentials_publication_binding_changed"
            }
            Self::PrivateCredentialsPreparationPending => "private_credentials_preparation_pending",
            Self::PrivateCredentialsPublicationUnknown => "private_credentials_publication_unknown",
            Self::PrivateCredentialsPublicationUnsettled => {
                "private_credentials_publication_unsettled"
            }
            Self::PrivateCredentialsReceiveUnconfirmed => "private_credentials_receive_unconfirmed",
            Self::PrivateCredentialsSourceNotSelected => "private_credentials_source_not_selected",
            Self::PrivateCredentialsStorageUnavailable => "private_credentials_storage_unavailable",
            Self::PrivateCredentialsSuiteUnsupported => "private_credentials_suite_unsupported",
            Self::PrivateCredentialsUnavailable => "private_credentials_unavailable",
            Self::PrivateCredentialsVersionUnsupported => "private_credentials_version_unsupported",
            Self::PrivateCredentialsWrongConsumer => "private_credentials_wrong_consumer",
        }
    }
}
