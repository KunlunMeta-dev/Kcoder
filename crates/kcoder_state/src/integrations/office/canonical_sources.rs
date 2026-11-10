//! Canonical source bytes and output metadata publish under one original owner/operation.
use super::*;
#[cfg(test)]
#[path = "canonical_source_tests.rs"]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeCanonicalPreparation {
    pub operation_id: String,
    pub owner: IntegrationOwner,
    pub task: OfficeTaskRef,
    pub specification_sha256: String,
    pub specification_bytes: u64,
    pub inputs: Vec<OfficeCanonicalInputIdentity>,
    pub created_at_ms: u64,
}
impl OfficeCanonicalPreparation {
    pub(super) fn validate(&self) -> Result<()> {
        valid_id(&self.operation_id)?;
        valid_id(&self.task.thread_id)?;
        valid_id(&self.task.turn_id)?;
        ensure!(
            self.specification_sha256.len() == 64
                && self
                    .specification_sha256
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit())
                && self.specification_bytes > 0
                && self.specification_bytes <= OFFICE_CANONICAL_SOURCE_MAX_BYTES as u64
                && self.inputs.len() <= 128,
            "OFFICE_CANONICAL_SOURCE_INVALID"
        );
        for input in &self.inputs {
            input.validate()?;
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredCanonicalSource {
    pub descriptor: OfficeCanonicalSourceDescriptor,
}

/// Data observation written by the native backend after its real call owner is
/// checked. Reading this struct from JSON does not authorize request projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeCanonicalToolReceipt {
    pub session_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub feature: String,
    pub source_revision: String,
    pub original_input_sha256: String,
    pub operation_id: String,
}
impl OfficeCanonicalToolReceipt {
    pub(super) fn validate(&self) -> Result<()> {
        for id in [
            &self.session_id,
            &self.tool_call_id,
            &self.source_revision,
            &self.operation_id,
        ] {
            valid_id(id)?;
        }
        ensure!(
            matches!(self.tool_name.as_str(), "OfficeDocument" | "OfficeCard")
                && self.feature == "office"
                && self.original_input_sha256.len() == 64
                && self
                    .original_input_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
        );
        Ok(())
    }
}

impl OfficeStore {
    /// Original Native call metadata plus its completed immutable publication.
    /// This is read-only evidence; callers still need current source/resource/PDP.
    pub fn native_artifact_tool_receipt(
        &self,
        reference: &OfficeArtifactRef,
    ) -> Result<Option<(OfficeCanonicalToolReceipt, OfficeArtifactManifest)>> {
        valid_id(&reference.id)?;
        let _lock = self.lock(false)?;
        let state = self.load()?;
        let mut found = None;
        for receipt in state.canonical_tool_receipts.values() {
            receipt.validate()?;
            let Some(action) = state.actions.get(&receipt.operation_id) else {
                continue;
            };
            if action.phase != "completed" {
                continue;
            }
            let Some(value) = action
                .result
                .as_ref()
                .and_then(|result| result.get("manifest"))
            else {
                continue;
            };
            let manifest: OfficeArtifactManifest =
                serde_json::from_value(value.clone()).context("OFFICE_RECEIPT_CORRUPT")?;
            if manifest.id != reference.id || manifest.revision != reference.revision {
                continue;
            }
            manifest.validate()?;
            let Some(stored) = state.artifacts.get(&reference_key(reference)) else {
                continue;
            };
            ensure!(
                stored.manifest == manifest,
                "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
            );
            ensure!(
                manifest.owner == self.owner && manifest.task.thread_id == receipt.session_id,
                "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
            );
            let expected = match receipt.tool_name.as_str() {
                "OfficeDocument" => "office.generate",
                "OfficeCard" => "artifact.createCard",
                _ => unreachable!(),
            };
            ensure!(
                action.method == expected,
                "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
            );
            ensure!(found.is_none(), "OFFICE_CANONICAL_BINDING_CONFLICT");
            found = Some((receipt.clone(), manifest));
        }
        Ok(found)
    }
    pub fn prepare_canonical_tool_receipt(
        &self,
        receipt: OfficeCanonicalToolReceipt,
    ) -> Result<()> {
        receipt.validate()?;
        let _lock = self.lock(true)?;
        let mut state = self.load()?;
        if let Some(previous) = state.canonical_tool_receipts.get(&receipt.operation_id) {
            ensure!(
                previous == &receipt,
                "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
            );
            return Ok(());
        }
        ensure!(
            state.canonical_tool_receipts.len() < MAX_ARTIFACTS,
            "OFFICE_ARTIFACT_CAPACITY"
        );
        state
            .canonical_tool_receipts
            .insert(receipt.operation_id.clone(), receipt);
        state.revision = state
            .revision
            .checked_add(1)
            .context("OFFICE_REVISION_OVERFLOW")?;
        self.save(&state)
    }
    /// Only committed canonical publications can project a native call. Pending
    /// backend metadata never substitutes an unconfirmed generation result.
    pub fn canonical_tool_source(
        &self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        input_sha256: &str,
    ) -> Result<Option<(OfficeCanonicalToolReceipt, OfficeCanonicalSourceDescriptor)>> {
        valid_id(session_id)?;
        valid_id(tool_call_id)?;
        let _lock = self.lock(false)?;
        let state = self.load()?;
        let mut matches = state.canonical_tool_receipts.values().filter(|receipt| {
            receipt.session_id == session_id
                && receipt.tool_call_id == tool_call_id
                && receipt.tool_name == tool_name
                && receipt.original_input_sha256 == input_sha256
        });
        let Some(receipt) = matches.next() else {
            return Ok(None);
        };
        ensure!(
            matches.next().is_none(),
            "OFFICE_CANONICAL_BINDING_CONFLICT"
        );
        receipt.validate()?;
        let mut sources = state
            .canonical_sources
            .values()
            .filter(|source| source.descriptor.operation_id == receipt.operation_id);
        let Some(source) = sources.next() else {
            return Ok(None);
        };
        ensure!(
            sources.next().is_none(),
            "OFFICE_CANONICAL_BINDING_CONFLICT"
        );
        let descriptor = source.descriptor.clone();
        ensure!(
            descriptor.task.thread_id == session_id,
            "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
        );
        self.source_bytes(
            state
                .canonical_preparations
                .get(&receipt.operation_id)
                .context("OFFICE_CANONICAL_BINDING_MISSING")?,
        )?;
        Ok(Some((receipt.clone(), descriptor)))
    }
    /// Save the exact post-authorization generator input before starting a worker.
    /// Canonicalization sorts object keys only; strings, arrays and image data stay intact.
    pub fn prepare_canonical_generation(
        &self,
        operation: &str,
        task: OfficeTaskRef,
        specification: &Value,
        inputs: Vec<OfficeCanonicalInputIdentity>,
        created_at_ms: u64,
    ) -> Result<OfficeCanonicalPreparation> {
        valid_id(operation)?;
        let typed: OfficeGenerationSpec =
            serde_json::from_value(specification.clone()).context("OFFICE_INVALID_INPUT")?;
        typed.validate()?;
        ensure!(
            typed.source_refs
                == inputs
                    .iter()
                    .map(|input| format!("{}@{}", input.reference.id, input.reference.revision))
                    .collect::<Vec<_>>(),
            "OFFICE_CANONICAL_INPUT_IDENTITY_MISMATCH"
        );
        let bytes = canonical_bytes(specification)?;
        let prepared = OfficeCanonicalPreparation {
            operation_id: operation.into(),
            owner: self.owner.clone(),
            task,
            specification_sha256: digest(&bytes),
            specification_bytes: bytes.len() as u64,
            inputs,
            created_at_ms,
        };
        prepared.validate()?;
        let _lock = self.lock(true)?;
        let mut state = self.load()?;
        if let Some(previous) = state.canonical_preparations.get(operation) {
            ensure!(
                previous.operation_id == prepared.operation_id
                    && previous.owner == prepared.owner
                    && previous.task == prepared.task
                    && previous.specification_sha256 == prepared.specification_sha256
                    && previous.inputs == prepared.inputs,
                "OFFICE_OPERATION_CONFLICT"
            );
            self.source_bytes(previous)?;
            return Ok(previous.clone());
        }
        ensure!(
            state.canonical_preparations.len() < MAX_ARTIFACTS,
            "OFFICE_ARTIFACT_CAPACITY"
        );
        let name = source_blob(&prepared.specification_sha256);
        match self.read_optional(&name, OFFICE_CANONICAL_SOURCE_MAX_BYTES)? {
            Some(existing) => ensure!(existing == bytes, "OFFICE_CONTENT_IMMUTABLE"),
            None => self.directory.atomic_replace(OsStr::new(&name), &bytes)?,
        }
        state
            .canonical_preparations
            .insert(operation.into(), prepared.clone());
        state.revision = state
            .revision
            .checked_add(1)
            .context("OFFICE_REVISION_OVERFLOW")?;
        self.save(&state)?;
        Ok(prepared)
    }
    pub fn read_canonical_preparation(
        &self,
        operation: &str,
    ) -> Result<Option<OfficeCanonicalPreparation>> {
        valid_id(operation)?;
        let _lock = self.lock(false)?;
        let state = self.load()?;
        let Some(prepared) = state.canonical_preparations.get(operation) else {
            return Ok(None);
        };
        self.source_bytes(prepared)?;
        Ok(Some(prepared.clone()))
    }
    pub fn prepared_generation_specification(&self, operation: &str) -> Result<Value> {
        valid_id(operation)?;
        let _lock = self.lock(false)?;
        let state = self.load()?;
        let prepared = state
            .canonical_preparations
            .get(operation)
            .context("OFFICE_CANONICAL_SOURCE_MISSING")?;
        serde_json::from_slice(&self.source_bytes(prepared)?)
            .context("OFFICE_CANONICAL_SOURCE_CORRUPT")
    }
    fn source_bytes(&self, prepared: &OfficeCanonicalPreparation) -> Result<Vec<u8>> {
        prepared.validate()?;
        ensure!(prepared.owner == self.owner, "OFFICE_OWNER_MISMATCH");
        let bytes = self
            .read_optional(
                &source_blob(&prepared.specification_sha256),
                OFFICE_CANONICAL_SOURCE_MAX_BYTES,
            )?
            .context("OFFICE_CANONICAL_SOURCE_MISSING")?;
        ensure!(
            bytes.len() as u64 == prepared.specification_bytes
                && digest(&bytes) == prepared.specification_sha256,
            "OFFICE_CANONICAL_SOURCE_CORRUPT"
        );
        Ok(bytes)
    }
    /// Both immutable byte objects exist before a single snapshot publishes the pair.
    pub fn publish_generated_artifact(
        &self,
        publication_operation: &str,
        original_operation: &str,
        manifest: OfficeArtifactManifest,
        bytes: &[u8],
        generator: OfficeGeneratorIdentity,
    ) -> Result<OfficeArtifactManifest> {
        valid_id(original_operation)?;
        manifest.validate()?;
        generator.validate()?;
        ensure!(
            manifest.owner == self.owner
                && manifest.bytes == bytes.len() as u64
                && manifest.sha256 == digest(bytes),
            "OFFICE_CONTENT_IDENTITY_MISMATCH"
        );
        let key = reference_key(&OfficeArtifactRef {
            id: manifest.id.clone(),
            revision: manifest.revision,
        });
        let blob = format!("content-{}.blob", manifest.sha256);
        self.mutate(
            publication_operation,
            "artifact.publish_generated",
            &(&manifest, original_operation, &generator),
            |state| {
                let prepared = state
                    .canonical_preparations
                    .get(original_operation)
                    .context("OFFICE_CANONICAL_SOURCE_MISSING")?;
                self.source_bytes(prepared)?;
                let descriptor = OfficeCanonicalSourceDescriptor {
                    schema_version: 1,
                    id: format!(
                        "generation-source-{}",
                        digest(&serde_json::to_vec(&(&self.owner, original_operation))?)
                    ),
                    revision: 1,
                    owner: self.owner.clone(),
                    operation_id: original_operation.into(),
                    task: prepared.task.clone(),
                    artifact: OfficeArtifactRef {
                        id: manifest.id.clone(),
                        revision: manifest.revision,
                    },
                    output_sha256: manifest.sha256.clone(),
                    specification_sha256: prepared.specification_sha256.clone(),
                    specification_bytes: prepared.specification_bytes,
                    generator: generator.clone(),
                    inputs: prepared.inputs.clone(),
                    created_at_ms: prepared.created_at_ms,
                };
                descriptor.validate_for(&manifest)?;
                ensure!(
                    !state
                        .canonical_sources
                        .values()
                        .any(
                            |source| source.descriptor.operation_id == original_operation
                                && source.descriptor.artifact != descriptor.artifact
                        ),
                    "OFFICE_CANONICAL_BINDING_CONFLICT"
                );
                if let Some(previous) = state.artifacts.get(&key) {
                    ensure!(
                        previous.manifest == manifest
                            && state
                                .canonical_sources
                                .get(&key)
                                .is_some_and(|source| source.descriptor == descriptor),
                        "OFFICE_ARTIFACT_IMMUTABLE"
                    );
                    return Ok(previous.manifest.clone());
                }
                ensure!(
                    state.artifacts.len() < MAX_ARTIFACTS,
                    "OFFICE_ARTIFACT_CAPACITY"
                );
                match self.read_optional(&blob, OFFICE_MAX_ARTIFACT_BYTES as usize)? {
                    Some(previous) => ensure!(previous == bytes, "OFFICE_CONTENT_IMMUTABLE"),
                    None => self.directory.atomic_replace(OsStr::new(&blob), bytes)?,
                }
                state.artifacts.insert(
                    key.clone(),
                    StoredArtifact {
                        manifest: manifest.clone(),
                        blob,
                    },
                );
                state
                    .canonical_sources
                    .insert(key, StoredCanonicalSource { descriptor });
                Ok(manifest.clone())
            },
        )
    }
    pub fn read_canonical_source(
        &self,
        reference: &OfficeArtifactRef,
        expected_sha256: Option<&str>,
        offset: u64,
        limit: usize,
        metadata_only: bool,
    ) -> Result<OfficeCanonicalSourceReadResult> {
        valid_id(&reference.id)?;
        ensure!(
            reference.revision > 0 && limit > 0 && limit <= OFFICE_CANONICAL_SOURCE_CHUNK_BYTES,
            "OFFICE_INVALID_PAGE_LIMIT"
        );
        let _lock = self.lock(false)?;
        let state = self.load()?;
        let key = reference_key(reference);
        let manifest = &state
            .artifacts
            .get(&key)
            .context("OFFICE_ARTIFACT_NOT_FOUND")?
            .manifest;
        let Some(source) = state.canonical_sources.get(&key) else {
            return Ok(OfficeCanonicalSourceReadResult {
                availability: OfficeCanonicalSourceAvailability::NotRecorded,
                source: None,
                chunk: None,
                offset: 0,
                next_offset: None,
                complete: false,
            });
        };
        source.descriptor.validate_for(manifest)?;
        let prepared = state
            .canonical_preparations
            .get(&source.descriptor.operation_id)
            .context("OFFICE_CANONICAL_BINDING_MISSING")?;
        let bytes = self.source_bytes(prepared)?;
        ensure!(
            prepared.specification_sha256 == source.descriptor.specification_sha256
                && prepared.task == source.descriptor.task,
            "OFFICE_CANONICAL_SOURCE_CORRUPT"
        );
        if metadata_only {
            return Ok(OfficeCanonicalSourceReadResult {
                availability: OfficeCanonicalSourceAvailability::Available,
                source: Some(source.descriptor.clone()),
                chunk: None,
                offset: 0,
                next_offset: None,
                complete: false,
            });
        }
        ensure!(
            expected_sha256 == Some(source.descriptor.specification_sha256.as_str()),
            "OFFICE_CANONICAL_SOURCE_REVISION_MISMATCH"
        );
        let text = std::str::from_utf8(&bytes).context("OFFICE_CANONICAL_SOURCE_CORRUPT")?;
        let start = usize::try_from(offset).context("OFFICE_INVALID_OFFSET")?;
        ensure!(
            start <= bytes.len() && text.is_char_boundary(start),
            "OFFICE_INVALID_OFFSET"
        );
        let mut end = start.saturating_add(limit).min(bytes.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        ensure!(
            end > start || start == bytes.len(),
            "OFFICE_INVALID_PAGE_LIMIT"
        );
        Ok(OfficeCanonicalSourceReadResult {
            availability: OfficeCanonicalSourceAvailability::Available,
            source: Some(source.descriptor.clone()),
            chunk: Some(text[start..end].into()),
            offset,
            next_offset: (end < bytes.len()).then_some(end as u64),
            complete: end == bytes.len(),
        })
    }
    /// Reconcile a committed pair after the outer action reply was lost; never re-run generation.
    pub fn generation_publication(
        &self,
        operation: &str,
    ) -> Result<Option<OfficeArtifactManifest>> {
        valid_id(operation)?;
        let _lock = self.lock(false)?;
        let state = self.load()?;
        let mut sources = state
            .canonical_sources
            .values()
            .filter(|source| source.descriptor.operation_id == operation);
        let Some(source) = sources.next() else {
            return Ok(None);
        };
        ensure!(
            sources.next().is_none(),
            "OFFICE_CANONICAL_BINDING_CONFLICT"
        );
        let artifact = state
            .artifacts
            .get(&reference_key(&source.descriptor.artifact))
            .context("OFFICE_CANONICAL_BINDING_MISSING")?;
        source.descriptor.validate_for(&artifact.manifest)?;
        self.source_bytes(
            state
                .canonical_preparations
                .get(operation)
                .context("OFFICE_CANONICAL_BINDING_MISSING")?,
        )?;
        let output = self
            .read_optional(&artifact.blob, OFFICE_MAX_ARTIFACT_BYTES as usize)?
            .context("OFFICE_CONTENT_MISSING")?;
        ensure!(
            output.len() as u64 == artifact.manifest.bytes
                && digest(&output) == artifact.manifest.sha256,
            "OFFICE_CONTENT_CORRUPT"
        );
        Ok(Some(artifact.manifest.clone()))
    }
}
fn source_blob(sha: &str) -> String {
    format!("generation-source-{sha}.json")
}
fn canonical_bytes(value: &Value) -> Result<Vec<u8>> {
    fn canonical(value: &Value, depth: usize) -> Result<Value> {
        ensure!(depth <= 64, "OFFICE_CANONICAL_SOURCE_INVALID");
        Ok(match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, value)| Ok((key.clone(), canonical(value, depth + 1)?)))
                    .collect::<Result<BTreeMap<_, _>>>()?
                    .into_iter()
                    .collect(),
            ),
            Value::Array(values) => Value::Array(
                values
                    .iter()
                    .map(|value| canonical(value, depth + 1))
                    .collect::<Result<_>>()?,
            ),
            other => other.clone(),
        })
    }
    let bytes = serde_json::to_vec(&canonical(value, 0)?)?;
    ensure!(
        !bytes.is_empty() && bytes.len() <= OFFICE_CANONICAL_SOURCE_MAX_BYTES,
        "OFFICE_CANONICAL_SOURCE_TOO_LARGE"
    );
    Ok(bytes)
}
