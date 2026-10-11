//! Execute only the requested authoring operation against a per-sample owned library.
use anyhow::{Result, ensure};
use kcoder_tools::{Tool, ToolContext, workflow_draft::WorkflowDraftTool};
use kcoder_types::workflow::{WorkflowDefinition, WorkflowNode};
use kcoder_workflow::store::WorkflowStore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub struct Fixture {
    root: PathBuf,
    pub draft_id: String,
    pub child_id: String,
}
fn node(value: Value) -> Result<WorkflowNode> {
    Ok(serde_json::from_value(value)?)
}
fn typed_projection(provided: &Value, typed: &Value) -> Value {
    match provided {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        typed_projection(value, typed.get(key).unwrap_or(value)),
                    )
                })
                .collect(),
        ),
        Value::Array(array) => Value::Array(
            array
                .iter()
                .enumerate()
                .map(|(index, value)| typed_projection(value, typed.get(index).unwrap_or(value)))
                .collect(),
        ),
        _ => typed.clone(),
    }
}
pub fn node_semantics(actual: &Value, expected: &Value) -> bool {
    let Ok(expected_typed) = serde_json::from_value::<WorkflowNode>(expected.clone()) else {
        return false;
    };
    let Ok(actual_typed) = serde_json::from_value::<WorkflowNode>(actual.clone()) else {
        return false;
    };
    let Ok(expected_typed) = serde_json::to_value(expected_typed) else {
        return false;
    };
    let Ok(actual_typed) = serde_json::to_value(actual_typed) else {
        return false;
    };
    super::contains_expected(&actual_typed, &typed_projection(expected, &expected_typed))
}
fn safe_domain_paths(error: &str) -> Vec<String> {
    error
        .split_whitespace()
        .filter_map(|text| {
            let text = text.trim_end_matches(':');
            let path = if text.starts_with("input_schema/") {
                format!("/{text}")
            } else if text == "input_schema" {
                "/input_schema".into()
            } else if text.starts_with('/') || text.contains("/config/") {
                text.into()
            } else {
                return None;
            };
            (path.len() <= 256
                && path
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"/_-.".contains(&byte)))
            .then_some(path)
        })
        .take(8)
        .collect()
}
impl Fixture {
    pub fn create(root: &Path) -> Result<Self> {
        let base = root.join("base");
        let store = WorkflowStore::new(base.join("workflow-library"));
        let mut child = store.create("Owned child", "Static authoring fixture; never executed")?;
        for ordinal in 0..3 {
            child=store.upsert_node(&child.id,child.revision,node(json!({"id":"compute","title":"Compute","kind":"code","config":{"code":{"source":format!("return {{score:{}}};",50+ordinal)}}}))?)?;
            if ordinal == 0 {
                child=store.upsert_node(&child.id,child.revision,node(json!({"id":"result","title":"Result","kind":"output","dependsOn":["compute"],"config":{"pointer":"/nodes/compute"}}))?)?;
            }
            child = store.save(&child.id, child.revision)?;
        }
        ensure!(
            child.saved_version == Some(3),
            "owned child must be an actual third saved version"
        );
        let mut draft = store.create(
            "Owned audit draft",
            "Static authoring fixture; never executed",
        )?;
        for id in ["entry", "obsolete"] {
            draft=store.upsert_node(&draft.id,draft.revision,node(json!({"id":id,"title":id,"prompt":"Static authoring fixture only","maxTurns":1}))?)?;
        }
        while draft.revision < 7 {
            draft = store.update_metadata(
                &draft.id,
                draft.revision,
                &draft.title,
                &format!("Static fixture revision {}", draft.revision),
                None,
            )?;
        }
        ensure!(
            draft.revision == 7,
            "owned draft must have actual revision seven"
        );
        Ok(Self {
            root: root.into(),
            draft_id: draft.id,
            child_id: child.id,
        })
    }
    pub fn resolve_case(&self, case: &Value) -> Value {
        fn replace(value: &mut Value, draft: &str, child: &str) {
            match value {
                Value::String(text) => {
                    *text = text
                        .replace("audit-draft", draft)
                        .replace("audit-child", child)
                }
                Value::Object(map) => {
                    for value in map.values_mut() {
                        replace(value, draft, child);
                    }
                }
                Value::Array(array) => {
                    for value in array {
                        replace(value, draft, child);
                    }
                }
                _ => {}
            }
        }
        let mut resolved = case.clone();
        replace(&mut resolved, &self.draft_id, &self.child_id);
        resolved
    }
    pub async fn call(
        &self,
        index: usize,
        variant: &str,
        input: &Value,
        expected: &Value,
    ) -> Result<Value> {
        // Reject every operation outside this predeclared private authoring request.
        if input.get("action") != expected.get("action")
            || (expected.get("id").is_some() && input.get("id") != expected.get("id"))
        {
            return Ok(
                json!({"invoked":false,"accepted":false,"persistedSemanticsValid":false,"category":"unexpected_action_or_owned_id"}),
            );
        }
        let root = self.root.join(format!("case-{index}-{variant}"));
        copy_tree(&self.root.join("base"), &root)?;
        let store = WorkflowStore::new(root.join("workflow-library"));
        let before = serde_json::to_value(store.read(&self.draft_id)?)?;
        let before_library_hash = format!(
            "{:x}",
            Sha256::digest(std::fs::read(root.join("workflow-library/library.json"))?)
        );
        let ctx = ToolContext::new(kcoder_state::AppState::new(root.join("workspace-state")))
            .with_settings_persistence_path(Some(root.join("settings.json")));
        let canonical_schema = input.get("input_schema").cloned().or_else(|| {
            input
                .get("input_schema_json")
                .and_then(Value::as_str)
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
        });
        let result = WorkflowDraftTool.call(input.clone(), &ctx).await;
        if let Err(error) = result {
            let error_text = error.to_string();
            let domain_paths = safe_domain_paths(&error_text);
            // Only fixed categories and request-derived paths survive; no returned value is retained.
            let category =
                if error_text.contains("workflow_schema") || error_text.contains("schema") {
                    "schema_contract"
                } else if error_text.contains("mutually exclusive") {
                    "conflicting_lossless_channels"
                } else if error_text.contains("revision") || error_text.contains("conflict") {
                    "revision_conflict"
                } else if error_text.contains("JSON") || error_text.contains("json") {
                    "json_or_node_contract"
                } else {
                    "authoring_rejected"
                };
            return Ok(
                json!({"invoked":true,"accepted":false,"persistedSemanticsValid":false,"category":category,"domainErrorPaths":domain_paths,"canonicalSyntheticInputSchema":canonical_schema,"failureLibraryBytesUnchanged":format!("{:x}",Sha256::digest(std::fs::read(root.join("workflow-library/library.json"))?))==before_library_hash,"failureDraftUnchanged":serde_json::to_value(store.read(&self.draft_id)?)?==before}),
            );
        }
        let action = expected["action"].as_str().unwrap_or("");
        let persisted = match action {
            "create" => {
                let found = store
                    .list()?
                    .into_iter()
                    .find(|draft| Some(draft.title.as_str()) == expected["title"].as_str());
                match found {
                    Some(created) => serde_json::to_value(store.read(&created.id)?)?,
                    None => Value::Null,
                }
            }
            _ => serde_json::to_value(store.read(&self.draft_id)?)?,
        };
        let valid = match action {
            "create" => {
                super::contains_expected(&persisted["inputSchema"], &expected["input_schema"])
            }
            "upsert_node" => {
                // The wire contract uses f64 for predicate values; compare real typed nodes.
                // Opaque input schemas/defaults above remain exact JSON values.
                persisted["nodes"].as_array().is_some_and(|nodes| {
                    nodes
                        .iter()
                        .any(|node| node_semantics(node, &expected["node"]))
                })
            }
            "patch_nodes" => persisted["nodes"].as_array().is_some_and(|nodes| {
                !nodes.iter().any(|node| node["id"] == "obsolete")
                    && nodes.iter().any(|node| node["id"] == "entry")
            }),
            "save" => {
                persisted["savedVersion"] == 1 && store.read_saved(&self.draft_id, Some(1)).is_ok()
            }
            _ => false,
        };
        let changed_revision = action == "create" || persisted["revision"].as_u64() == Some(8);
        let child_intact: WorkflowDefinition = store.read_saved(&self.child_id, Some(3))?;
        Ok(
            json!({"invoked":true,"accepted":true,"persistedSemanticsValid":valid&&changed_revision,"category":"owned_authoring_only","canonicalSyntheticInputSchema":canonical_schema,"actualRevisionTransitionValid":changed_revision,"childVersionIntact":child_intact.saved_version==Some(3),"nodesExecuted":false}),
        )
    }
}
fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let metadata = entry.file_type()?;
        let child = target.join(entry.file_name());
        ensure!(
            !metadata.is_symlink(),
            "owned fixture cannot contain symlinks"
        );
        if metadata.is_dir() {
            copy_tree(&entry.path(), &child)?;
        } else {
            ensure!(
                metadata.is_file(),
                "owned fixture cannot contain special files"
            );
            std::fs::copy(entry.path(), child)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_default_error_prefix_is_retained_without_echoing_the_value() {
        let error = "workflow_schema: input_schema/properties/matrix/default does not match its schema at /0 (PRIVATE_VALUE is not array)";
        assert_eq!(
            safe_domain_paths(error),
            vec!["/input_schema/properties/matrix/default", "/0"]
        );
        assert!(
            !serde_json::to_string(&safe_domain_paths(error))
                .unwrap()
                .contains("PRIVATE_VALUE")
        );
    }
}
