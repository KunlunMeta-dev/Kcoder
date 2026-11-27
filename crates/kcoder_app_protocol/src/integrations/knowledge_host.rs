//! Finite native management RPC names; native capabilities and policy remain separate.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_KNOWLEDGE_PUBLICATIONS_V1: &str = "knowledgePublicationsV1";
pub const CAPABILITY_AUTOMATION_TEMPLATES_V1: &str = "automationTemplatesV1";
/// Optional persisted task model intent; a catalog or this flag grants no execution authority.
pub const CAPABILITY_AUTOMATION_TASK_MODELS_V1: &str = "automationTaskModelsV1";
/// Optional explicit finite subscription windows; this flag never grants budget authority.
pub const CAPABILITY_AUTOMATION_PERIOD_BUDGETS_V1: &str = "automationPeriodBudgetsV1";

macro_rules! native_methods {
    ($name:ident, $capability:ident, {$($variant:ident => ($wire:literal, $method:literal, $mutation:literal, $action:literal)),+ $(,)?}) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
        pub enum $name {
            $(#[serde(rename = $wire)] $variant),+
        }
        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
            pub fn parse(method: &str) -> Option<Self> {
                match method { $($wire => Some(Self::$variant),)+ _ => None }
            }
            pub const fn wire_name(self) -> &'static str {
                match self { $(Self::$variant => $wire),+ }
            }
            pub const fn port_method(self) -> &'static str {
                match self { $(Self::$variant => $method),+ }
            }
            pub const fn mutation(self) -> bool {
                match self { $(Self::$variant => $mutation),+ }
            }
            pub const fn is_read_only(self) -> bool { !self.mutation() }
            pub const fn requires_explicit_user_action(self) -> bool { self.mutation() }
            /// Admission action only; the domain also checks the concrete resource and current ACL.
            pub const fn action(self) -> &'static str {
                match self { $(Self::$variant => $action),+ }
            }
            pub const fn capability(self) -> &'static str { $capability }
        }
    };
}

native_methods!(IntegrationKnowledgeMethod, CAPABILITY_KNOWLEDGE_PUBLICATIONS_V1, {
    ListPublications => ("integrations/knowledge/listPublications", "listPublications", false, "knowledge.read"),
    ListPublicationHistory => ("integrations/knowledge/listPublicationHistory", "listPublicationHistory", false, "knowledge.read"),
    ListAdoptions => ("integrations/knowledge/listAdoptions", "listAdoptions", false, "knowledge.read"),
    ResolvePublication => ("integrations/knowledge/resolvePublication", "resolvePublication", false, "knowledge.read"),
    RetrieveKnowledge => ("integrations/knowledge/retrieveKnowledge", "retrieveKnowledge", false, "knowledge.read"),
    ReadCitation => ("integrations/knowledge/readCitation", "readCitation", false, "knowledge.read"),
    ReadPublicationSources => ("integrations/knowledge/readPublicationSources", "readPublicationSources", false, "knowledge.read"),
    PublishKnowledge => ("integrations/knowledge/publishKnowledge", "publishKnowledge", true, "knowledge.manage"),
    RevokePublication => ("integrations/knowledge/revokePublication", "revokePublication", true, "knowledge.manage"),
    AdoptPublication => ("integrations/knowledge/adoptPublication", "adoptPublication", true, "knowledge.manage"),
    SetAdoptionEnabled => ("integrations/knowledge/setAdoptionEnabled", "setAdoptionEnabled", true, "knowledge.manage"),
});

