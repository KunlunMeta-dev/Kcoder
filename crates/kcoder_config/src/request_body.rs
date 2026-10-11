//! Shared validation for user-configured model request extensions.
use anyhow::{Result, bail};
use serde_json::{Map, Value};

pub const MAX_EXTRA_BODY_BYTES: usize = 64 * 1024;

/// Validate extension data without echoing user values in diagnostics.
/// Unknown vendor parameters remain supported; the runtime owns these fields.
pub fn validate_extra_body(body: &Map<String, Value>) -> Result<()> {
    for field in [
        "model",
        "messages",
        "input",
        "system",
        "instructions",
        "tools",
        "stream",
    ] {
        if body.contains_key(field) {
            bail!(
                "extra_body cannot override runtime-owned field '{field}'; remove this field from the model configuration"
            );
        }
    }
    if serde_json::to_vec(body)?.len() > MAX_EXTRA_BODY_BYTES {
        bail!("extra_body must not exceed 64 KiB; reduce the model request extensions");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_structure_is_rejected_without_exposing_values() {
        for field in [
            "model",
            "messages",
            "input",
            "system",
            "instructions",
            "tools",
            "stream",
        ] {
            let body = Map::from_iter([(field.into(), Value::String("PRIVATE_SENTINEL".into()))]);
            let error = validate_extra_body(&body).unwrap_err().to_string();
            assert!(error.contains(field));
            assert!(!error.contains("PRIVATE_SENTINEL"));
        }
    }

    #[test]
    fn vendor_parameters_and_exact_size_boundary_are_supported() {
        let value = serde_json::json!({"thinking":{"type":"enabled","budget_tokens":2048},"temperature":0.2,"vendor_extension":true});
        validate_extra_body(value.as_object().unwrap()).unwrap();
        let mut body = Map::from_iter([(
            "x".into(),
            Value::String("a".repeat(MAX_EXTRA_BODY_BYTES - 8)),
        )]);
        assert_eq!(
            serde_json::to_vec(&body).unwrap().len(),
            MAX_EXTRA_BODY_BYTES
        );
        validate_extra_body(&body).unwrap();
        body.insert(
            "x".into(),
            Value::String("a".repeat(MAX_EXTRA_BODY_BYTES - 7)),
        );
        assert!(validate_extra_body(&body).is_err());
    }
}
