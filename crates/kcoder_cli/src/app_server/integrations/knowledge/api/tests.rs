use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
struct Policy(IntegrationPolicyDecision);
impl KnowledgePolicyEvaluator for Policy {
    fn evaluate_action(
        &self,
        _: &IntegrationScope,
        _: &str,
        _: &KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        Ok(IntegrationPolicyEvaluation {
            decision: self.0,
            policy_revision: "current-policy".into(),
            reason_code: "fixture".into(),
        })
    }
}
fn request() -> IntegrationRequest {
    serde_json::from_value(json!({"contractVersion":"parallel-v1","requestId":"r","scope":{"accountId":"a","targetId":"t","workspaceId":null,"identityGeneration":"g","targetRevision":"v"},"operationId":"op","timeoutMs":1000,"payload":{}})).unwrap()
}
fn resource(scope: &IntegrationScope) -> KnowledgeResource {
    KnowledgeResource {
        kind: "memory",
        id: "owned".into(),
        owner: scope.into(),
    }
}
#[test]
fn uppercase_untrusted_private_errors_never_cross_public_boundary() {
    let r = request();
    let p = Policy(IntegrationPolicyDecision::Allow);
    let c = KnowledgeHostContext {
        scope: &r.scope,
        now_ms: 1000,
        explicit_user_action: true,
        policy: &p,
    };
    let result = dispatch(&r, &c, false, "memory.read", resource(&r.scope), || {
        anyhow::bail!("UPPERCASE_PRIVATE_CREDENTIAL_123456789")
    });
    let text = serde_json::to_string(&result).unwrap();
    assert!(!text.contains("UPPERCASE_PRIVATE"));
    assert_eq!(
        result.error.as_ref().unwrap().code,
        "KNOWLEDGE_OPERATION_UNAVAILABLE"
    );
}
#[test]
fn post_publication_unknown_is_reconcile_original() {
    let r = request();
    let p = Policy(IntegrationPolicyDecision::Allow);
    let c = KnowledgeHostContext {
        scope: &r.scope,
        now_ms: 1000,
        explicit_user_action: true,
        policy: &p,
    };
    for code in [
        "MEMORY_WRITE_UNCONFIRMED",
        "AUTOMATION_WRITE_UNCONFIRMED",
        "MEMORY_INITIALIZATION_UNCONFIRMED",
    ] {
        let result = dispatch(&r, &c, true, "memory.write", resource(&r.scope), || {
            anyhow::bail!(code)
        });
        assert_eq!(result.status, IntegrationStatus::Unknown);
        assert_eq!(
            result.error.as_ref().unwrap().recovery,
            IntegrationRecovery::ReconcileOriginal
        );
    }
}
#[test]
fn invalid_native_clock_is_rejected_before_side_effect_with_real_observation_time() {
    let r = request();
    let p = Policy(IntegrationPolicyDecision::Allow);
    let called = AtomicBool::new(false);
    let c = KnowledgeHostContext {
        scope: &r.scope,
        now_ms: u64::MAX,
        explicit_user_action: true,
        policy: &p,
    };
    let result = dispatch(&r, &c, true, "memory.write", resource(&r.scope), || {
        called.store(true, Ordering::SeqCst);
        Ok((json!({"written":true}), None))
    });
    assert!(!called.load(Ordering::SeqCst));
    assert_eq!(result.status, IntegrationStatus::Rejected);
    assert_eq!(
        result.error.as_ref().unwrap().code,
        "KNOWLEDGE_INVALID_CLOCK"
    );
    assert!(!result.observed_at.starts_with("1970"));
}
#[test]
fn completed_policy_evaluation_with_deny_or_unknown_is_never_permission() {
    let r = request();
    let called = AtomicBool::new(false);
    for decision in [
        IntegrationPolicyDecision::Deny,
        IntegrationPolicyDecision::Unknown,
    ] {
        let p = Policy(decision);
        let c = KnowledgeHostContext {
            scope: &r.scope,
            now_ms: 1000,
            explicit_user_action: true,
            policy: &p,
        };
        let result = dispatch(&r, &c, false, "memory.read", resource(&r.scope), || {
            called.store(true, Ordering::SeqCst);
            Ok((json!({"private":true}), None))
        });
        assert!(!called.load(Ordering::SeqCst));
        assert!(result.result.as_ref().is_none());
    }
}

#[test]
fn authority_lost_during_write_keeps_the_original_operation_unknown() {
    struct RevocablePolicy(AtomicBool);

    impl KnowledgePolicyEvaluator for RevocablePolicy {
        fn evaluate_action(
            &self,
            scope: &IntegrationScope,
            action: &str,
            resource: &KnowledgeResource,
        ) -> Result<IntegrationPolicyEvaluation> {
            let decision = if self.0.load(Ordering::SeqCst) {
                IntegrationPolicyDecision::Deny
            } else {
                IntegrationPolicyDecision::Allow
            };
            Policy(decision).evaluate_action(scope, action, resource)
        }
    }

    let request = request();
    let policy = RevocablePolicy(AtomicBool::new(false));
    let context = KnowledgeHostContext {
        scope: &request.scope,
        now_ms: 1000,
        explicit_user_action: true,
        policy: &policy,
    };
    let result = dispatch(
        &request,
        &context,
        true,
        "memory.write",
        resource(&request.scope),
        || {
            assert!(!policy.0.swap(true, Ordering::SeqCst));
            Ok((json!({"written":true}), Some("revision".into())))
        },
    );

    assert_eq!(result.status, IntegrationStatus::Unknown);
    assert_eq!(result.request_id, request.request_id);
    assert_eq!(result.operation_id.as_ref(), request.operation_id.as_ref());
    assert!(result.result.as_ref().is_none());
    let error = result.error.as_ref().unwrap();
    assert_eq!(error.code, "KNOWLEDGE_AUTHORITY_CHANGED_AFTER_OPERATION");
    assert_eq!(error.recovery, IntegrationRecovery::ReconcileOriginal);
}
