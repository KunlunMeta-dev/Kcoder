//! Bounded, read-only observations when an unrelated Work record is corrupt.
use super::*;
use serde::de::{Error as _, MapAccess, SeqAccess, Visitor};
use std::fmt;

const MAX_OBSERVATION_BYTES: usize = 8 * 1024 * 1024;

/// A snapshot of stored binding claims, never an Accepted or execution grant.
/// A partial result is not a complete list, even when its vector is empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoredBindingObservation {
    Complete(Vec<WorkIdentity>),
    Partial(Vec<WorkIdentity>),
    Unavailable,
}

/// Exact lookup of a saved binding claim. Neither observed variant proves
/// native acceptance or authorizes execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoredBindingLookup {
    Observed,
    ObservedPartial,
    Absent,
    Unavailable,
}

/// A partial list cannot prove that an omitted binding is absent.
pub fn observe_stored_work_binding(
    profile: &Path,
    actual_scope: &WorkScope,
    work_id: &str,
    thread_id: &str,
) -> StoredBindingLookup {
    if actual_scope.validate_shape().is_err()
        || work_id.is_empty()
        || work_id.len() > 128
        || !work_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        || !atom(thread_id)
    {
        return StoredBindingLookup::Unavailable;
    }
    let identity = WorkIdentity {
        scope: actual_scope.clone(),
        work_id: work_id.to_owned(),
    };
    if identity.validate_shape().is_err() {
        return StoredBindingLookup::Unavailable;
    }
    match observe_stored_work_bindings(profile, actual_scope, thread_id) {
        StoredBindingObservation::Complete(values) if values.contains(&identity) => {
            StoredBindingLookup::Observed
        }
        StoredBindingObservation::Complete(_) => StoredBindingLookup::Absent,
        StoredBindingObservation::Partial(values) if values.contains(&identity) => {
            StoredBindingLookup::ObservedPartial
        }
        StoredBindingObservation::Partial(_) | StoredBindingObservation::Unavailable => {
            StoredBindingLookup::Unavailable
        }
    }
}

