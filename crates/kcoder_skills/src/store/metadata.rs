use super::journal::{JournalMetadataFile, sha256};
use super::layout::{
    BUILTIN_MANIFEST_FILE, BUNDLED_MANIFEST_FILE, CURATOR_LOG_FILE, PROVENANCE_FILE, STATE_FILE,
    StoreLayout, USAGE_FILE,
};
use super::replace::atomic_write;
use super::{NamedSkillRevision, SkillMetadataDelta, SkillMutationActor, SkillStoreError};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const STORE_STATE_SCHEMA: &str = "kcoder.skill-store-state/1";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StoreState {
    #[serde(default = "default_state_schema")]
    pub(crate) schema: String,
    #[serde(default)]
    pub(crate) generation: u64,
    #[serde(default)]
    pub(crate) last_transaction_id: Option<String>,
}

fn default_state_schema() -> String {
    STORE_STATE_SCHEMA.to_string()
}

pub(crate) fn load_state(layout: &StoreLayout) -> Result<StoreState, SkillStoreError> {
    let path = layout.state();
    if !path.exists() {
        return Ok(StoreState {
            schema: default_state_schema(),
            ..StoreState::default()
        });
    }
    let bytes =
        fs::read(&path).map_err(|error| SkillStoreError::io("reading skill store state", error))?;
    let state: StoreState = serde_json::from_slice(&bytes)
        .map_err(|error| SkillStoreError::serialization("parsing skill store state", error))?;
    if state.schema != STORE_STATE_SCHEMA {
        return Err(SkillStoreError::JournalCorrupt(format!(
            "unsupported skill store state schema '{}'",
            state.schema
        )));
    }
    Ok(state)
}

pub(crate) fn check_preconditions(
    layout: &StoreLayout,
    preconditions: &[super::SkillMetadataPrecondition],
) -> Result<(), SkillStoreError> {
    let mut provenance = None;
    let mut usage = None;
    for condition in preconditions {
        super::layout::validate_skill_name(&condition.skill)?;
        if condition.field.is_empty()
            || condition.field.len() > 64
            || !condition
                .field
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(SkillStoreError::PolicyRejected(format!(
                "invalid metadata precondition field '{}'",
                condition.field
            )));
        }
        let store = match condition.store {
            super::SkillMetadataStore::Provenance => {
                if provenance.is_none() {
                    provenance = Some(load_object_store(&layout.root.join(PROVENANCE_FILE))?);
                }
                provenance.as_ref().expect("initialized above")
            }
            super::SkillMetadataStore::Usage => {
                if usage.is_none() {
                    usage = Some(load_object_store(&layout.root.join(USAGE_FILE))?);
                }
                usage.as_ref().expect("initialized above")
            }
        };
        let actual = store
            .get("skills")
            .and_then(|skills| skills.get(&condition.skill))
            .and_then(|record| record.get(&condition.field));
        let matches = match condition.predicate {
            super::SkillMetadataPredicate::Equals => actual == Some(&condition.value),
            super::SkillMetadataPredicate::NotEquals => actual != Some(&condition.value),
            super::SkillMetadataPredicate::MissingOrEquals => {
                actual.is_none() || actual == Some(&condition.value)
            }
            super::SkillMetadataPredicate::In => condition
                .value
                .as_array()
                .is_some_and(|values| actual.is_some_and(|actual| values.contains(actual))),
        };
        if !matches {
            return Err(SkillStoreError::PolicyRejected(format!(
                "metadata precondition failed for '{}.{}': expected {:?} {:?}, actual {}",
                condition.skill,
                condition.field,
                condition.predicate,
                condition.value,
                actual.cloned().unwrap_or(Value::Null)
            )));
        }
    }
    Ok(())
}

