use crate::context::tokens::StaticPrefixMeasurement;
use kcoder_types::{MessagesRequest, ToolDefinition};
use serde_json::Value;
use std::sync::Mutex;

const MAX_TOOLS: usize = 128;
const MAX_NODES: usize = 16_384;
const MAX_STRING_BYTES: usize = 512 * 1024;
const MAX_SERIALIZED_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub(super) struct ToolSerializationCache(Mutex<Cache>);

#[derive(Default)]
struct Cache {
    entry: Option<Entry>,
    hits: u64,
    misses: u64,
    invalidations: u64,
    bypasses: u64,
}

struct Entry {
    tools: Vec<ToolDefinition>,
    serialized: Vec<String>,
}

impl ToolSerializationCache {
    pub(super) fn measure(&self, request: &MessagesRequest) -> StaticPrefixMeasurement {
        let Ok(mut cache) = self.0.try_lock() else {
            return StaticPrefixMeasurement::new(request);
        };
        if let Some(entry) = &cache.entry
            && same_tools(&entry.tools, &request.tools)
        {
            let measurement =
                StaticPrefixMeasurement::from_serialized_tools(request, &entry.serialized);
            cache.hits = cache.hits.saturating_add(1);
            return measurement;
        }
        cache.misses = cache.misses.saturating_add(1);
        if cache.entry.take().is_some() {
            cache.invalidations = cache.invalidations.saturating_add(1);
        }
        if !within_bounds(&request.tools) {
            cache.bypasses = cache.bypasses.saturating_add(1);
            return StaticPrefixMeasurement::new(request);
        }
        let mut serialized = Vec::with_capacity(request.tools.len());
        let mut bytes = 0usize;
        for tool in &request.tools {
            #[cfg(test)]
            crate::context::tokens::STATIC_TOOL_SERIALIZATIONS
                .with(|count| count.set(count.get() + 1));
            let Ok(json) = serde_json::to_string(tool) else {
                cache.bypasses = cache.bypasses.saturating_add(1);
                return StaticPrefixMeasurement::new(request);
            };
            bytes = bytes.saturating_add(json.capacity());
            if bytes > MAX_SERIALIZED_BYTES {
                cache.bypasses = cache.bypasses.saturating_add(1);
                return StaticPrefixMeasurement::new(request);
            }
            serialized.push(json);
        }
        let measurement = StaticPrefixMeasurement::from_serialized_tools(request, &serialized);
        let tools = request.tools.clone();
        if within_bounds(&tools) {
            cache.entry = Some(Entry { tools, serialized });
        } else {
            cache.bypasses = cache.bypasses.saturating_add(1);
        }
        measurement
    }
}

fn same_tools(left: &[ToolDefinition], right: &[ToolDefinition]) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(a, b)| {
            a.name == b.name
                && a.description == b.description
                && same_json(&a.input_schema, &b.input_schema)
        })
}

// Compare wire content, not Value equality: JSON distinguishes -0.0 from 0.0.
fn same_json(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.to_string() == b.to_string(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_json(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b)
                    .all(|((ka, a), (kb, b))| ka == kb && same_json(a, b))
        }
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        _ => false,
    }
}

