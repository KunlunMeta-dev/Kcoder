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
fn typed_semantics(provided: &Value, expected: &Value, actual: &Value) -> bool {
    match provided {
        Value::Object(map) if expected.is_object() && actual.is_object() => {
            map.iter()
                .all(|(key, value)| match (expected.get(key), actual.get(key)) {
                    (None, None) => true,
                    (Some(expected), Some(actual)) => typed_semantics(value, expected, actual),
                    _ => false,
                })
        }
        _ => actual == expected,
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
    typed_semantics(expected, &expected_typed, &actual_typed)
}

pub fn canonical_expected(value: &Value) -> Result<Value> {
    ensure!(
        value.is_object(),
        "Preregistered authoring input must be an object"
    );
    let mut value = value.clone();
    for field in ["node", "nodes", "definition", "input_schema"] {
        let encoded = format!("{field}_json");
        if let Some(text) = value.get(&encoded) {
            ensure!(
                value.get(field).is_none(),
                "Preregistered authoring channels conflict"
            );
            let text = text
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Preregistered JSON channel must be text"))?;
            let decoded: Value = serde_json::from_str(text)
                .map_err(|_| anyhow::anyhow!("Preregistered JSON channel is invalid"))?;
            let fields = value.as_object_mut().unwrap();
            fields.remove(&encoded);
            fields.insert(field.into(), decoded);
        }
    }
    Ok(value)
}

fn patch_semantics(before: &Value, actual: &Value, expected: &Value) -> bool {
    let (Some(before), Some(actual)) = (before.as_array(), actual.as_array()) else {
        return false;
    };
    let mut wanted: std::collections::BTreeMap<_, _> = before
        .iter()
        .filter_map(|node| node["id"].as_str().map(|id| (id, (node, false))))
        .collect();
    if let Some(removals) = expected.get("remove_node_ids") {
        let Some(removals) = removals.as_array() else {
            return false;
        };
        for id in removals {
            let Some(id) = id.as_str() else {
                return false;
            };
            wanted.remove(id);
        }
    }
    if let Some(nodes) = expected.get("nodes") {
        let Some(nodes) = nodes.as_array() else {
            return false;
        };
        for node in nodes {
            let Some(id) = node["id"].as_str() else {
                return false;
            };
            wanted.insert(id, (node, true));
        }
    }
    actual.len() == wanted.len()
        && actual.iter().all(|node| {
            let Some(id) = node["id"].as_str() else {
                return false;
            };
            let Some((expected, changed)) = wanted.remove(id) else {
                return false;
            };
            if changed {
                node_semantics(node, expected)
            } else {
                node == expected
            }
        })
        && wanted.is_empty()
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
        std::fs::create_dir_all(root)?;
        // The caller owns retention. Keep isolated evidence alive even if an
        // authoring future is dropped while its blocking worker is settling.
        let root = tempfile::Builder::new()
            .prefix("authoring-run-")
            .tempdir_in(root)?
            .keep();
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
            root,
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

    fn owned_target<'a>(&'a self, expected: &'a Value) -> Result<&'a str> {
        let action = expected["action"].as_str().unwrap_or("");
        ensure!(
            matches!(action, "create" | "upsert_node" | "patch_nodes" | "save"),
            "Unsupported preregistered authoring action"
        );
        if action == "create" {
            return Ok(&self.draft_id);
        }
        let id = expected["id"].as_str().unwrap_or("");
        ensure!(
            id == self.draft_id || id == self.child_id,
            "Preregistered authoring target must be an owned fixture"
        );
        Ok(id)
    }

    pub fn validate_expected(&self, expected: &Value) -> Result<()> {
        self.owned_target(&canonical_expected(expected)?)
            .map(|_| ())
    }

    pub async fn call(
        &self,
        index: usize,
        _variant: &str,
        input: &Value,
        expected: &Value,
    ) -> Result<Value> {
        let canonical = canonical_expected(expected)?;
        let expected = &canonical;
        let Ok(target_id) = self.owned_target(expected) else {
            return Ok(
                json!({"invoked":false,"accepted":false,"persistedSemanticsValid":false,
                "category":"invalid_preregistered_owned_target"}),
            );
        };
        // Reject every operation outside this predeclared private authoring request.
        if input.get("action") != expected.get("action")
            || (expected.get("id").is_some() && input.get("id") != expected.get("id"))
        {
            return Ok(
                json!({"invoked":false,"accepted":false,"persistedSemanticsValid":false,"category":"unexpected_action_or_owned_id"}),
            );
        }
        let root = tempfile::Builder::new()
            .prefix(&format!("case-{index}-"))
            .tempdir_in(&self.root)?
            .keep();
        copy_tree(&self.root.join("base"), &root)?;
        let store = WorkflowStore::new(root.join("workflow-library"));
        let before = serde_json::to_value(store.read(target_id)?)?;
        let before_draft = serde_json::to_value(store.read(&self.draft_id)?)?;
        let before_ids: std::collections::BTreeSet<_> =
            store.list()?.into_iter().map(|row| row.id).collect();
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
            let after_library = std::fs::read(root.join("workflow-library/library.json")).ok();
            let after_target = store
                .read(target_id)
                .ok()
                .and_then(|row| serde_json::to_value(row).ok());
            let after_draft = store
                .read(&self.draft_id)
                .ok()
                .and_then(|row| serde_json::to_value(row).ok());
            let readback_confirmed =
                after_library.is_some() && after_target.is_some() && after_draft.is_some();
            return Ok(
                json!({"invoked":true,"accepted":false,"persistedSemanticsValid":false,
                "category":category,"domainErrorPaths":domain_paths,"canonicalSyntheticInputSchema":canonical_schema,
                "failureReadback":if readback_confirmed {"confirmed"}else{"unknown"},
                "failureLibraryBytesUnchanged":after_library.is_some_and(|bytes|format!("{:x}",Sha256::digest(bytes))==before_library_hash),
                "failureTargetUnchanged":after_target.as_ref()==Some(&before),
                "failureDraftUnchanged":after_draft.as_ref()==Some(&before_draft)}),
            );
        }
        let action = expected["action"].as_str().unwrap_or("");
        let persisted = match action {
            "create" => {
                let mut created = store
                    .list()?
                    .into_iter()
                    .filter(|row| !before_ids.contains(&row.id));
                match (created.next(), created.next()) {
                    (Some(created), None) => serde_json::to_value(store.read(&created.id)?)?,
                    _ => Value::Null,
                }
            }
            _ => serde_json::to_value(store.read(target_id)?)?,
        };
        let valid = match action {
            "create" => {
                persisted["title"] == expected["title"]
                    && super::contains_expected(
                        &persisted["inputSchema"],
                        &expected["input_schema"],
                    )
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
            "patch_nodes" => patch_semantics(&before["nodes"], &persisted["nodes"], expected),
            "save" => {
                let next_version = if before["status"] == "saved" {
                    before["savedVersion"].as_u64().unwrap_or(0)
                } else {
                    before["savedVersion"].as_u64().unwrap_or(0) + 1
                };
                persisted["savedVersion"] == next_version
                    && store.read_saved(target_id, Some(next_version)).is_ok()
            }
            _ => false,
        };
        let changed_revision = if action == "create" {
            !persisted.is_null()
        } else {
            before["revision"].as_u64().is_some_and(|value| {
                value.checked_add(1) == persisted["revision"].as_u64()
                    || (persisted["revision"].as_u64() == Some(value) && before == persisted)
            })
        };
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
    fn explicit_serialization_defaults_have_the_same_owned_node_semantics() {
        let expected = json!({"id":"entry","title":"Entry","kind":"agent",
            "config":{},"runIf":null,"prompt":"Synthetic prompt"});
        let actual = json!({"id":"entry","title":"Entry","prompt":"Synthetic prompt"});
        assert!(node_semantics(&actual, &expected));
        let mut changed = actual;
        changed["prompt"] = json!("Different prompt");
        assert!(!node_semantics(&changed, &expected));
        let changed = json!({"id":"entry","title":"Entry","prompt":"Synthetic prompt",
            "config":{"resultCheck":{"source":"return false;"}}});
        assert!(
            !node_semantics(&changed, &expected),
            "explicit defaults cannot admit a nondefault postcondition"
        );
        let expected = json!({"id":"entry","config":{"outputSchema":{}}});
        let actual = json!({"id":"entry","config":{"outputSchema":false}});
        assert!(
            !node_semantics(&actual, &expected),
            "opaque object and boolean schemas remain distinct"
        );
    }

    #[tokio::test]
    async fn missing_predeclared_target_never_invokes_authoring() {
        let root = tempfile::tempdir().unwrap();
        let fixture = Fixture::create(root.path()).unwrap();
        let child = WorkflowStore::new(fixture.root.join("base/workflow-library"))
            .read(&fixture.child_id)
            .unwrap();
        let input =
            json!({"action":"save","id":fixture.child_id,"expected_revision":child.revision});
        let expected = json!({"action":"save","expected_revision":child.revision});
        let observed = fixture.call(0, "target", &input, &expected).await.unwrap();
        assert_eq!(observed["invoked"], false, "{observed}");
        assert_eq!(observed["persistedSemanticsValid"], false);
    }

    #[tokio::test]
    async fn an_explicit_owned_child_target_is_verified_at_its_own_revision() {
        let root = tempfile::tempdir().unwrap();
        let fixture = Fixture::create(root.path()).unwrap();
        let child = WorkflowStore::new(fixture.root.join("base/workflow-library"))
            .read(&fixture.child_id)
            .unwrap();
        let input =
            json!({"action":"save","id":fixture.child_id,"expected_revision":child.revision});
        let observed = fixture.call(0, "child", &input, &input).await.unwrap();
        assert_eq!(observed["accepted"], true, "{observed}");
        assert_eq!(observed["persistedSemanticsValid"], true, "{observed}");
        assert_eq!(observed["childVersionIntact"], true);
        assert_eq!(observed["nodesExecuted"], false);
    }

    #[tokio::test]
    async fn child_patch_uses_declared_removals_instead_of_draft_node_names() {
        let root = tempfile::tempdir().unwrap();
        let fixture = Fixture::create(root.path()).unwrap();
        let child = WorkflowStore::new(fixture.root.join("base/workflow-library"))
            .read(&fixture.child_id)
            .unwrap();
        let input = json!({"action":"patch_nodes","id":fixture.child_id,
            "expected_revision":child.revision,"remove_node_ids":["result"]});
        let observed = fixture
            .call(0, "child-patch", &input, &input)
            .await
            .unwrap();
        assert_eq!(observed["accepted"], true, "{observed}");
        assert_eq!(observed["persistedSemanticsValid"], true, "{observed}");
        assert_eq!(observed["childVersionIntact"], true);
    }

    #[tokio::test]
    async fn lossless_predeclared_schema_and_native_input_have_the_same_oracle() {
        let root = tempfile::tempdir().unwrap();
        let fixture = Fixture::create(root.path()).unwrap();
        let input = json!({"action":"create","title":"Owned lossless oracle",
            "input_schema":{"type":"object","properties":{"score":{"type":"integer","default":3}}}});
        let mut expected = input.clone();
        expected.as_object_mut().unwrap().remove("input_schema");
        expected["input_schema_json"] = json!(input["input_schema"].to_string());
        let observed = fixture.call(0, "oracle", &input, &expected).await.unwrap();
        assert_eq!(observed["accepted"], true, "{observed}");
        assert_eq!(observed["persistedSemanticsValid"], true, "{observed}");
    }

    #[test]
    fn fixture_lifetimes_have_separate_bases_and_preserve_their_parent() {
        let parent = tempfile::tempdir().unwrap();
        std::fs::write(parent.path().join("peer.txt"), b"owned parent evidence").unwrap();
        let first = Fixture::create(parent.path()).unwrap();
        let second = Fixture::create(parent.path()).unwrap();
        assert_ne!(first.root, second.root);
        assert_eq!(
            std::fs::read(parent.path().join("peer.txt")).unwrap(),
            b"owned parent evidence"
        );
    }

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
