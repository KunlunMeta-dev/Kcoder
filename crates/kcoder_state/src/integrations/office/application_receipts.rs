//! Native application tool receipts share the existing atomic Office snapshot.
use super::*;
use kcoder_types::{
    McpApplicationActionRule,
    integrations::core::{
        IntegrationRevisionRef, IntegrationTaskCapabilitySourceChoice, IntegrationTaskResourceRef,
    },
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeApplicationToolReceipt {
    pub version: u32,
    pub owner: IntegrationOwner,
    pub task: OfficeTaskRef,
    pub artifact: OfficeArtifactRef,
    pub root_operation_id: String,
    pub effect_operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconciliation: Option<OfficeApplicationReconciliationProof>,
    pub native_call_id: String,
    pub tool_name: String,
    pub raw_tool_name: String,
    pub server: String,
    pub plugin_id: Option<String>,
    pub source: IntegrationTaskCapabilitySourceChoice,
    pub connection: IntegrationRevisionRef,
    pub resources: Vec<IntegrationTaskResourceRef>,
    pub rule: McpApplicationActionRule,
    pub approved_input: Value,
    pub input_sha256: String,
    pub actual_result: Value,
    pub result_sha256: String,
    pub content_sha256: String,
    pub byte_content_sha256: Option<String>,
}
/// This binds an actual read-only lookup to an earlier approved intent.
/// It never represents a response from the original mutating call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeApplicationReconciliationProof {
    pub original_effect_operation_id: String,
    pub original_intent_sha256: String,
    pub observed_object_id: String,
    pub observed_object_sha256: String,
}
impl OfficeApplicationToolReceipt {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1 && !self.resources.is_empty() && self.resources.len() <= 100,
            "OFFICE_APPLICATION_RECEIPT_INVALID"
        );
        self.source.validate()?;
        ensure!(
            self.rule.action.is_effect() == self.effect_operation_id.is_some(),
            "OFFICE_APPLICATION_RECEIPT_INVALID"
        );
        if let Some(operation) = &self.effect_operation_id {
            valid_id(operation)?;
        }
        ensure!(
            self.rule.action.reconciles_effect().is_some() == self.reconciliation.is_some(),
            "OFFICE_APPLICATION_LOOKUP_PROOF_REQUIRED"
        );
        if let Some(proof) = &self.reconciliation {
            valid_id(&proof.original_effect_operation_id)?;
            valid_id(&proof.observed_object_id)?;
            for hash in [&proof.original_intent_sha256, &proof.observed_object_sha256] {
                ensure!(
                    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
                    "OFFICE_APPLICATION_LOOKUP_PROOF_INVALID"
                );
            }
            let object = self
                .actual_result
                .get("object")
                .context("OFFICE_APPLICATION_LOOKUP_PROOF_INVALID")?;
            let object_key = match self.rule.action {
                kcoder_types::McpApplicationAction::DocumentLookup => "documentId",
                kcoder_types::McpApplicationAction::MailLookup => "messageId",
                kcoder_types::McpApplicationAction::TableLookup => "exportId",
                _ => anyhow::bail!("OFFICE_APPLICATION_LOOKUP_PROOF_INVALID"),
            };
            ensure!(
                self.actual_result
                    .get("operationId")
                    .and_then(Value::as_str)
                    == Some(self.root_operation_id.as_str())
                    && object.get("operationId").and_then(Value::as_str)
                        == Some(self.root_operation_id.as_str())
                    && object.get(object_key).and_then(Value::as_str)
                        == Some(proof.observed_object_id.as_str())
                    && digest(&serde_json::to_vec(object)?) == proof.observed_object_sha256,
                "OFFICE_APPLICATION_LOOKUP_PROOF_INVALID"
            );
        }
        for id in [
            &self.root_operation_id,
            &self.native_call_id,
            &self.tool_name,
            &self.raw_tool_name,
            &self.server,
            &self.connection.id,
            &self.connection.revision,
            &self.task.thread_id,
            &self.task.turn_id,
            &self.artifact.id,
        ] {
            valid_id(id)?;
        }
        for hash in [
            &self.input_sha256,
            &self.result_sha256,
            &self.content_sha256,
            &self.rule.schema_sha256,
        ] {
            ensure!(
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
                "OFFICE_APPLICATION_RECEIPT_INVALID"
            );
        }
        if let Some(hash) = &self.byte_content_sha256 {
            ensure!(
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
                "OFFICE_APPLICATION_RECEIPT_INVALID"
            );
        }
        ensure!(
            self.input_sha256 == digest(&serde_json::to_vec(&self.approved_input)?)
                && self.result_sha256 == digest(&serde_json::to_vec(&self.actual_result)?)
                && serde_json::to_vec(self)?.len() <= 256 * 1024,
            "OFFICE_APPLICATION_RECEIPT_INVALID"
        );
        Ok(())
    }
    pub(super) fn verify_reconciliation_intent(&self, state: &Snapshot) -> Result<()> {
        let Some(proof) = &self.reconciliation else {
            return Ok(());
        };
        let original = state
            .application_effect_intents
            .get(&proof.original_effect_operation_id)
            .context("OFFICE_APPLICATION_LOOKUP_INTENT_REQUIRED")?;
        original.validate()?;
        ensure!(
            digest(&serde_json::to_vec(original)?) == proof.original_intent_sha256
                && self.rule.action.reconciles_effect() == Some(original.rule.action)
                && original.owner == self.owner
                && original.task == self.task
                && original.root_operation_id == self.root_operation_id
                && original.source == self.source
                && original.connection == self.connection
                && original.resources == self.resources,
            "OFFICE_APPLICATION_LOOKUP_INTENT_CHANGED"
        );
        Ok(())
    }
    pub fn source_references(&self) -> Result<Vec<OfficeResourceRef>> {
        self.validate()?;
        let mut sources = vec![OfficeResourceRef {
            kind: "application_connection".into(),
            id: self.connection.id.clone(),
            revision: self.connection.revision.clone(),
        }];
        sources.extend(self.resources.iter().map(|resource| OfficeResourceRef {
            kind: "application_resource".into(),
            id: resource.id.clone(),
            revision: resource.revision.clone(),
        }));
        sources.push(OfficeResourceRef {
            kind: "application_receipt".into(),
            id: self.artifact.id.clone(),
            revision: digest(&serde_json::to_vec(self)?),
        });
        Ok(sources)
    }
}
impl OfficeStore {
    pub fn publish_application_artifact(
        &self,
        operation: &str,
        manifest: OfficeArtifactManifest,
        bytes: &[u8],
        receipt: OfficeApplicationToolReceipt,
    ) -> Result<OfficeArtifactManifest> {
        receipt.validate()?;
        manifest.validate()?;
        ensure!(
            receipt.owner == manifest.owner
                && manifest.owner == self.owner
                && receipt.task == manifest.task
                && receipt.artifact.id == manifest.id
                && receipt.artifact.revision == manifest.revision
                && receipt.content_sha256 == manifest.sha256
                && receipt.source_references()? == manifest.source_refs
                && manifest.bytes == bytes.len() as u64
                && manifest.sha256 == digest(bytes),
            "OFFICE_APPLICATION_RECEIPT_MISMATCH"
        );
        let key = reference_key(&receipt.artifact);
        self.mutate(
            operation,
            "application_artifact.publish",
            &(&manifest, &receipt),
            |state| {
                receipt.verify_reconciliation_intent(state)?;
                if let Some(previous) = state.artifacts.get(&key) {
                    ensure!(
                        previous.manifest == manifest
                            && state.application_tool_receipts.get(&key) == Some(&receipt),
                        "OFFICE_APPLICATION_RECEIPT_MISMATCH"
                    );
                    return Ok(previous.manifest.clone());
                }
                ensure!(
                    state.artifacts.len() < MAX_ARTIFACTS,
                    "OFFICE_ARTIFACT_CAPACITY"
                );
                let blob = format!("content-{}.blob", manifest.sha256);
                self.write_immutable_blob(&blob, bytes)?;
                state.artifacts.insert(
                    key.clone(),
                    StoredArtifact {
                        manifest: manifest.clone(),
                        blob,
                    },
                );
                state.application_tool_receipts.insert(key, receipt.clone());
                Ok(manifest.clone())
            },
        )
    }
    pub fn read_application_receipt(
        &self,
        reference: &OfficeArtifactRef,
    ) -> Result<Option<OfficeApplicationToolReceipt>> {
        valid_id(&reference.id)?;
        let _lock = self.lock(false)?;
        Ok(self
            .load()?
            .application_tool_receipts
            .get(&reference_key(reference))
            .cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::integrations::core::IntegrationNullable;
    use serde_json::json;
    fn fixture() -> (
        tempfile::TempDir,
        OfficeStore,
        OfficeArtifactManifest,
        OfficeApplicationToolReceipt,
        Vec<u8>,
    ) {
        let root = tempfile::tempdir().unwrap();
        let owner = IntegrationOwner {
            account_id: "owned-account".into(),
            target_id: "owned-target".into(),
            workspace_id: IntegrationNullable::Value("owned-workspace".into()),
            organization_id: None,
        };
        let store = OfficeStore::create(&root.path().join("office"), owner.clone()).unwrap();
        let input =
            json!({"uri":"owned://document","operationId":"original","body":"Exact approved body"});
        let result =
            json!({"operationId":"original","documentId":"owned-document","state":"created"});
        let bytes = serde_json::to_vec(&result).unwrap();
        let task = OfficeTaskRef {
            thread_id: "owned-thread".into(),
            turn_id: "owned-turn".into(),
            run_id: None,
        };
        let receipt=OfficeApplicationToolReceipt{
            version:1,owner:owner.clone(),task:task.clone(),artifact:OfficeArtifactRef{id:"owned-artifact".into(),revision:1},
            root_operation_id:"original".into(),effect_operation_id:Some("owned-effect".into()),reconciliation:None,native_call_id:"actual-call".into(),
            tool_name:"actual-registered-create".into(),raw_tool_name:"document_create".into(),server:"actual-source".into(),plugin_id:None,
            source:serde_json::from_value(json!({"sourceRef":{"id":"actual-source-reference","revision":"original-source-birth"},"accountRef":null})).unwrap(),
            connection:IntegrationRevisionRef{id:"owned-connection".into(),revision:"7".into()},
            resources:vec![IntegrationTaskResourceRef{id:"owned-resource".into(),revision:"original-resource-version".into(),kind:"document".into()}],
            rule:serde_json::from_value(json!({"action":"document.create","schema_sha256":"a".repeat(64),"resource_uri_input_pointer":"/uri","operation_id_input_pointer":"/operationId","input_template":{"uri":null,"operationId":null,"body":null},"fields":{"/body":{"type":"string","max_bytes":128}}})).unwrap(),
            input_sha256:digest(&serde_json::to_vec(&input).unwrap()),approved_input:input,
            actual_result:result,result_sha256:digest(&bytes),content_sha256:digest(&bytes),byte_content_sha256:None,
        };
        let manifest = OfficeArtifactManifest {
            schema_version: 1,
            id: "owned-artifact".into(),
            revision: 1,
            owner,
            task,
            kind: OfficeArtifactKind::OperationReceipt,
            title: "Owned original receipt".into(),
            format: OfficeFileFormat::Json,
            bytes: bytes.len() as u64,
            sha256: digest(&bytes),
            source_refs: receipt.source_references().unwrap(),
            verification: OfficeVerification {
                status: OfficeVerificationStatus::Partial,
                completed_checks: vec!["owned_native_receipt".into()],
                pending_checks: vec![],
                reader_status: OfficeVerificationStatus::Unavailable,
                formula_calculation: "not_applicable".into(),
            },
            dataset: None,
            created_at_ms: 1,
            presentation: None,
        };
        (root, store, manifest, receipt, bytes)
    }
    #[test]
    fn lookup_proof_requires_the_original_persisted_intent_and_survives_reopen() {
        let (root, store, mut manifest, original, _) = fixture();
        let intent: OfficeApplicationEffectIntent = serde_json::from_value(json!({
            "version":1,"owner":original.owner,"task":original.task,"rootOperationId":original.root_operation_id,
            "effectOperationId":original.effect_operation_id,"nativeCallId":original.native_call_id,
            "businessAction":"document.create","toolName":original.tool_name,"rawToolName":original.raw_tool_name,
            "server":original.server,"pluginId":original.plugin_id,"source":original.source,"connection":original.connection,
            "resources":original.resources,"resourceUris":["owned://document"],"rule":original.rule,
            "approvedInput":original.approved_input,"inputSha256":original.input_sha256,
        })).unwrap();
        let mut lookup = original.clone();
        lookup.effect_operation_id = None;
        lookup.tool_name = "actual-registered-lookup".into();
        lookup.raw_tool_name = "document_lookup".into();
        lookup.rule = serde_json::from_value(json!({"action":"document.lookup","schema_sha256":"b".repeat(64),"resource_uri_input_pointer":"/uri","operation_id_input_pointer":"/operationId","input_template":{"uri":null,"operationId":null}})).unwrap();
        lookup.approved_input = json!({"uri":"owned://document","operationId":"original"});
        lookup.input_sha256 = digest(&serde_json::to_vec(&lookup.approved_input).unwrap());
        lookup.actual_result =
            json!({"operationId":"original","state":"found","object":original.actual_result});
        let bytes = serde_json::to_vec(&lookup.actual_result).unwrap();
        lookup.result_sha256 = digest(&bytes);
        lookup.content_sha256 = digest(&bytes);
        lookup.reconciliation = Some(OfficeApplicationReconciliationProof {
            original_effect_operation_id: intent.effect_operation_id.clone(),
            original_intent_sha256: digest(&serde_json::to_vec(&intent).unwrap()),
            observed_object_id: "owned-document".into(),
            observed_object_sha256: digest(&serde_json::to_vec(&original.actual_result).unwrap()),
        });
        manifest.bytes = bytes.len() as u64;
        manifest.sha256 = digest(&bytes);
        manifest.source_refs = lookup.source_references().unwrap();
        assert!(
            store
                .publish_application_artifact(
                    "missing-intent",
                    manifest.clone(),
                    &bytes,
                    lookup.clone()
                )
                .is_err()
        );
        assert!(store.list_artifacts("owned-thread").unwrap().is_empty());
        store
            .save_application_effect_intent("original-intent", intent.clone())
            .unwrap();
        store
            .publish_application_artifact(
                "publish-actual-lookup",
                manifest.clone(),
                &bytes,
                lookup.clone(),
            )
            .unwrap();
        let mut changed = lookup.clone();
        changed
            .reconciliation
            .as_mut()
            .unwrap()
            .original_intent_sha256 = "0".repeat(64);
        let mut changed_manifest = manifest.clone();
        changed_manifest.source_refs = changed.source_references().unwrap();
        assert!(
            store
                .publish_application_artifact("changed-intent", changed_manifest, &bytes, changed)
                .is_err()
        );
        drop(store);
        let reopened =
            OfficeStore::open_existing(&root.path().join("office"), lookup.owner.clone())
                .unwrap()
                .unwrap();
        let retained = reopened
            .read_application_receipt(&lookup.artifact)
            .unwrap()
            .unwrap();
        assert_eq!(retained, lookup);
        assert!(retained.effect_operation_id.is_none());
        assert_eq!(
            retained.rule.action,
            kcoder_types::McpApplicationAction::DocumentLookup
        );
        assert_eq!(
            reopened
                .read_application_effect_intent(&intent.effect_operation_id)
                .unwrap(),
            Some(intent)
        );
    }
    #[test]
    fn application_receipt_and_content_commit_together_and_reopen_without_changing_original_intent()
    {
        let (root, store, manifest, receipt, bytes) = fixture();
        let published = store
            .publish_application_artifact(
                "publish-original",
                manifest.clone(),
                &bytes,
                receipt.clone(),
            )
            .unwrap();
        assert_eq!(
            store
                .publish_application_artifact("publish-original", manifest, &bytes, receipt.clone())
                .unwrap(),
            published
        );
        drop(store);
        let reopened =
            OfficeStore::open_existing(&root.path().join("office"), receipt.owner.clone())
                .unwrap()
                .unwrap();
        assert_eq!(
            reopened
                .read_application_receipt(&receipt.artifact)
                .unwrap(),
            Some(receipt.clone())
        );
        assert_eq!(
            reopened
                .read_artifact_chunk(&receipt.artifact, 0, 65536)
                .unwrap()
                .0,
            bytes
        );
        let mut changed = receipt.clone();
        changed.approved_input["body"] = json!("Changed body");
        changed.input_sha256 = digest(&serde_json::to_vec(&changed.approved_input).unwrap());
        assert!(
            reopened
                .publish_application_artifact("publish-changed", published.clone(), &bytes, changed)
                .is_err()
        );
        let mut corrupt = receipt;
        corrupt.actual_result["documentId"] = json!("another-object");
        assert!(
            reopened
                .publish_application_artifact("publish-corrupt", published, &bytes, corrupt)
                .is_err()
        );
    }
    #[test]
    fn old_office_snapshot_without_application_receipts_remains_readable() {
        let (_, store, _, _, _) = fixture();
        let mut old = serde_json::to_value(Snapshot::empty(store.owner.clone())).unwrap();
        old.as_object_mut()
            .unwrap()
            .remove("applicationToolReceipts");
        old.as_object_mut()
            .unwrap()
            .remove("applicationEffectIntents");
        let loaded: Snapshot = serde_json::from_value(old).unwrap();
        loaded.validate().unwrap();
        assert!(loaded.application_tool_receipts.is_empty());
        assert!(loaded.application_effect_intents.is_empty());
    }
}
