//! Host-owned authority; serialized scope fields are never sufficient permission.
use kcoder_types::integrations::core::{
    IntegrationOwner, IntegrationPolicyDecision, IntegrationPolicyEvaluation, IntegrationScope,
};
use std::collections::BTreeSet;
use std::sync::{Arc, RwLock, Weak};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct IntegrationResourceRule {
    pub action: String,
    pub resource: String,
}

struct Snapshot {
    scope: IntegrationScope,
    policy_revision: String,
    rules: BTreeSet<IntegrationResourceRule>,
    enabled: bool,
    authority_revision: u64,
}

struct AuthorityState {
    current: RwLock<Snapshot>,
}

/// Created only by a trusted host after native account and target authentication.
/// No serde implementation exists: RPC input cannot construct this authority.
#[derive(Clone)]
pub struct IntegrationAuthority {
    state: Arc<AuthorityState>,
}

/// An in-process, non-serializable permission bound to one authority generation.
pub struct IntegrationPermit {
    authority: Weak<AuthorityState>,
    scope: IntegrationScope,
    authority_revision: u64,
    action: String,
    resource: String,
}

impl IntegrationAuthority {
    pub fn from_authenticated_host(
        scope: IntegrationScope,
        policy_revision: String,
        rules: BTreeSet<IntegrationResourceRule>,
    ) -> Result<Self, &'static str> {
        scope
            .validate()
            .map_err(|_| "invalid authenticated scope")?;
        validate_rules(&policy_revision, &rules)?;
        Ok(Self {
            state: Arc::new(AuthorityState {
                current: RwLock::new(Snapshot {
                    scope,
                    policy_revision,
                    rules,
                    enabled: true,
                    authority_revision: 1,
                }),
            }),
        })
    }

    pub fn evaluate_action(
        &self,
        requested: &IntegrationScope,
        action: &str,
        resource: &str,
    ) -> IntegrationPolicyEvaluation {
        match self.state.current.read() {
            Ok(snapshot) => evaluate(&snapshot, requested, action, resource),
            Err(_) => IntegrationPolicyEvaluation {
                decision: IntegrationPolicyDecision::Unknown,
                policy_revision: "unavailable".into(),
                reason_code: "policy_unavailable".into(),
            },
        }
    }

    pub fn authorize(
        &self,
        requested: &IntegrationScope,
        action: &str,
        resource: &str,
    ) -> Result<IntegrationPermit, IntegrationPolicyEvaluation> {
        let snapshot = self.state.current.read().map_err(|_| self.unavailable())?;
        let result = evaluate(&snapshot, requested, action, resource);
        if result.decision != IntegrationPolicyDecision::Allow {
            return Err(result);
        }
        Ok(IntegrationPermit {
            authority: Arc::downgrade(&self.state),
            scope: snapshot.scope.clone(),
            authority_revision: snapshot.authority_revision,
            action: action.into(),
            resource: resource.into(),
        })
    }

    /// Recheck before controlled work and again after asynchronous preparation.
    pub fn verify_permit(
        &self,
        permit: &IntegrationPermit,
    ) -> Result<(), IntegrationPolicyEvaluation> {
        let Some(origin) = permit.authority.upgrade() else {
            return Err(self.unavailable());
        };
        if !Arc::ptr_eq(&origin, &self.state) {
            return Err(IntegrationPolicyEvaluation {
                decision: IntegrationPolicyDecision::Deny,
                policy_revision: "unavailable".into(),
                reason_code: "permit_owner_mismatch".into(),
            });
        }
        let snapshot = self.state.current.read().map_err(|_| self.unavailable())?;
        let result = evaluate(&snapshot, &permit.scope, &permit.action, &permit.resource);
        if result.decision != IntegrationPolicyDecision::Allow
            || snapshot.authority_revision != permit.authority_revision
        {
            return Err(IntegrationPolicyEvaluation {
                decision: IntegrationPolicyDecision::Deny,
                reason_code: "permit_revoked".into(),
                ..result
            });
        }
        Ok(())
    }

    pub fn revoke(&self) -> Result<(), &'static str> {
        let mut snapshot = self
            .state
            .current
            .write()
            .map_err(|_| "policy unavailable")?;
        snapshot.enabled = false;
        Ok(())
    }

    /// Only the authenticated host may refresh a principal's current policy facts.
    pub fn refresh_from_authenticated_host(
        &self,
        scope: IntegrationScope,
        policy_revision: String,
        rules: BTreeSet<IntegrationResourceRule>,
    ) -> Result<(), &'static str> {
        scope
            .validate()
            .map_err(|_| "invalid authenticated scope")?;
        validate_rules(&policy_revision, &rules)?;
        let mut snapshot = self
            .state
            .current
            .write()
            .map_err(|_| "policy unavailable")?;
        if IntegrationOwner::from(&snapshot.scope) != IntegrationOwner::from(&scope) {
            return Err("cannot replace an authority's owner");
        }
        let revision = snapshot
            .authority_revision
            .checked_add(1)
            .ok_or("authority revision overflow")?;
        *snapshot = Snapshot {
            scope,
            policy_revision,
            rules,
            enabled: true,
            authority_revision: revision,
        };
        Ok(())
    }

    fn unavailable(&self) -> IntegrationPolicyEvaluation {
        IntegrationPolicyEvaluation {
            decision: IntegrationPolicyDecision::Unknown,
            policy_revision: "unavailable".into(),
            reason_code: "policy_unavailable".into(),
        }
    }
}

