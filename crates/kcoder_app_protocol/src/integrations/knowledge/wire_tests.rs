use super::*;
#[test]
fn knowledge_contract_fixtures_match_real_serde_contracts() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json"
    ))
    .unwrap();
    macro_rules! check {
        ($name:literal,$ty:ty) => {
            check!($name, $ty, fixtures);
        };
        ($name:literal,$ty:ty,$collection:ident) => {{
            for case in $collection[$name]["valid"].as_array().unwrap() {
                assert!(
                    serde_json::from_value::<$ty>(case["value"].clone()).is_ok(),
                    "valid fixture {}",
                    case["name"]
                );
            }
            for case in $collection[$name]["invalid"].as_array().unwrap() {
                assert!(
                    serde_json::from_value::<$ty>(case["value"].clone()).is_err(),
                    "invalid fixture {}",
                    case["name"]
                );
            }
        }};
    }
    check!("MemoryOrigin", MemoryOrigin);
    check!("MemoryReviewStatus", MemoryReviewStatus);
    check!("MemoryProvenance", MemoryProvenance);
    check!("MemoryProposal", MemoryProposal);
    check!("ReviewedMemory", ReviewedMemory);
    check!("MemoryReview", MemoryReview);
    check!("MemoryTaskSnapshot", MemoryTaskSnapshot);
    check!("KnowledgeVisibility", KnowledgeVisibility);
    check!("PublicationSource", PublicationSource);
    check!("PublicationDraft", PublicationDraft);
    check!("PublishedKnowledgePage", PublishedKnowledgePage);
    check!("KnowledgePublication", KnowledgePublication);
    check!("PublicationHit", PublicationHit);
    check!("KnowledgeRetrievalOutcome", KnowledgeRetrievalOutcome);
    check!("KnowledgeRetrieval", KnowledgeRetrieval);
    check!("AutomationSubscriptionDraft", AutomationSubscriptionDraft);
    check!("AutomationDestination", AutomationDestination);
    check!("AutomationSubscription", AutomationSubscription);
    check!("AutomationRunStatus", AutomationRunStatus);
    check!("AutomationDeliveryStatus", AutomationDeliveryStatus);
    check!("AutomationRun", AutomationRun);
    check!("MemoryListParams", MemoryListParams);
    check!("MemoryReadParams", MemoryReadParams);
    check!("MemoryProposeParams", MemoryProposeParams);
    check!("MemoryReviewParams", MemoryReviewParams);
    check!("MemoryEnableParams", MemoryEnableParams);
    check!("MemoryEditParams", MemoryEditParams);
    check!("PublicationReadParams", PublicationReadParams);
    check!("KnowledgeRetrieveParams", KnowledgeRetrieveParams);
    check!("CitationReadParams", CitationReadParams);
    check!("KnowledgePublishParams", KnowledgePublishParams);
    check!("KnowledgeRevokeParams", KnowledgeRevokeParams);
    check!("SubscriptionSaveParams", SubscriptionSaveParams);
    check!("SubscriptionEnableParams", SubscriptionEnableParams);
    check!("AutomationRunReadParams", AutomationRunReadParams);
    check!("AutomationTriggerParams", AutomationTriggerParams);
    check!("MemoryListResult", MemoryListResult);
    check!("MemoryReadResult", MemoryReadResult);
    check!("PublicationListResult", PublicationListResult);
    check!("PublicationReadResult", PublicationReadResult);
    check!("KnowledgeRetrieveResult", KnowledgeRetrieveResult);
    check!("CitationReadResult", CitationReadResult);
    check!("SubscriptionListResult", SubscriptionListResult);
    check!("SubscriptionReadResult", SubscriptionReadResult);
    check!("AutomationRunListResult", AutomationRunListResult);
    check!("AutomationQuarantinedEvent", AutomationQuarantinedEvent);
    check!(
        "AutomationConnectionEventSource",
        AutomationConnectionEventSource
    );
    check!(
        "AutomationConnectionEventSourceState",
        AutomationConnectionEventSourceState
    );
    check!(
        "AutomationConnectionEventSourceListResult",
        AutomationConnectionEventSourceListResult
    );
    check!(
        "AutomationQuarantineListResult",
        AutomationQuarantineListResult
    );
    let application_fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../tests/fixtures/integrations/knowledge/application-resource-fixtures.json"
    ))
    .unwrap();
    check!(
        "AutomationApplicationSelectionParams",
        AutomationApplicationSelectionParams,
        application_fixtures
    );
    check!(
        "AutomationApplicationSelectionReceipt",
        AutomationApplicationSelectionReceipt,
        application_fixtures
    );
    check!("AutomationRunReadResult", AutomationRunReadResult);
    check!("KnowledgeAdoption", KnowledgeAdoption);
    check!("AutomationTemplate", AutomationTemplate);
    check!("KnowledgeAdoptParams", KnowledgeAdoptParams);
    check!(
        "KnowledgeAdoptionEnableParams",
        KnowledgeAdoptionEnableParams
    );
    check!("KnowledgeAdoptionResult", KnowledgeAdoptionResult);
    check!("KnowledgeAdoptionListResult", KnowledgeAdoptionListResult);
    check!("AutomationTemplateListResult", AutomationTemplateListResult);
    check!("KnowledgePublicationSummary", KnowledgePublicationSummary);
    check!("PublicationHistoryListResult", PublicationHistoryListResult);
    check!("AutomationArtifactClaim", AutomationArtifactClaim);
    check!("AutomationClaimListResult", AutomationClaimListResult);
    check!("KnowledgeSourceObservation", KnowledgeSourceObservation);
    check!("PublicationSourcesReadParams", PublicationSourcesReadParams);
    check!("PublicationSourcesReadResult", PublicationSourcesReadResult);
}
