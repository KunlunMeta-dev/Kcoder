//! Readable event facts and non-authoritative original identity candidates.
use super::control::{MAX_OPAQUE_TARGET_WEIGHT, opaque_weight};
use super::{WorkEvent, WorkEventState, WorkIdentity, WorkScope, atom};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

/// A source event may be observed before its work or workspace is resolved,
/// and a source may not supply a revision. All fields are facts to be
/// independently resolved by the target host, not native authorization.
///
/// This is a separate, opt-in wire shape: it must not be substituted for the
/// older [`WorkEvent`] when talking to a client that only knows that contract.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WorkEventFactV2 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<WorkScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work: Option<WorkIdentity>,
    pub event_id: String,
    /// Actual source kind and instance, when established by the native host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_instance_id: Option<String>,
    pub source_ref: String,
    /// None means the source revision was not observed, not an initial value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
    pub kind: String,
    pub state: WorkEventState,
    pub observed_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurred_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<String>,
    /// Preserve future top-level observations without interpreting them.
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

impl fmt::Debug for WorkEventFactV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkEventFactV2")
            .field("scope_present", &self.scope.is_some())
            .field("work_present", &self.work.is_some())
            .field("source_kind_present", &self.source_kind.is_some())
            .field(
                "source_instance_present",
                &self.source_instance_id.is_some(),
            )
            .field("source_revision_present", &self.source_revision.is_some())
            .field("state_known", &self.state.is_known())
            .field("occurred_at_present", &self.occurred_at_ms.is_some())
            .field("payload_ref_present", &self.payload_ref.is_some())
            .field("causation_id_present", &self.causation_id.is_some())
            .field("extension_count", &self.extensions.len())
            .finish_non_exhaustive()
    }
}

/// A lookup candidate, not a receipt, source witness, authorization or replay
/// decision. An adapter must verify the original source and all immutable
/// facts before it can recognize a replay. Conflicting kind, payload or work
/// association must not be silently treated as either replay or a new event.
///
/// When `source_revision` is absent, even equal candidates cannot establish a
/// duplicate unless the native adapter proves that each source change has its
/// own stable event ID. Differing candidate fields also do not prove different
/// source events when a previously unknown scope, source instance or revision
/// later becomes known.
/// Candidate values deliberately do not implement equality: comparing partially
/// observed fields must not become an implicit replay or new-event decision.
///
/// ```
/// use kcoder_integration_types::continuous_work::WorkEventIdentityCandidate;
/// fn inspect(candidate: WorkEventIdentityCandidate<'_>) { let _ = candidate.event_id; }
/// ```
///
/// ```compile_fail
/// use kcoder_integration_types::continuous_work::WorkEventIdentityCandidate;
/// fn incorrectly_classify(a: WorkEventIdentityCandidate<'_>, b: WorkEventIdentityCandidate<'_>) -> bool {
///     a != b
/// }
/// ```
#[derive(Clone, Copy)]
pub struct WorkEventIdentityCandidate<'a> {
    pub scope: Option<&'a WorkScope>,
    pub source_kind: Option<&'a str>,
    pub source_instance_id: Option<&'a str>,
    pub source_ref: &'a str,
    pub event_id: &'a str,
    pub source_revision: Option<&'a str>,
}

impl fmt::Debug for WorkEventIdentityCandidate<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkEventIdentityCandidate")
            .field("scope_present", &self.scope.is_some())
            .field("source_kind_present", &self.source_kind.is_some())
            .field(
                "source_instance_present",
                &self.source_instance_id.is_some(),
            )
            .field("source_revision_present", &self.source_revision.is_some())
            .finish_non_exhaustive()
    }
}

