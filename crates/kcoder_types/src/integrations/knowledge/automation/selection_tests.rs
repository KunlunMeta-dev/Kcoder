use super::*;

const LEGACY: &str = r#"{"id":"legacy-source","title":"Explicit legacy schedule","workflowId":"fixed-workflow","workflowVersion":1,"inputs":{},"schedule":{"kind":"at","at":"2027-01-01T00:00:00Z"},"eventSource":null,"maximumTokens":5000,"maximumRuntimeSeconds":30,"delivery":{"kind":"studio"}}"#;

#[test]
fn missing_selection_keeps_exact_legacy_bytes_and_inherit_current() {
    let draft: AutomationSubscriptionDraft = serde_json::from_str(LEGACY).unwrap();
    assert!(draft.model_selection.is_none());
    assert_eq!(
        draft.effective_model_selection(),
        IntegrationModelSelectionIntent::InheritCurrent
    );
    assert_eq!(serde_json::to_string(&draft).unwrap(), LEGACY);
}

#[test]
fn only_explicit_typed_auto_policy_intent_is_preserved() {
    let mut legacy: Value = serde_json::from_str(LEGACY).unwrap();
    legacy["modelSelection"] = serde_json::json!({"kind":"auto_policy","id":"approved-pool","version":"fixed-policy-revision"});
    let draft: AutomationSubscriptionDraft = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(
        draft.effective_model_selection(),
        IntegrationModelSelectionIntent::AutoPolicy {
            id: "approved-pool".into(),
            version: "fixed-policy-revision".into()
        }
    );
    assert_eq!(serde_json::to_value(draft).unwrap(), legacy);
    legacy["modelSelection"]["grant"] = serde_json::json!(true);
    assert!(serde_json::from_value::<AutomationSubscriptionDraft>(legacy).is_err());
}