native_methods!(IntegrationAutomationMethod, CAPABILITY_AUTOMATION_TEMPLATES_V1, {
    ListTemplates => ("integrations/automation/listTemplates", "listTemplates", false, "automation.read"),
    PreviewSubscription => ("integrations/automation/previewSubscription", "previewSubscription", false, "automation.read"),
    ListSubscriptions => ("integrations/automation/listSubscriptions", "listSubscriptions", false, "automation.read"),
    ListAutomationRuns => ("integrations/automation/listAutomationRuns", "listAutomationRuns", false, "automation.read"),
    ListConnectionEventSources => ("integrations/automation/listConnectionEventSources", "listConnectionEventSources", false, "automation.read"),
    ListQuarantinedEvents => ("integrations/automation/listQuarantinedEvents", "listQuarantinedEvents", false, "automation.read"),
    ReadAutomationRun => ("integrations/automation/readAutomationRun", "readAutomationRun", false, "automation.read"),
    ReadAutomationArtifacts => ("integrations/automation/readAutomationArtifacts", "readAutomationArtifacts", false, "automation.read"),
    ReadAutomationClaims => ("integrations/automation/readAutomationClaims", "readAutomationClaims", false, "automation.read"),
    SelectApplicationEventSource => ("integrations/automation/selectApplicationEventSource", "selectApplicationEventSource", true, "automation.configure"),
    SelectFileEventSource => ("integrations/automation/selectFileEventSource", "selectFileEventSource", true, "automation.configure"),
    SaveSubscription => ("integrations/automation/saveSubscription", "saveSubscription", true, "automation.configure"),
    SetSubscriptionEnabled => ("integrations/automation/setSubscriptionEnabled", "setSubscriptionEnabled", true, "automation.configure"),
    RemoveSubscription => ("integrations/automation/removeSubscription", "removeSubscription", true, "automation.configure"),
    HideAutomationRun => ("integrations/automation/hideAutomationRun", "hideAutomationRun", true, "automation.configure"),
    CancelAutomationRun => ("integrations/automation/cancelAutomationRun", "cancelAutomationRun", true, "automation.cancel"),
    CancelAutomationDelivery => ("integrations/automation/cancelAutomationDelivery", "cancelAutomationDelivery", true, "automation.deliver"),
    ReconcileAutomationDelivery => ("integrations/automation/reconcileAutomationDelivery", "reconcileAutomationDelivery", true, "automation.deliver"),
});

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finite_wire_names_roundtrip_and_preserve_read_only_and_action_metadata() {
        let mut names = std::collections::HashSet::new();
        let mut writes = 0;
        for &method in IntegrationKnowledgeMethod::ALL {
            assert!(names.insert(method.wire_name()));
            assert_eq!(
                IntegrationKnowledgeMethod::parse(method.wire_name()),
                Some(method)
            );
            let wire = serde_json::to_value(method).unwrap();
            assert_eq!(wire, method.wire_name());
            assert_eq!(
                serde_json::from_value::<IntegrationKnowledgeMethod>(wire).unwrap(),
                method
            );
            assert_eq!(
                method.wire_name(),
                format!("integrations/knowledge/{}", method.port_method())
            );
            assert_eq!(method.is_read_only(), !method.mutation());
            assert_eq!(method.requires_explicit_user_action(), method.mutation());
            assert_eq!(method.capability(), CAPABILITY_KNOWLEDGE_PUBLICATIONS_V1);
            assert!(method.action().starts_with("knowledge."));
            writes += usize::from(method.mutation());
        }
        for &method in IntegrationAutomationMethod::ALL {
            assert!(names.insert(method.wire_name()));
            assert_eq!(
                IntegrationAutomationMethod::parse(method.wire_name()),
                Some(method)
            );
            let wire = serde_json::to_value(method).unwrap();
            assert_eq!(wire, method.wire_name());
            assert_eq!(
                serde_json::from_value::<IntegrationAutomationMethod>(wire).unwrap(),
                method
            );
            assert_eq!(
                method.wire_name(),
                format!("integrations/automation/{}", method.port_method())
            );
            assert_eq!(method.is_read_only(), !method.mutation());
            assert_eq!(method.requires_explicit_user_action(), method.mutation());
            assert_eq!(method.capability(), CAPABILITY_AUTOMATION_TEMPLATES_V1);
            assert!(method.action().starts_with("automation."));
            writes += usize::from(method.mutation());
        }
        assert_eq!((names.len(), writes), (29, 13));
        for forbidden in [
            "integrations/automation/triggerApprovedSubscription",
            "integrations/automation/recordArtifactClaim",
            "integrations/knowledge/evaluatePolicy",
            "listPublications",
        ] {
            assert!(IntegrationKnowledgeMethod::parse(forbidden).is_none());
            assert!(IntegrationAutomationMethod::parse(forbidden).is_none());
            assert!(
                serde_json::from_value::<IntegrationKnowledgeMethod>(serde_json::json!(forbidden))
                    .is_err()
            );
            assert!(
                serde_json::from_value::<IntegrationAutomationMethod>(serde_json::json!(forbidden))
                    .is_err()
            );
        }
    }
}