impl WorkEventFactV2 {
    /// Validate bounded representation and an optional saved association. This
    /// accepts unknown event kinds/states for observation; it cannot authorize
    /// processing or independently verify source, payload or work ownership.
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        if let Some(scope) = &self.scope {
            scope.validate_shape()?;
        }
        if let Some(work) = &self.work {
            work.validate_shape()?;
            if self
                .scope
                .as_ref()
                .is_none_or(|scope| !work.matches_scope(scope))
            {
                return Err("event and work scope mismatch");
            }
        }
        if [&self.event_id, &self.source_ref, &self.kind]
            .into_iter()
            .any(|value| !atom(value))
            || !atom(self.state.as_str())
            || self
                .source_kind
                .as_deref()
                .is_some_and(|value| !atom(value))
            || self
                .source_instance_id
                .as_deref()
                .is_some_and(|value| !atom(value))
            || self
                .source_revision
                .as_deref()
                .is_some_and(|value| !atom(value))
            || self
                .payload_ref
                .as_deref()
                .is_some_and(|value| !atom(value))
            || self
                .causation_id
                .as_deref()
                .is_some_and(|value| !atom(value))
            || self.extensions.len() > 64
        {
            return Err("invalid event identity or reference");
        }
        let mut extension_weight = 2usize;
        for (name, value) in &self.extensions {
            if !atom(name)
                || matches!(
                    name.as_str(),
                    "scope"
                        | "work"
                        | "eventId"
                        | "sourceKind"
                        | "sourceInstanceId"
                        | "sourceRef"
                        | "sourceRevision"
                        | "kind"
                        | "state"
                        | "observedAtMs"
                        | "occurredAtMs"
                        | "payloadRef"
                        | "causationId"
                )
            {
                return Err("invalid future event field");
            }
            extension_weight = extension_weight
                .checked_add(name.len().checked_mul(6).ok_or("event field too large")?)
                .and_then(|weight| weight.checked_add(4))
                .and_then(|weight| weight.checked_add(opaque_weight(value, 1)?))
                .ok_or("event field too large")?;
            if extension_weight > MAX_OPAQUE_TARGET_WEIGHT {
                return Err("event fields too large");
            }
        }
        Ok(())
    }

    /// Form only a candidate for the original event lookup. This performs no
    /// deduplication; payload and routing facts require separate reconciliation.
    pub fn identity_candidate(&self) -> Result<WorkEventIdentityCandidate<'_>, &'static str> {
        self.validate_shape()?;
        Ok(WorkEventIdentityCandidate {
            scope: self.scope.as_ref(),
            source_kind: self.source_kind.as_deref(),
            source_instance_id: self.source_instance_id.as_deref(),
            source_ref: &self.source_ref,
            event_id: &self.event_id,
            source_revision: self.source_revision.as_deref(),
        })
    }
}