fn evaluate(
    snapshot: &Snapshot,
    requested: &IntegrationScope,
    action: &str,
    resource: &str,
) -> IntegrationPolicyEvaluation {
    let reason = if requested.validate().is_err() {
        "invalid_scope"
    } else if !snapshot.enabled {
        "identity_revoked"
    } else if IntegrationOwner::from(requested) != IntegrationOwner::from(&snapshot.scope) {
        "scope_mismatch"
    } else if requested.identity_generation != snapshot.scope.identity_generation {
        "identity_generation_changed"
    } else if requested.target_revision != snapshot.scope.target_revision {
        "target_configuration_changed"
    } else if !snapshot.rules.contains(&IntegrationResourceRule {
        action: action.into(),
        resource: resource.into(),
    }) {
        "resource_denied"
    } else {
        "allowed"
    };
    IntegrationPolicyEvaluation {
        decision: if reason == "allowed" {
            IntegrationPolicyDecision::Allow
        } else {
            IntegrationPolicyDecision::Deny
        },
        policy_revision: snapshot.policy_revision.clone(),
        reason_code: reason.into(),
    }
}

fn validate_rules(
    revision: &str,
    rules: &BTreeSet<IntegrationResourceRule>,
) -> Result<(), &'static str> {
    if revision.is_empty() || revision.chars().count() > 256 {
        return Err("invalid policy revision");
    }
    if rules.len() > 4096
        || rules.iter().any(|r| {
            r.action.is_empty()
                || r.action.len() > 128
                || r.action.contains('*')
                || r.resource.is_empty()
                || r.resource.chars().count() > 256
        })
    {
        return Err("invalid integration resource rules");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::integrations::core::IntegrationNullable;

    fn scope() -> IntegrationScope {
        IntegrationScope {
            account_id: "account-1".into(),
            target_id: "target-1".into(),
            workspace_id: IntegrationNullable::Value("workspace-1".into()),
            identity_generation: "generation-1".into(),
            target_revision: "revision-1".into(),
            organization_id: None,
        }
    }

    fn rules() -> BTreeSet<IntegrationResourceRule> {
        [IntegrationResourceRule {
            action: "artifact.read".into(),
            resource: "artifact-1".into(),
        }]
        .into_iter()
        .collect()
    }

    fn authority() -> IntegrationAuthority {
        IntegrationAuthority::from_authenticated_host(scope(), "policy-1".into(), rules()).unwrap()
    }

    #[test]
    fn scope_and_similar_names_do_not_grant_access() {
        let auth = authority();
        assert_eq!(
            auth.evaluate_action(&scope(), "artifact.read", "artifact-1")
                .decision,
            IntegrationPolicyDecision::Allow
        );
        assert_eq!(
            auth.evaluate_action(&scope(), "artifact.write", "artifact-1")
                .decision,
            IntegrationPolicyDecision::Deny
        );
        assert_eq!(
            auth.evaluate_action(&scope(), "artifact.read", "artifact-10")
                .decision,
            IntegrationPolicyDecision::Deny
        );
    }

    #[test]
    fn account_target_workspace_and_generation_are_fenced() {
        let auth = authority();
        for field in ["account", "target", "workspace", "generation", "revision"] {
            let mut requested = scope();
            match field {
                "account" => requested.account_id = "other".into(),
                "target" => requested.target_id = "other".into(),
                "workspace" => requested.workspace_id = IntegrationNullable::Null,
                "generation" => requested.identity_generation = "other".into(),
                _ => requested.target_revision = "other".into(),
            }
            assert_eq!(
                auth.evaluate_action(&requested, "artifact.read", "artifact-1")
                    .decision,
                IntegrationPolicyDecision::Deny
            );
        }
    }

    #[test]
    fn revocation_reaches_existing_clones_and_in_flight_permits() {
        let auth = authority();
        let clone = auth.clone();
        let permit = clone
            .authorize(&scope(), "artifact.read", "artifact-1")
            .unwrap_or_else(|_| panic!("expected valid permit"));
        auth.verify_permit(&permit).unwrap();
        auth.revoke().unwrap();
        assert_eq!(
            clone
                .evaluate_action(&scope(), "artifact.read", "artifact-1")
                .reason_code,
            "identity_revoked"
        );
        assert!(clone.verify_permit(&permit).is_err());
    }

    #[test]
    fn permit_cannot_be_transferred_to_another_authority() {
        let a = authority();
        let b = authority();
        let permit = a
            .authorize(&scope(), "artifact.read", "artifact-1")
            .unwrap_or_else(|_| panic!("expected permit"));
        assert!(b.verify_permit(&permit).is_err());
    }

    #[test]
    fn refresh_invalidates_old_permits_even_when_public_revision_was_unchanged() {
        let auth = authority();
        let permit = auth
            .authorize(&scope(), "artifact.read", "artifact-1")
            .unwrap_or_else(|_| panic!("expected permit"));
        auth.refresh_from_authenticated_host(scope(), "policy-1".into(), rules())
            .unwrap();
        assert!(auth.verify_permit(&permit).is_err());
        assert!(
            auth.authorize(&scope(), "artifact.read", "artifact-1")
                .is_ok()
        );
    }

    #[test]
    fn refresh_cannot_replace_the_principal() {
        let auth = authority();
        let mut other = scope();
        other.account_id = "other".into();
        assert!(
            auth.refresh_from_authenticated_host(other, "policy-2".into(), rules())
                .is_err()
        );
        assert_eq!(
            auth.evaluate_action(&scope(), "artifact.read", "artifact-1")
                .decision,
            IntegrationPolicyDecision::Allow
        );
    }
}