/// Observe only the supplied scope and thread in an existing private profile.
/// The host must independently establish that scope and each native Accepted
/// binding. This function never creates or repairs storage; its point-in-time
/// output is not suitable for dispatch or for proving task completion.
///
/// Opening and capture each acquire the namespace lock, with up to one second
/// of contention per acquisition. Filesystem calls themselves may block. Call
/// this only from an owned, bounded blocking worker. Each existing namespace
/// read may read up to its 64 MiB storage limit; this diagnostic parses at most
/// 8 MiB of metadata and returns unavailable above that limit. A complete list
/// describes finalized stored bindings at the captured instant; any pending
/// publication or unsettled control keeps the observation unavailable.
pub fn observe_stored_work_bindings(
    profile: &Path,
    actual_scope: &WorkScope,
    thread_id: &str,
) -> StoredBindingObservation {
    if actual_scope.validate_shape().is_err() || !atom(thread_id) {
        return StoredBindingObservation::Unavailable;
    }
    let Ok(Some(namespace)) = Namespace::open_existing(profile) else {
        return StoredBindingObservation::Unavailable;
    };
    // Parsing happens after the namespace lease is released. The bytes belong
    // to this one verified read, not to a reusable cross-process receipt.
    let Ok(bytes) = namespace.read(|bytes| {
        ensure!(
            bytes.len() <= MAX_OBSERVATION_BYTES,
            "CONTINUOUS_OBSERVATION_LIMIT"
        );
        Ok(bytes.to_vec())
    }) else {
        return StoredBindingObservation::Unavailable;
    };
    let Ok(UniqueJson(mut raw)) = serde_json::from_slice::<UniqueJson>(&bytes) else {
        return StoredBindingObservation::Unavailable;
    };
    if let Ok(data) = parse_data(&bytes)
        && dependencies_are_complete(&data)
    {
        let mut complete = true;
        let mut found = Vec::new();
        for (key, stored) in &data.works {
            complete &= collect_binding(key, stored, actual_scope, thread_id, &mut found);
        }
        if complete {
            return StoredBindingObservation::Complete(found);
        }
    }
    let Some(envelope) = raw.as_object_mut() else {
        return StoredBindingObservation::Unavailable;
    };
    if envelope.get("version").and_then(Value::as_u64) != Some(1)
        || envelope.keys().any(|key| {
            !matches!(
                key.as_str(),
                "version"
                    | "works"
                    | "inputs"
                    | "inputIds"
                    | "operations"
                    | "pendingPublications"
                    | "pendingInputIds"
            )
        })
        || ["pendingPublications", "pendingInputIds"]
            .iter()
            .any(|field| {
                envelope.get(*field).is_some_and(|value| {
                    value.as_object().is_none_or(|entries| !entries.is_empty())
                })
            })
    {
        return StoredBindingObservation::Unavailable;
    }
    let Some(works) = envelope.get_mut("works").and_then(Value::as_object_mut) else {
        return StoredBindingObservation::Unavailable;
    };
    if works.len() > MAX_WORKS {
        return StoredBindingObservation::Unavailable;
    }
    let mut invalid_work = BTreeSet::new();
    for (key, value) in works.iter() {
        let Ok(stored) = serde_json::from_value::<StoredWork>(value.clone()) else {
            return StoredBindingObservation::Unavailable;
        };
        let Ok(work) = serde_json::from_value::<WorkRecord>(stored.record.clone()) else {
            return StoredBindingObservation::Unavailable;
        };
        if work.identity.validate_shape().is_err()
            || work_key(&work.identity).ok().as_deref() != Some(key.as_str())
            || has_unknown_work_semantics(&work)
            || stored
                .pending_control
                .as_ref()
                .is_some_and(|control| control.state != WorkControlState::Settled)
        {
            return StoredBindingObservation::Unavailable;
        }
        if locally_valid_binding(key, &stored).is_none() {
            invalid_work.insert(key.clone());
        }
    }
    if invalid_work.is_empty() {
        // Corruption elsewhere cannot safely be attributed to a different Work.
        return StoredBindingObservation::Unavailable;
    }
    works.retain(|key, _| !invalid_work.contains(key));

    let Some(inputs) = envelope.get_mut("inputs").and_then(Value::as_object_mut) else {
        return StoredBindingObservation::Unavailable;
    };
    if inputs.len() > MAX_INPUTS {
        return StoredBindingObservation::Unavailable;
    }
    let mut removed_inputs = BTreeSet::new();
    let mut input_dependencies = BTreeMap::new();
    for (key, value) in inputs.iter() {
        let Ok(stored) = serde_json::from_value::<StoredInput>(value.clone()) else {
            return StoredBindingObservation::Unavailable;
        };
        let Ok(receipt) = receipt(&stored) else {
            return StoredBindingObservation::Unavailable;
        };
        if receipt.validate_for_mutation(&receipt.work.scope).is_err()
            || stored.source.validate().is_err()
            || stored
                .accepted_deliveries
                .as_ref()
                .is_some_and(|deliveries| validate_deliveries(deliveries).is_err())
            || (receipt.kind == WorkInputKind::Requirement) != stored.accepted_deliveries.is_some()
            || input_key(&receipt.work, &stored.source, &receipt.input_id)
                .ok()
                .as_ref()
                != Some(key)
        {
            return StoredBindingObservation::Unavailable;
        }
        let (Ok(index), Ok(operation)) = (
            input_identity_key(&receipt.work.scope, &stored.source, &receipt.input_id),
            input_operation_key(&receipt.work.scope, &stored.source, &receipt.request_id),
        ) else {
            return StoredBindingObservation::Unavailable;
        };
        input_dependencies.insert(
            key.clone(),
            (index, operation, receipt.request_digest.clone()),
        );
        let Ok(owner) = work_key(&receipt.work) else {
            return StoredBindingObservation::Unavailable;
        };
        if invalid_work.contains(&owner) {
            removed_inputs.insert(key.clone());
        }
    }
    inputs.retain(|key, _| !removed_inputs.contains(key));
    let Some(input_ids) = envelope.get_mut("inputIds").and_then(Value::as_object_mut) else {
        return StoredBindingObservation::Unavailable;
    };
    if input_ids.len() != input_dependencies.len()
        || input_ids.values().any(|value| !value.is_string())
        || input_dependencies.iter().any(|(key, (index, _, _))| {
            input_ids.get(index).and_then(Value::as_str) != Some(key.as_str())
        })
    {
        return StoredBindingObservation::Unavailable;
    }
    input_ids.retain(|_, value| !removed_inputs.contains(value.as_str().unwrap()));

    let Some(operations) = envelope
        .get_mut("operations")
        .and_then(Value::as_object_mut)
    else {
        return StoredBindingObservation::Unavailable;
    };
    if operations.len() > MAX_OPERATIONS {
        return StoredBindingObservation::Unavailable;
    }
    let mut removed_operations = BTreeSet::new();
    let mut verified_input_operations = BTreeSet::new();
    for (key, value) in operations.iter() {
        let Ok(operation) = serde_json::from_value::<StoredOperation>(value.clone()) else {
            return StoredBindingObservation::Unavailable;
        };
        let remove = match operation {
            StoredOperation::Input { digest, input_key } => {
                let Some((_, expected_key, expected_digest)) = input_dependencies.get(&input_key)
                else {
                    return StoredBindingObservation::Unavailable;
                };
                if key != expected_key || &digest != expected_digest {
                    return StoredBindingObservation::Unavailable;
                }
                verified_input_operations.insert(key.clone());
                removed_inputs.contains(&input_key)
            }
            StoredOperation::Binding {
                digest,
                work_key,
                thread_id,
            } => {
                if !digest_shape(key)
                    || !digest_shape(&work_key)
                    || !digest_shape(&digest)
                    || !atom(&thread_id)
                {
                    return StoredBindingObservation::Unavailable;
                }
                invalid_work.contains(&work_key)
            }
            StoredOperation::Control { digest, receipt } => {
                if !valid_control_operation(key, &digest, &receipt) {
                    return StoredBindingObservation::Unavailable;
                }
                let Ok(owner) = work_key(&receipt.work) else {
                    return StoredBindingObservation::Unavailable;
                };
                invalid_work.contains(&owner)
            }
        };
        if remove {
            removed_operations.insert(key.clone());
        }
    }
    if input_dependencies
        .values()
        .any(|(_, operation, _)| !verified_input_operations.contains(operation))
    {
        return StoredBindingObservation::Unavailable;
    }
    operations.retain(|key, _| !removed_operations.contains(key));
    let Ok(filtered) = serde_json::to_vec(&raw) else {
        return StoredBindingObservation::Unavailable;
    };
    let Ok(data) = parse_data(&filtered) else {
        return StoredBindingObservation::Unavailable;
    };
    if !dependencies_are_complete(&data) {
        return StoredBindingObservation::Unavailable;
    }
    let mut found = Vec::new();
    if data
        .works
        .iter()
        .any(|(key, stored)| !collect_binding(key, stored, actual_scope, thread_id, &mut found))
    {
        return StoredBindingObservation::Unavailable;
    }
    StoredBindingObservation::Partial(found)
}