impl From<WorkEvent> for WorkEventFactV2 {
    fn from(event: WorkEvent) -> Self {
        Self {
            scope: Some(event.work.scope.clone()),
            work: Some(event.work),
            event_id: event.event_id,
            source_kind: None,
            source_instance_id: None,
            source_ref: event.source_ref,
            source_revision: Some(event.source_revision),
            kind: event.kind,
            state: event.state,
            observed_at_ms: event.observed_at_ms,
            occurred_at_ms: event.occurred_at_ms,
            payload_ref: event.payload_ref,
            causation_id: event.causation_id,
            extensions: BTreeMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope() -> WorkScope {
        WorkScope {
            account_id: "account-a".into(),
            target_id: "target-a".into(),
            workspace_id: "workspace-a".into(),
        }
    }

    fn unbound() -> WorkEventFactV2 {
        WorkEventFactV2 {
            scope: None,
            work: None,
            event_id: "original-event".into(),
            source_kind: Some("platform".into()),
            source_instance_id: Some("instance-a".into()),
            source_ref: "original-conversation".into(),
            source_revision: None,
            kind: "message".into(),
            state: WorkEventState::Received,
            observed_at_ms: 42,
            occurred_at_ms: None,
            payload_ref: None,
            causation_id: None,
            extensions: BTreeMap::new(),
        }
    }

    /// Scope, source kind, source instance, source ref, event id, revision.
    type ObservedFields<'a> = (
        Option<&'a WorkScope>,
        Option<&'a str>,
        Option<&'a str>,
        &'a str,
        &'a str,
        Option<&'a str>,
    );

    fn observed_fields(candidate: WorkEventIdentityCandidate<'_>) -> ObservedFields<'_> {
        (
            candidate.scope,
            candidate.source_kind,
            candidate.source_instance_id,
            candidate.source_ref,
            candidate.event_id,
            candidate.source_revision,
        )
    }

    #[test]
    fn unbound_event_preserves_missing_revision_and_future_observations() {
        let mut raw = serde_json::to_value(unbound()).unwrap();
        assert!(raw.get("scope").is_none());
        assert!(raw.get("work").is_none());
        assert!(raw.get("sourceRevision").is_none());
        assert!(raw.get("occurredAtMs").is_none());
        raw["state"] = json!("future_state");
        raw["futureObservation"] = json!({"status":"unverified"});
        let event: WorkEventFactV2 = serde_json::from_value(raw.clone()).unwrap();
        assert!(event.validate_shape().is_ok());
        assert!(!event.state.is_known());
        assert_eq!(serde_json::to_value(&event).unwrap(), raw);
        assert_eq!(event.identity_candidate().unwrap().source_revision, None);
        // The legacy event shape still requires an actual saved work and
        // revision; it must never be synthesized to decode this observation.
        assert!(serde_json::from_value::<WorkEvent>(raw).is_err());
    }

    #[test]
    fn legacy_event_round_trips_and_explicit_conversion_preserves_original_facts() {
        let old = WorkEvent {
            work: WorkIdentity {
                scope: scope(),
                work_id: "work-a".into(),
            },
            event_id: "event-a".into(),
            source_ref: "source-a".into(),
            source_revision: "revision-1".into(),
            kind: "message".into(),
            state: WorkEventState::Unknown("future_state".into()),
            observed_at_ms: 10,
            occurred_at_ms: None,
            payload_ref: Some("original-payload".into()),
            causation_id: None,
        };
        let encoded = serde_json::to_value(&old).unwrap();
        let restored: WorkEvent = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(serde_json::to_value(&restored).unwrap(), encoded);
        let event = WorkEventFactV2::from(restored);
        assert_eq!(event.work.as_ref(), Some(&old.work));
        assert_eq!(event.scope.as_ref(), Some(&old.work.scope));
        assert_eq!(event.source_kind, None);
        assert_eq!(event.source_instance_id, None);
        assert_eq!(event.source_revision.as_deref(), Some("revision-1"));
        assert_eq!(event.event_id, old.event_id);
        assert_eq!(event.source_ref, old.source_ref);
        assert_eq!(event.state, old.state);
        assert_eq!(event.occurred_at_ms, None);
        assert_eq!(event.payload_ref, old.payload_ref);
        assert!(event.validate_shape().is_ok());
    }

    #[test]
    fn candidate_identity_is_scoped_and_does_not_decide_a_replay() {
        let mut original = unbound();
        original.scope = Some(scope());
        let candidate = original.identity_candidate().unwrap();
        let mut conflict = original.clone();
        conflict.kind = "withdrawal".into();
        conflict.payload_ref = Some("different-payload".into());
        conflict.work = Some(WorkIdentity {
            scope: scope(),
            work_id: "work-b".into(),
        });
        conflict.state = WorkEventState::Linked;
        conflict.observed_at_ms = 99;
        // Same candidate means only that the host must compare the native
        // source and immutable facts; it is not a successful deduplication.
        assert_eq!(
            observed_fields(candidate),
            observed_fields(conflict.identity_candidate().unwrap())
        );
        assert_ne!(original, conflict);

        for field in 0..8 {
            let mut other = original.clone();
            match field {
                0 => other.scope.as_mut().unwrap().account_id.push('b'),
                1 => other.scope.as_mut().unwrap().target_id.push('b'),
                2 => other.scope.as_mut().unwrap().workspace_id.push('b'),
                3 => other.source_ref.push('b'),
                4 => other.event_id.push('b'),
                5 => other.source_revision = Some("revision-2".into()),
                6 => other.source_kind = Some("different-platform".into()),
                _ => other.source_instance_id = Some("different-instance".into()),
            }
            assert_ne!(
                observed_fields(candidate),
                observed_fields(other.identity_candidate().unwrap())
            );
        }
        let mut first_revision = original.clone();
        first_revision.source_revision = Some("revision-1".into());
        let mut observed_again = first_revision.clone();
        observed_again.observed_at_ms = 123;
        observed_again.state = WorkEventState::PendingRoute;
        assert_eq!(
            observed_fields(first_revision.identity_candidate().unwrap()),
            observed_fields(observed_again.identity_candidate().unwrap())
        );
        let mut edit = first_revision.clone();
        edit.source_revision = Some("revision-2".into());
        assert_ne!(
            observed_fields(first_revision.identity_candidate().unwrap()),
            observed_fields(edit.identity_candidate().unwrap())
        );
        let mut mismatched = original.clone();
        let mut foreign = scope();
        foreign.target_id = "other-target".into();
        mismatched.work = Some(WorkIdentity {
            scope: foreign,
            work_id: "work-b".into(),
        });
        assert!(mismatched.identity_candidate().is_err());
    }

    #[test]
    fn unresolved_scope_can_be_attached_only_after_matching_work_is_known() {
        let original = unbound();
        let before = original.identity_candidate().unwrap();
        assert_eq!(before.scope, None);
        let mut attached = original.clone();
        attached.scope = Some(scope());
        attached.work = Some(WorkIdentity {
            scope: scope(),
            work_id: "work-a".into(),
        });
        attached.state = WorkEventState::Linked;
        let after = attached.identity_candidate().unwrap();
        assert_eq!(before.event_id, after.event_id);
        assert_eq!(before.source_ref, after.source_ref);
        assert_eq!(before.source_kind, after.source_kind);
        assert_eq!(before.source_instance_id, after.source_instance_id);
        assert!(after.scope.is_some());
        // Different lookup candidates after resolving scope are not proof of a
        // different native event and cannot authorize a second processing.
        let mut source_unknown = original.clone();
        source_unknown.source_instance_id = None;
        assert!(
            source_unknown
                .identity_candidate()
                .unwrap()
                .source_instance_id
                .is_none()
        );
        assert_eq!(before.source_instance_id, Some("instance-a"));
        // Learning the original instance likewise requires native reconciliation.
        attached.scope = None;
        assert!(attached.validate_shape().is_err());
        for field in 0..3 {
            let mut foreign = scope();
            match field {
                0 => foreign.account_id.push('b'),
                1 => foreign.target_id.push('b'),
                _ => foreign.workspace_id.push('b'),
            }
            attached.scope = Some(foreign);
            assert!(attached.validate_shape().is_err());
        }
    }

    #[test]
    fn malformed_and_oversized_event_facts_cannot_form_a_candidate() {
        let mut event = unbound();
        event.source_revision = Some(String::new());
        assert!(event.identity_candidate().is_err());
        event.source_revision = None;
        event.source_instance_id = Some(String::new());
        assert!(event.identity_candidate().is_err());
        event.source_instance_id = Some("instance-a".into());
        event.state = WorkEventState::Unknown("x".repeat(257));
        assert!(event.validate_shape().is_err());
        event.state = WorkEventState::Received;
        event
            .extensions
            .insert("future".into(), json!("x".repeat(3000)));
        assert!(event.validate_shape().is_err());
        event.extensions.clear();
        event
            .extensions
            .insert("eventId".into(), json!("collision"));
        assert!(event.validate_shape().is_err());
    }

    #[test]
    fn debug_never_exposes_untrusted_event_identity_or_future_payload() {
        let mut event = unbound();
        event.scope = Some(WorkScope {
            account_id: "secret-account".into(),
            target_id: "secret-target".into(),
            workspace_id: "secret-workspace".into(),
        });
        event.event_id = "secret-event".into();
        event.source_kind = Some("secret-platform".into());
        event.source_instance_id = Some("secret-instance".into());
        event.source_ref = "secret-source".into();
        event.source_revision = Some("secret-revision".into());
        event.kind = "secret-kind".into();
        event.state = WorkEventState::Unknown("secret-state".into());
        event.payload_ref = Some("secret-payload".into());
        event.causation_id = Some("secret-cause".into());
        event
            .extensions
            .insert("futureBody".into(), json!("secret-body"));
        let serialized = serde_json::to_value(&event).unwrap();
        let debug = format!("{event:?} {:?}", event.identity_candidate().unwrap());
        for secret in [
            "secret-account",
            "secret-target",
            "secret-workspace",
            "secret-event",
            "secret-platform",
            "secret-instance",
            "secret-source",
            "secret-revision",
            "secret-kind",
            "secret-state",
            "secret-payload",
            "secret-cause",
            "secret-body",
        ] {
            assert!(!debug.contains(secret), "debug exposed {secret}");
        }
        assert_eq!(serde_json::to_value(event).unwrap(), serialized);
    }

    #[test]
    fn legacy_event_debug_does_not_expose_untrusted_facts() {
        let event = WorkEvent {
            work: WorkIdentity {
                scope: WorkScope {
                    account_id: "legacy-secret-account".into(),
                    target_id: "legacy-secret-target".into(),
                    workspace_id: "legacy-secret-workspace".into(),
                },
                work_id: "legacy-secret-work".into(),
            },
            event_id: "legacy-secret-event".into(),
            source_ref: "legacy-secret-source".into(),
            source_revision: "legacy-secret-revision".into(),
            kind: "legacy-secret-kind".into(),
            state: WorkEventState::Unknown("legacy-secret-state".into()),
            observed_at_ms: 10,
            occurred_at_ms: None,
            payload_ref: Some("legacy-secret-payload".into()),
            causation_id: Some("legacy-secret-cause".into()),
        };
        let serialized = serde_json::to_value(&event).unwrap();
        let debug = format!("{event:?}");
        for secret in [
            "legacy-secret-account",
            "legacy-secret-target",
            "legacy-secret-workspace",
            "legacy-secret-work",
            "legacy-secret-event",
            "legacy-secret-source",
            "legacy-secret-revision",
            "legacy-secret-kind",
            "legacy-secret-state",
            "legacy-secret-payload",
            "legacy-secret-cause",
        ] {
            assert!(!debug.contains(secret), "legacy debug exposed {secret}");
        }
        assert_eq!(serde_json::to_value(event).unwrap(), serialized);
    }

    #[cfg(feature = "json-schema")]
    #[test]
    fn schema_keeps_scope_work_source_instance_and_revision_optional() {
        let schema = serde_json::to_value(schemars::schema_for!(WorkEventFactV2)).unwrap();
        let required = schema["required"].as_array().unwrap();
        for name in ["sourceRef", "eventId", "kind", "state", "observedAtMs"] {
            assert!(required.contains(&json!(name)), "missing required {name}");
        }
        for name in [
            "scope",
            "work",
            "sourceKind",
            "sourceInstanceId",
            "sourceRevision",
            "occurredAtMs",
            "payloadRef",
            "causationId",
        ] {
            assert!(
                !required.contains(&json!(name)),
                "unexpected required {name}"
            );
        }
    }
}