fn within_bounds(tools: &[ToolDefinition]) -> bool {
    fn visit(value: &Value, depth: usize, nodes: &mut usize, bytes: &mut usize) -> bool {
        if depth > 64 || *nodes == 0 {
            return false;
        }
        *nodes -= 1;
        match value {
            Value::String(text) => *bytes = bytes.saturating_add(text.capacity()),
            Value::Number(number) => *bytes = bytes.saturating_add(number.to_string().len()),
            Value::Array(items) => {
                if items.capacity() > *nodes {
                    return false;
                }
                *nodes -= items.capacity() - items.len();
                for item in items {
                    if !visit(item, depth + 1, nodes, bytes) {
                        return false;
                    }
                }
            }
            Value::Object(items) => {
                if items.len() > *nodes {
                    return false;
                }
                for (key, item) in items {
                    *bytes = bytes.saturating_add(key.capacity());
                    if !visit(item, depth + 1, nodes, bytes) {
                        return false;
                    }
                }
            }
            _ => {}
        }
        *bytes <= MAX_STRING_BYTES
    }
    if tools.len() > MAX_TOOLS {
        return false;
    }
    let mut nodes = MAX_NODES;
    let mut bytes = 0usize;
    for tool in tools {
        bytes = bytes
            .saturating_add(tool.name.capacity())
            .saturating_add(tool.description.capacity());
        if bytes > MAX_STRING_BYTES || !visit(&tool.input_schema, 0, &mut nodes, &mut bytes) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> MessagesRequest {
        MessagesRequest::new("fixture", vec![]).with_tools(vec![ToolDefinition {
            name: "fixture".into(),
            description: "中文 🦀".into(),
            input_schema: serde_json::json!({"type":"object","default":-0.0}),
        }])
    }

    fn check(cache: &ToolSerializationCache, request: &MessagesRequest) {
        let actual = cache.measure(request);
        let expected = StaticPrefixMeasurement::new(request);
        assert_eq!(actual.fingerprint(), expected.fingerprint());
        assert_eq!(actual.padded_tokens(), expected.padded_tokens());
    }

    #[test]
    fn exact_final_definitions_reuse_and_invalidate() {
        let cache = ToolSerializationCache::default();
        let mut request = request();
        check(&cache, &request);
        check(&cache, &request);
        assert_eq!(cache.0.lock().unwrap().hits, 1);
        request.tools[0].input_schema["default"] = serde_json::json!(0.0);
        check(&cache, &request);
        request.tools[0].description.push_str(" changed");
        check(&cache, &request);
        request.tools[0].name = "renamed".into();
        check(&cache, &request);
        request.tools.push(ToolDefinition {
            name: "extra".into(),
            description: "".into(),
            input_schema: serde_json::json!({}),
        });
        check(&cache, &request);
        request.tools.reverse();
        check(&cache, &request);
        request.tools.remove(0);
        check(&cache, &request);
        assert_eq!(cache.0.lock().unwrap().invalidations, 6);
        request.system = Some("new system".into());
        request.path_first_tools = true;
        check(&cache, &request);
        assert_eq!(cache.0.lock().unwrap().hits, 2);
    }

    #[test]
    fn oversized_deep_and_reserved_inputs_bypass_without_retention() {
        let cache = ToolSerializationCache::default();
        let mut request = request();
        check(&cache, &request);
        request.tools[0].description = "x".repeat(MAX_STRING_BYTES + 1);
        check(&cache, &request);
        assert!(cache.0.lock().unwrap().entry.is_none());
        request.tools[0].description.clear();
        request.tools[0].description.shrink_to_fit();
        let mut deep = Value::Null;
        for _ in 0..66 {
            deep = Value::Array(vec![deep]);
        }
        request.tools[0].input_schema = deep;
        check(&cache, &request);
        request.tools[0].input_schema = Value::Array(Vec::with_capacity(MAX_NODES + 1));
        check(&cache, &request);
        request.tools[0].input_schema = Value::String("\0".repeat(256 * 1024));
        check(&cache, &request);
        request.tools[0].input_schema = Value::Null;
        request.tools = vec![request.tools[0].clone(); MAX_TOOLS + 1];
        check(&cache, &request);
        assert_eq!(cache.0.lock().unwrap().bypasses, 5);
        assert!(cache.0.lock().unwrap().entry.is_none());
    }

    #[test]
    fn nested_schema_changes_are_compared_by_wire_content() {
        let cache = ToolSerializationCache::default();
        let mut request = request();
        request.tools[0].input_schema =
            serde_json::json!({"items":[{"value":"中文\n\""}, null, true, 1.0]});
        check(&cache, &request);
        check(&cache, &request);
        request.tools[0].input_schema["items"][0]["value"] = serde_json::json!("changed");
        check(&cache, &request);
        request.tools[0].input_schema["items"][3] = serde_json::json!(1);
        check(&cache, &request);
        assert_eq!(cache.0.lock().unwrap().invalidations, 2);
    }

    #[test]
    fn contended_cache_falls_back_without_waiting() {
        let cache = ToolSerializationCache::default();
        let request = request();
        check(&cache, &request);
        let _held = cache.0.lock().unwrap();
        check(&cache, &request);
    }

    #[test]
    fn engine_static_prefix_path_uses_final_definition_cache() {
        let root = tempfile::tempdir().unwrap();
        let engine =
            crate::test_support::engine_builder::TestEngineBuilder::new(root.path()).build();
        let mut request = request();
        assert!(engine.note_static_prefix(&request).0);
        assert!(!engine.note_static_prefix(&request).0);
        assert_eq!(engine.tool_serialization_cache.0.lock().unwrap().hits, 1);
        request.tools[0].description.push_str(" updated");
        assert!(engine.note_static_prefix(&request).0);
        assert_eq!(
            engine
                .tool_serialization_cache
                .0
                .lock()
                .unwrap()
                .invalidations,
            1
        );
    }
}
