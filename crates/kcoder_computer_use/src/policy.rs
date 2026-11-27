//! Fixed desktop capability surface. Never use the worker as a shell launcher.
use kcoder_types::computer_use::{DESKTOP_PROTOCOL_VERSION, DesktopOperation, DesktopRequest};

pub const MAX_REQUEST_BYTES: usize = 128 * 1024;
pub const TOOLS: &[&str] = &[
    "Snapshot",
    "Screenshot",
    "DisplayInventory",
    "App",
    "Click",
    "Type",
    "Scroll",
    "Move",
    "Shortcut",
    "WaitFor",
];

/// Validate before dispatch; tool-specific schemas are additionally enforced by
/// the fixed upstream worker. This is not a replacement for peer authentication.
pub fn decode_request(bytes: &[u8]) -> Result<DesktopRequest, &'static str> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("request_too_large");
    }
    let request: DesktopRequest = serde_json::from_slice(bytes).map_err(|_| "invalid_request")?;
    if request.protocol_version != DESKTOP_PROTOCOL_VERSION {
        return Err("unsupported_protocol");
    }
    if request.request_id == 0 {
        return Err("invalid_request_id");
    }
    let owner = match &request.operation {
        DesktopOperation::Status => None,
        DesktopOperation::Acquire { owner } => Some(owner),
        DesktopOperation::Stop { owner, lease } => {
            if lease.generation == 0 || uuid::Uuid::parse_str(&lease.id).is_err() {
                return Err("invalid_lease");
            }
            Some(owner)
        }
        DesktopOperation::Call {
            owner,
            lease,
            tool,
            arguments,
        } => {
            if lease.generation == 0 || uuid::Uuid::parse_str(&lease.id).is_err() {
                return Err("invalid_lease");
            }
            if !TOOLS.contains(&tool.as_str()) {
                return Err("tool_not_allowed");
            }
            if !arguments.is_object() {
                return Err("invalid_arguments");
            }
            Some(owner)
        }
    };
    if let Some(owner) = owner {
        for value in [&owner.client_instance, &owner.thread_id, &owner.turn_id] {
            if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
                return Err("invalid_owner");
            }
        }
    }
    Ok(request)
}

/// Screenshot actions require visual input support. Accessibility-only Snapshot
/// remains usable with text models; never silently drop requested visual data.
pub fn observation_arguments(
    tool: &str,
    mut arguments: serde_json::Value,
    vision: bool,
) -> Result<serde_json::Value, &'static str> {
    let object = arguments.as_object_mut().ok_or("invalid_arguments")?;
    if !vision {
        if tool == "Screenshot" {
            return Err(
                "vision_unsupported: use Snapshot without vision or select a model with image input support",
            );
        }
        if tool == "Snapshot" {
            let requested = object.get("use_vision");
            let visual = requested.is_some_and(|value| {
                value == &serde_json::Value::Bool(true)
                    || value
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case("true"))
            });
            if visual {
                return Err(
                    "vision_unsupported: this model cannot consume the requested screenshot; use Snapshot with use_vision=false",
                );
            }
            // Reject malformed flags instead of accepting an unknown truthy value.
            if requested.is_some_and(|value| {
                value != &serde_json::Value::Bool(false)
                    && !value
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case("false"))
            }) {
                return Err("invalid_arguments: use_vision must be a boolean");
            }
            object.insert("use_vision".into(), serde_json::Value::Bool(false));
        }
    }
    Ok(arguments)
}

/// Inventory, cropped captures and an empty Snapshot mode cannot establish
/// current full desktop state for a recovery/input gate.
pub fn supplies_full_observation(tool: &str, arguments: &serde_json::Value) -> bool {
    if !arguments
        .get("region")
        .is_none_or(serde_json::Value::is_null)
    {
        return false;
    }
    let flag = |name: &str, default: bool| match arguments.get(name) {
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::String(value)) if value.eq_ignore_ascii_case("true") => true,
        Some(serde_json::Value::String(value)) if value.eq_ignore_ascii_case("false") => false,
        None => default,
        _ => false,
    };
    match tool {
        "Screenshot" => true,
        "Snapshot" => flag("use_ui_tree", true) || flag("use_vision", false),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn call(tool: &str) -> serde_json::Value {
        json!({"protocolVersion":1,"requestId":1,"operation":{
            "type":"call","owner":{"clientInstance":"client","threadId":"thread","turnId":"turn"},
            "lease":{"id":"c5056c93-5e70-4a42-ab55-2f9f106346ea","generation":1},
            "tool":tool,"arguments":{}
        }})
    }
    #[test]
    fn preserves_explicit_region_for_direct_desktop_capture() {
        for tool in ["Screenshot", "Snapshot"] {
            let input = json!({"region":[10,20,400,300],"display":[0]});
            assert_eq!(
                observation_arguments(tool, input.clone(), true).unwrap(),
                input
            );
        }
    }

    #[test]
    fn text_models_use_accessibility_without_silent_visual_loss() {
        assert!(observation_arguments("Screenshot", json!({}), false).is_err());
        assert_eq!(
            observation_arguments("Snapshot", json!({}), false).unwrap(),
            json!({"use_vision":false})
        );
        for flag in [json!(true), json!("true"), json!(42)] {
            assert!(observation_arguments("Snapshot", json!({"use_vision":flag}), false).is_err());
        }
        let input = json!({"use_vision":true,"use_annotation":false});
        assert_eq!(
            observation_arguments("Snapshot", input.clone(), true).unwrap(),
            input
        );
        assert_eq!(
            observation_arguments("Click", json!({"loc":[2,3]}), false).unwrap(),
            json!({"loc":[2,3]})
        );
    }

    #[test]
    fn permits_only_fixed_desktop_tools_with_explicit_valid_ownership() {
        for tool in TOOLS {
            assert!(decode_request(&serde_json::to_vec(&call(tool)).unwrap()).is_ok());
        }
        for tool in ["PowerShell", "Registry", "FileSystem", "Process", "shell"] {
            assert_eq!(
                decode_request(&serde_json::to_vec(&call(tool)).unwrap()).unwrap_err(),
                "tool_not_allowed"
            );
        }
        let mut value = call("Click");
        value["operation"]["owner"]["turnId"] = json!("");
        assert_eq!(
            decode_request(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
            "invalid_owner"
        );
        let mut value = call("Click");
        value["operation"]["arguments"] = json!([]);
        assert_eq!(
            decode_request(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
            "invalid_arguments"
        );
    }
    #[test]
    fn rejects_oversize_unknown_fields_versions_and_zero_ids() {
        assert_eq!(
            decode_request(&vec![b' '; MAX_REQUEST_BYTES + 1]).unwrap_err(),
            "request_too_large"
        );
        for (key, value, expected) in [
            ("protocolVersion", json!(2), "unsupported_protocol"),
            ("requestId", json!(0), "invalid_request_id"),
            ("command", json!("arbitrary"), "invalid_request"),
        ] {
            let mut frame = call("Screenshot");
            frame[key] = value;
            assert_eq!(
                decode_request(&serde_json::to_vec(&frame).unwrap()).unwrap_err(),
                expected
            );
        }
    }
}
