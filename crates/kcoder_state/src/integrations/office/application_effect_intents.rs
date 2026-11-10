//! Approved intents share the original Office snapshot; NativeOperations owns phase.
use super::*;
use kcoder_types::{
    McpApplicationActionRule,
    integrations::core::{
        IntegrationRevisionRef, IntegrationTaskCapabilitySourceChoice, IntegrationTaskResourceRef,
    },
};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeApplicationEffectIntent {
    pub version: u32,
    pub owner: IntegrationOwner,
    pub task: OfficeTaskRef,
    pub root_operation_id: String,
    pub effect_operation_id: String,
    pub native_call_id: String,
    pub business_action: String,
    pub tool_name: String,
    pub raw_tool_name: String,
    pub server: String,
    pub plugin_id: Option<String>,
    pub source: IntegrationTaskCapabilitySourceChoice,
    pub connection: IntegrationRevisionRef,
    pub resources: Vec<IntegrationTaskResourceRef>,
    pub resource_uris: Vec<String>,
    pub rule: McpApplicationActionRule,
    pub approved_input: Value,
    pub input_sha256: String,
}
impl std::fmt::Debug for OfficeApplicationEffectIntent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OfficeApplicationEffectIntent { private approved input }")
    }
}
impl OfficeApplicationEffectIntent {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1
                && self.rule.action.is_effect()
                && !self.resources.is_empty()
                && self.resources.len() <= 100
                && self.resources.len() == self.resource_uris.len(),
            "OFFICE_APPLICATION_EFFECT_INTENT_INVALID"
        );
        self.source.validate()?;
        for value in [
            &self.root_operation_id,
            &self.effect_operation_id,
            &self.native_call_id,
            &self.business_action,
            &self.tool_name,
            &self.raw_tool_name,
            &self.server,
            &self.connection.id,
            &self.connection.revision,
            &self.task.thread_id,
            &self.task.turn_id,
        ] {
            valid_id(value)?;
        }
        for resource in &self.resources {
            valid_id(&resource.id)?;
            valid_id(&resource.revision)?;
            valid_id(&resource.kind)?;
        }
        ensure!(
            self.input_sha256 == digest(&serde_json::to_vec(&self.approved_input)?)
                && serde_json::to_vec(self)?.len() <= 256 * 1024,
            "OFFICE_APPLICATION_EFFECT_INTENT_INVALID"
        );
        let uri = self
            .rule
            .resource_uri(
                &self.rule.schema_sha256,
                &self.business_action,
                &self.root_operation_id,
                &self.approved_input,
            )
            .context("OFFICE_APPLICATION_EFFECT_INTENT_INVALID")?;
        ensure!(
            self.resource_uris.iter().any(|value| value == uri)
                && self.resource_uris.iter().all(|value| !value.is_empty()
                    && value.len() <= 4096
                    && !value.chars().any(char::is_control)),
            "OFFICE_APPLICATION_EFFECT_INTENT_INVALID"
        );
        Ok(())
    }
}
impl OfficeStore {
    pub fn save_application_effect_intent(
        &self,
        operation: &str,
        intent: OfficeApplicationEffectIntent,
    ) -> Result<OfficeApplicationEffectIntent> {
        intent.validate()?;
        ensure!(intent.owner == self.owner, "OFFICE_OWNER_MISMATCH");
        self.mutate(operation, "application_effect.intent", &intent, |state| {
            if let Some(original) = state
                .application_effect_intents
                .get(&intent.effect_operation_id)
            {
                ensure!(
                    original == &intent,
                    "OFFICE_APPLICATION_EFFECT_INTENT_CONFLICT"
                );
                return Ok(original.clone());
            }
            ensure!(
                state.application_effect_intents.len() < MAX_OPERATIONS,
                "OFFICE_RECEIPT_CAPACITY"
            );
            state
                .application_effect_intents
                .insert(intent.effect_operation_id.clone(), intent.clone());
            Ok(intent.clone())
        })
    }
    pub fn read_application_effect_intent(
        &self,
        effect_operation: &str,
    ) -> Result<Option<OfficeApplicationEffectIntent>> {
        valid_id(effect_operation)?;
        let _lock = self.lock(false)?;
        Ok(self
            .load()?
            .application_effect_intents
            .get(effect_operation)
            .cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::integrations::core::IntegrationNullable;
    use serde_json::json;
    #[test]
    fn approved_effect_intent_survives_reopen_without_fake_result_or_changed_arguments() {
        let root = tempfile::tempdir().unwrap();
        let owner = IntegrationOwner {
            account_id: "owned-account".into(),
            target_id: "owned-target".into(),
            workspace_id: IntegrationNullable::Value("owned-workspace".into()),
            organization_id: None,
        };
        let store = OfficeStore::create(&root.path().join("office"), owner.clone()).unwrap();
        let input = json!({"resourceUri":"owned://selected","operationId":"original","title":"Owned","body":"Exact approved body"});
        let intent=OfficeApplicationEffectIntent{
            version:1,owner:owner.clone(),task:OfficeTaskRef{thread_id:"original-thread".into(),turn_id:"original-turn".into(),run_id:None},
            root_operation_id:"original".into(),effect_operation_id:"original-effect".into(),native_call_id:"actual-approved-call".into(),business_action:"document.create".into(),
            tool_name:"mcp__owned__create".into(),raw_tool_name:"create".into(),server:"owned".into(),plugin_id:None,
            source:serde_json::from_value(json!({"sourceRef":{"id":"actual-source","revision":"original-source-birth"},"accountRef":null})).unwrap(),
            connection:IntegrationRevisionRef{id:"original-connection".into(),revision:"3".into()},
            resources:vec![IntegrationTaskResourceRef{id:"original-resource".into(),revision:"1".into(),kind:"document".into()}],resource_uris:vec!["owned://selected".into()],
            rule:serde_json::from_value(json!({"action":"document.create","schema_sha256":"a".repeat(64),"resource_uri_input_pointer":"/resourceUri","operation_id_input_pointer":"/operationId","input_template":{"resourceUri":null,"operationId":null,"title":null,"body":null},"fields":{"/title":{"type":"string","max_bytes":128},"/body":{"type":"string","max_bytes":128}}})).unwrap(),
            input_sha256:digest(&serde_json::to_vec(&input).unwrap()),approved_input:input,
        };
        assert!(
            store
                .save_application_effect_intent("prepare-original", intent.clone())
                .unwrap()
                == intent
        );
        assert!(store.list_artifacts("original-thread").unwrap().is_empty());
        drop(store);
        let reopened = OfficeStore::open_existing(&root.path().join("office"), owner)
            .unwrap()
            .unwrap();
        assert!(
            reopened
                .read_application_effect_intent("original-effect")
                .unwrap()
                == Some(intent.clone())
        );
        let mut changed = intent;
        changed.approved_input["body"] = json!("Changed body");
        changed.input_sha256 = digest(&serde_json::to_vec(&changed.approved_input).unwrap());
        assert!(
            reopened
                .save_application_effect_intent("different-call", changed)
                .is_err()
        );
        assert!(
            reopened
                .list_artifacts("original-thread")
                .unwrap()
                .is_empty()
        );
    }
}