/// Require the original input operation and every additional binding operation
/// to remain present and consistent for the records we expose.
fn dependencies_are_complete(data: &StoreData) -> bool {
    if !data.pending_publications.is_empty()
        || !data.pending_input_ids.is_empty()
        || data.works.values().any(|stored| {
            stored
                .pending_control
                .as_ref()
                .is_some_and(|control| control.state != WorkControlState::Settled)
        })
    {
        return false;
    }
    for (key, stored) in &data.inputs {
        let Ok(input) = receipt(stored) else {
            return false;
        };
        if input.validate_for_mutation(&input.work.scope).is_err() {
            return false;
        }
        let Ok(operation_key) =
            input_operation_key(&input.work.scope, &stored.source, &input.request_id)
        else {
            return false;
        };
        if !matches!(
            data.operations.get(&operation_key),
            Some(StoredOperation::Input { digest, input_key })
                if digest == &input.request_digest && input_key == key
        ) {
            return false;
        }
    }
    for (key, operation) in &data.operations {
        match operation {
            StoredOperation::Input { digest, input_key } => {
                let Some(stored) = data.inputs.get(input_key) else {
                    return false;
                };
                let Ok(input) = receipt(stored) else {
                    return false;
                };
                if input_operation_key(&input.work.scope, &stored.source, &input.request_id)
                    .ok()
                    .as_ref()
                    != Some(key)
                    || &input.request_digest != digest
                {
                    return false;
                }
            }
            StoredOperation::Binding {
                digest,
                work_key,
                thread_id,
            } => {
                let Some(stored) = data.works.get(work_key) else {
                    return false;
                };
                let (Some(work), Some(attempt)) = (
                    locally_valid_binding(work_key, stored),
                    stored.bindings.get(thread_id),
                ) else {
                    return false;
                };
                if !digest_shape(key)
                    || hash(&(&work.identity, attempt)).ok().as_ref() != Some(digest)
                {
                    return false;
                }
            }
            StoredOperation::Control { digest, receipt } => {
                if !valid_control_operation(key, digest, receipt) {
                    return false;
                }
            }
        }
    }
    let bindings = data
        .operations
        .values()
        .filter_map(|operation| match operation {
            StoredOperation::Binding {
                digest,
                work_key,
                thread_id,
            } => Some((work_key.as_str(), thread_id.as_str(), digest.as_str())),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    for (key, stored) in &data.works {
        let Some(work) = locally_valid_binding(key, stored) else {
            return false;
        };
        for (thread, attempt) in &stored.bindings {
            if thread == &work.origin.initial_attempt.thread_id {
                continue;
            }
            let Ok(digest) = hash(&(&work.identity, attempt)) else {
                return false;
            };
            if !bindings.contains(&(key.as_str(), thread.as_str(), digest.as_str())) {
                return false;
            }
        }
    }
    true
}

fn digest_shape(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn has_unknown_work_semantics(work: &WorkRecord) -> bool {
    work.schema_version != kcoder_types::continuous_work::CONTINUOUS_WORK_SCHEMA_V1
        || !work.extensions.is_empty()
        || !work.phase.is_known()
        || !work.origin.kind.is_known()
        || work
            .waiting
            .as_ref()
            .is_some_and(|wait| !wait.kind.is_known())
        || work.native_refs.iter().any(|reference| {
            matches!(
                reference,
                kcoder_types::continuous_work::WorkNativeReference::Unknown(_)
            )
        })
        || (work.validate_shape().is_ok()
            && work.validate_for_mutation(&work.identity.scope).is_err())
}

fn valid_control_operation(key: &str, digest: &str, receipt: &WorkControlReceipt) -> bool {
    let Some(target) = receipt.target.known() else {
        return false;
    };
    receipt.state == WorkControlState::Settled
        && receipt.validate_for_mutation(&receipt.work.scope).is_ok()
        && operation_key(&receipt.work.scope, &receipt.request_id)
            .ok()
            .as_deref()
            == Some(key)
        && hash(&(
            &receipt.work,
            receipt.expected_revision,
            &receipt.action,
            target,
        ))
        .ok()
        .as_deref()
            == Some(digest)
}

/// Check the saved native attempt association, without treating it as an
/// independently verified Accepted attempt or a permission to execute.
fn locally_valid_binding(key: &str, stored: &StoredWork) -> Option<WorkRecord> {
    let work = record(stored).ok()?;
    if work_key(&work.identity).ok().as_deref() != Some(key)
        || stored.bindings.len() != work.linked_thread_ids.len()
        || stored.bindings.get(&work.origin.initial_attempt.thread_id)
            != Some(&work.origin.initial_attempt)
        || work.linked_thread_ids.iter().any(|thread| {
            stored
                .bindings
                .get(thread)
                .is_none_or(|attempt| attempt.thread_id != *thread || attempt.validate().is_err())
        })
        || validate_deliveries(&stored.accepted_deliveries).is_err()
        || work.validate_for_mutation(&work.identity.scope).is_err()
    {
        return None;
    }
    Some(work)
}

fn collect_binding(
    key: &str,
    stored: &StoredWork,
    scope: &WorkScope,
    thread_id: &str,
    found: &mut Vec<WorkIdentity>,
) -> bool {
    let Some(work) = locally_valid_binding(key, stored) else {
        return false;
    };
    if work.identity.matches_scope(scope) && stored.bindings.contains_key(thread_id) {
        found.push(work.identity);
    }
    true
}

/// serde_json's ordinary map decoder accepts duplicate object keys. A partial
/// diagnostic must reject that ambiguity rather than silently choose a record.
struct UniqueJson(Value);

impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct UniqueVisitor;
        impl<'de> Visitor<'de> for UniqueVisitor {
            type Value = UniqueJson;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("JSON without duplicate object keys")
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                value: bool,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueJson(Value::Bool(value)))
            }
            fn visit_i64<E: serde::de::Error>(
                self,
                value: i64,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueJson(Value::Number(value.into())))
            }
            fn visit_u64<E: serde::de::Error>(
                self,
                value: u64,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueJson(Value::Number(value.into())))
            }
            fn visit_f64<E: serde::de::Error>(
                self,
                value: f64,
            ) -> std::result::Result<Self::Value, E> {
                serde_json::Number::from_f64(value)
                    .map(|number| UniqueJson(Value::Number(number)))
                    .ok_or_else(|| E::custom("invalid JSON number"))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                value: &str,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(value.to_owned())))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                value: String,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(value)))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(UniqueJson(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element::<UniqueJson>()? {
                    values.push(value.0);
                }
                Ok(UniqueJson(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    let value = map.next_value::<UniqueJson>()?.0;
                    if values.insert(key, value).is_some() {
                        return Err(A::Error::custom("duplicate JSON object key"));
                    }
                }
                Ok(UniqueJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(UniqueVisitor)
    }
}
