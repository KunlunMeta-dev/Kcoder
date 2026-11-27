//! Validation-only model placeholders never enter loaded settings or files.
use super::*;

pub(super) fn model_schema_projection(source: &Value) -> Value {
    let mut value = source.clone();
    if let Some(root) = value.as_object_mut() {
        for field in [
            "context_window_tokens",
            "context_output_headroom",
            "max_tokens",
            "context_hard_input_tokens",
            "auto_compact_threshold_tokens",
            "prefire_threshold_tokens",
            "estimated_tool_growth_tokens",
        ] {
            if root
                .get(field)
                .is_some_and(|value| value.is_u64() || value.is_null())
            {
                root.remove(field);
            }
        }
        if let Some(providers) = root.get_mut("providers").and_then(Value::as_object_mut) {
            for provider in providers.values_mut().filter_map(Value::as_object_mut) {
                project_limits(provider);
                if provider
                    .get("default_model")
                    .is_none_or(|value| value.as_str() == Some(""))
                {
                    provider.insert(
                        "default_model".into(),
                        Value::String("validation-only-model".into()),
                    );
                }
                if let Some(models) = provider.get_mut("models").and_then(Value::as_object_mut) {
                    for model in models.values_mut().filter_map(Value::as_object_mut) {
                        project_limits(model);
                    }
                }
            }
        }
    }
    value
}

fn project_limits(model: &mut Map<String, Value>) {
    for (field, tokens) in [
        ("context_window_tokens", 1_048_576),
        ("output_headroom_tokens", 8192),
        ("max_output_tokens", 8192),
    ] {
        if model
            .get(field)
            .is_none_or(|value| value.is_u64() || value.is_null())
        {
            model.insert(field.into(), Value::from(tokens));
        }
    }
    if model
        .get("auto_compact_threshold_tokens")
        .is_some_and(|value| value.is_u64() || value.is_null())
    {
        model.remove("auto_compact_threshold_tokens");
    }
}

pub(super) fn retain_unknown_model_limits(document: &mut Value) {
    if let Some(providers) = document.get_mut("providers").and_then(Value::as_object_mut) {
        for provider in providers.values_mut().filter_map(Value::as_object_mut) {
            for field in [
                "context_window_tokens",
                "output_headroom_tokens",
                "max_output_tokens",
            ] {
                if provider.get(field).is_some_and(Value::is_null) {
                    provider.insert(field.into(), Value::from(0));
                }
            }
            provider
                .entry("max_output_tokens")
                .or_insert(Value::from(0));
            if let Some(models) = provider.get_mut("models").and_then(Value::as_object_mut) {
                for model in models.values_mut().filter_map(Value::as_object_mut) {
                    for field in [
                        "context_window_tokens",
                        "output_headroom_tokens",
                        "max_output_tokens",
                    ] {
                        model.entry(field).or_insert(Value::from(0));
                        if model.get(field).is_some_and(Value::is_null) {
                            model.insert(field.into(), Value::from(0));
                        }
                    }
                }
            }
        }
    }
}