pub(crate) fn prepare_metadata(
    layout: &StoreLayout,
    transaction_dir: &Path,
    transaction_id: &str,
    generation_after: u64,
    actor: &SkillMutationActor,
    revisions: &[NamedSkillRevision],
    delta: &SkillMetadataDelta,
) -> Result<Vec<JournalMetadataFile>, SkillStoreError> {
    let mut outputs = Vec::new();

    if !delta.provenance.is_empty() {
        let mut store = load_object_store(&layout.root.join(PROVENANCE_FILE))?;
        apply_skill_patches(
            &mut store,
            &delta.provenance,
            Some((transaction_id, actor, revisions)),
        )?;
        let bytes = serde_json::to_vec_pretty(&store).map_err(|error| {
            SkillStoreError::serialization("serializing provenance metadata", error)
        })?;
        outputs.push(stage_metadata_file(
            layout,
            transaction_dir,
            transaction_id,
            PROVENANCE_FILE,
            &bytes,
        )?);
    }

    if !delta.usage.is_empty() {
        let mut store = load_object_store(&layout.root.join(USAGE_FILE))?;
        apply_skill_patches(&mut store, &delta.usage, None)?;
        let bytes = serde_json::to_vec_pretty(&store)
            .map_err(|error| SkillStoreError::serialization("serializing usage metadata", error))?;
        outputs.push(stage_metadata_file(
            layout,
            transaction_dir,
            transaction_id,
            USAGE_FILE,
            &bytes,
        )?);
    }

    if let Some(bytes) = &delta.bundled_manifest {
        outputs.push(stage_metadata_file(
            layout,
            transaction_dir,
            transaction_id,
            BUNDLED_MANIFEST_FILE,
            bytes,
        )?);
    }

    if let Some(bytes) = &delta.builtin_manifest {
        outputs.push(stage_metadata_file(
            layout,
            transaction_dir,
            transaction_id,
            BUILTIN_MANIFEST_FILE,
            bytes,
        )?);
    }

    if !delta.curator_log_entries.is_empty() {
        let path = layout.root.join(CURATOR_LOG_FILE);
        let mut bytes = fs::read(&path).unwrap_or_default();
        if !bytes.is_empty() && !bytes.ends_with(b"\n") {
            bytes.push(b'\n');
        }
        for entry in &delta.curator_log_entries {
            let mut entry = entry.clone();
            if let Some(object) = entry.as_object_mut() {
                object.insert(
                    "transaction_id".to_string(),
                    Value::String(transaction_id.to_string()),
                );
                object.insert(
                    "actor_kind".to_string(),
                    Value::String(actor.kind().to_string()),
                );
                object.insert(
                    "committed_at".to_string(),
                    Value::String(Utc::now().to_rfc3339()),
                );
            }
            serde_json::to_writer(&mut bytes, &entry).map_err(|error| {
                SkillStoreError::serialization("serializing curator audit entry", error)
            })?;
            bytes.push(b'\n');
        }
        outputs.push(stage_metadata_file(
            layout,
            transaction_dir,
            transaction_id,
            CURATOR_LOG_FILE,
            &bytes,
        )?);
    }

    for (relative, bytes) in &delta.auxiliary_files {
        validate_auxiliary_path(relative)?;
        outputs.push(stage_relative_metadata_file(
            layout,
            transaction_id,
            relative,
            bytes,
        )?);
    }

    let state = StoreState {
        schema: default_state_schema(),
        generation: generation_after,
        last_transaction_id: Some(transaction_id.to_string()),
    };
    let bytes = serde_json::to_vec_pretty(&state)
        .map_err(|error| SkillStoreError::serialization("serializing skill store state", error))?;
    outputs.push(stage_metadata_file(
        layout,
        transaction_dir,
        transaction_id,
        STATE_FILE,
        &bytes,
    )?);

    outputs.sort_by(|left, right| left.live.cmp(&right.live));
    Ok(outputs)
}

fn stage_metadata_file(
    layout: &StoreLayout,
    _transaction_dir: &Path,
    transaction_id: &str,
    file_name: &str,
    after: &[u8],
) -> Result<JournalMetadataFile, SkillStoreError> {
    let live = PathBuf::from(file_name);
    stage_relative_metadata_file(layout, transaction_id, &live, after)
}

fn stage_relative_metadata_file(
    layout: &StoreLayout,
    transaction_id: &str,
    live: &Path,
    after: &[u8],
) -> Result<JournalMetadataFile, SkillStoreError> {
    let staged = PathBuf::from(".transactions")
        .join(transaction_id)
        .join("metadata-after")
        .join(live.strip_prefix(".").unwrap_or(live));
    let staged_absolute = layout.root.join(&staged);
    atomic_write(&staged_absolute, after, transaction_id)?;

    let live_absolute = layout.root.join(live);
    let (before_image, before_sha256) = if live_absolute.exists() {
        let bytes = fs::read(&live_absolute).map_err(|error| {
            SkillStoreError::io(format!("reading {}", live_absolute.display()), error)
        })?;
        let relative = PathBuf::from(".transactions")
            .join(transaction_id)
            .join("before")
            .join("metadata")
            .join(live.strip_prefix(".").unwrap_or(live));
        atomic_write(&layout.root.join(&relative), &bytes, transaction_id)?;
        (Some(relative), Some(sha256(&bytes)))
    } else {
        (None, None)
    };
    Ok(JournalMetadataFile {
        live: live.to_path_buf(),
        staged,
        before_image,
        before_sha256,
        after_sha256: sha256(after),
        published: false,
    })
}

fn validate_auxiliary_path(path: &Path) -> Result<(), SkillStoreError> {
    let canonical = super::layout::canonical_relative_path(path)?;
    let mut parts = canonical.split('/');
    let skill = parts.next().unwrap_or_default();
    super::layout::validate_skill_name(skill)?;
    let rest = parts.collect::<Vec<_>>().join("/");
    if rest.is_empty() || !rest.ends_with(".new") {
        return Err(SkillStoreError::InvalidPackage(format!(
            "auxiliary path must be inside a skill and end in .new: '{canonical}'"
        )));
    }
    Ok(())
}

fn load_object_store(path: &Path) -> Result<Value, SkillStoreError> {
    if !path.exists() {
        return Ok(serde_json::json!({ "version": 1, "skills": {} }));
    }
    let bytes = fs::read(path)
        .map_err(|error| SkillStoreError::io(format!("reading {}", path.display()), error))?;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(serde_json::json!({ "version": 1, "skills": {} }));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| SkillStoreError::serialization("parsing skill metadata", error))?;
    if !value.is_object() || !value.get("skills").is_some_and(Value::is_object) {
        return Err(SkillStoreError::JournalCorrupt(format!(
            "metadata store {} must contain an object-valued skills field",
            path.display()
        )));
    }
    Ok(value)
}

fn apply_skill_patches(
    store: &mut Value,
    patches: &BTreeMap<String, super::SkillMetadataPatch>,
    provenance: Option<(&str, &SkillMutationActor, &[NamedSkillRevision])>,
) -> Result<(), SkillStoreError> {
    let skills = store
        .get_mut("skills")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| SkillStoreError::JournalCorrupt("missing skills object".to_string()))?;
    for (name, patch) in patches {
        super::layout::validate_skill_name(name)?;
        if patch.remove {
            skills.remove(name);
            continue;
        }
        let record = skills
            .entry(name.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        let object = record.as_object_mut().ok_or_else(|| {
            SkillStoreError::JournalCorrupt(format!(
                "metadata record for '{name}' is not an object"
            ))
        })?;
        object
            .entry("name".to_string())
            .or_insert_with(|| Value::String(name.clone()));
        for (key, value) in &patch.create {
            object.entry(key.clone()).or_insert_with(|| value.clone());
        }
        for (key, value) in &patch.update {
            object.insert(key.clone(), value.clone());
        }
        for (key, increment) in &patch.increment {
            let current = object.get(key).and_then(Value::as_u64).unwrap_or(0);
            object.insert(
                key.clone(),
                Value::from(current.checked_add(*increment).ok_or_else(|| {
                    SkillStoreError::JournalCorrupt(format!(
                        "metadata counter '{key}' overflowed for '{name}'"
                    ))
                })?),
            );
        }
        if let Some((transaction_id, actor, revisions)) = provenance {
            object.insert(
                "last_transaction_id".to_string(),
                Value::String(transaction_id.to_string()),
            );
            object.insert(
                "last_actor_kind".to_string(),
                Value::String(actor.kind().to_string()),
            );
            object.insert(
                "updated_at".to_string(),
                Value::String(Utc::now().to_rfc3339()),
            );
            if let Some(revision) = revisions
                .iter()
                .find(|revision| revision.name == *name)
                .and_then(|revision| revision.revision.as_ref())
            {
                object.insert(
                    "revision_sha256".to_string(),
                    Value::String(revision.0.clone()),
                );
            } else {
                object.remove("revision_sha256");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SkillMetadataPatch;

    #[test]
    fn metadata_patch_preserves_unrelated_counters() {
        let mut store = serde_json::json!({
            "version": 1,
            "skills": { "demo": { "name": "demo", "view_count": 9, "state": "active" } }
        });
        let mut patch = SkillMetadataPatch::default();
        patch
            .update
            .insert("state".to_string(), Value::String("archived".to_string()));
        apply_skill_patches(
            &mut store,
            &BTreeMap::from([("demo".to_string(), patch)]),
            None,
        )
        .unwrap();
        assert_eq!(store["skills"]["demo"]["view_count"], 9);
        assert_eq!(store["skills"]["demo"]["state"], "archived");
    }
}
