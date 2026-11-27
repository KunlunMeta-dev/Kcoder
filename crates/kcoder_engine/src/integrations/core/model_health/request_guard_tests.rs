//! Final actual Provider request checks, independent of caller preview requirements.
use super::tests::{inner, request, selection, settings};
use super::*;
use crate::{
    integrations::core::resolve_integration_model_selection,
    test_support::engine_builder::TestEngineBuilder,
};
use kcoder_types::{ContentBlock, ImageSource, Message, ToolDefinition};
use std::sync::atomic::Ordering;

fn bound(
    settings: kcoder_config::Settings,
    root: &std::path::Path,
) -> (QueryEngine, Arc<super::tests::Inner>) {
    let provider = inner(0);
    let requested = selection(&settings);
    let engine = TestEngineBuilder::new(root)
        .settings(settings)
        .provider(provider.clone())
        .build_with_profile_directory();
    let resolved = resolve_integration_model_selection(&engine, &requested).unwrap();
    (
        engine.with_native_auto_model_health(&resolved).unwrap(),
        provider,
    )
}
fn assert_local_denial(
    engine: &QueryEngine,
    request: kcoder_types::MessagesRequest,
    provider: &super::tests::Inner,
) {
    let original = serde_json::to_value(&request).unwrap();
    let error = engine
        .current_provider()
        .stream_messages(request.clone())
        .err()
        .expect("incompatible actual input must be blocked");
    assert!(
        matches!(error,kcoder_api::ApiErrorKind::Api {error_type,..} if error_type=="model_auto_input_incompatible")
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    assert_eq!(serde_json::to_value(request).unwrap(), original);
    assert_eq!(
        engine
            .integration_model_health(&engine.active_model_configuration_summary().unwrap())
            .state,
        IntegrationModelHealthState::Unknown
    );
}
#[tokio::test]
async fn final_image_and_nested_tool_result_image_require_actual_model_vision() {
    for nested in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut settings = settings();
        settings.providers.get_mut("A").unwrap().capabilities.vision = false;
        settings.apply_discovered_model("A", "one").unwrap();
        let (engine, provider) = bound(settings, root.path());
        let mut actual = request();
        let image = ContentBlock::Image {
            source: ImageSource::base64("image/png", "iVBORw0KGgo="),
        };
        let block = if nested {
            ContentBlock::ToolResult {
                tool_use_id: "original-native-tool-call".into(),
                content: vec![image],
                is_error: Some(false),
            }
        } else {
            image
        };
        actual.messages.push(Message::user_content(vec![block]));
        assert_local_denial(&engine, actual, &provider);
    }
}
#[tokio::test]
async fn final_tool_schema_is_not_sent_to_a_text_only_model() {
    let root = tempfile::tempdir().unwrap();
    let mut settings = settings();
    settings.providers.get_mut("A").unwrap().capabilities.tools = false;
    settings.apply_discovered_model("A", "one").unwrap();
    let (engine, provider) = bound(settings, root.path());
    let mut actual = request();
    actual.tools.push(ToolDefinition {
        name: "RegisteredRead".into(),
        description: "Original immutable schema".into(),
        input_schema: serde_json::json!({"type":"object"}),
    });
    assert_local_denial(&engine, actual, &provider);
}
#[tokio::test]
async fn final_context_including_system_schema_and_output_reserve_is_checked_after_preview() {
    let root = tempfile::tempdir().unwrap();
    let mut settings = settings();
    settings
        .providers
        .get_mut("A")
        .unwrap()
        .context_window_tokens = 512;
    settings.apply_discovered_model("A", "one").unwrap();
    let (engine, provider) = bound(settings, root.path());
    let mut actual = request();
    actual
        .messages
        .push(Message::user_text("actual final material ".repeat(1000)));
    assert_local_denial(&engine, actual, &provider);
}
#[tokio::test]
async fn policy_version_changed_after_install_blocks_the_next_actual_request() {
    let root = tempfile::tempdir().unwrap();
    let (engine, provider) = bound(settings(), root.path());
    engine
        .settings
        .write()
        .unwrap()
        .integrations
        .core
        .model_policies[0]
        .enabled = false;
    assert_local_denial(&engine, request(), &provider);
}
#[tokio::test]
async fn compatible_final_request_preserves_the_existing_body_and_provider_dispatch() {
    use futures::StreamExt;
    let root = tempfile::tempdir().unwrap();
    let (engine, provider) = bound(settings(), root.path());
    let actual = request();
    let before = serde_json::to_value(&actual).unwrap();
    let events = engine
        .current_provider()
        .stream_messages(actual.clone())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Ok(kcoder_types::StreamEvent::MessageStop)))
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(serde_json::to_value(actual).unwrap(), before);
}

#[tokio::test]
async fn actual_structured_output_requires_configured_and_transport_support() {
    let root = tempfile::tempdir().unwrap();
    let mut settings = settings();
    settings
        .providers
        .get_mut("A")
        .unwrap()
        .capabilities
        .structured_output = false;
    settings.apply_discovered_model("A", "one").unwrap();
    let (engine, provider) = bound(settings, root.path());
    let mut actual = request();
    actual.response_json_schema = Some(kcoder_types::ResponseJsonSchema::new(
        "actual-structured-result",
        serde_json::json!({"type":"object","properties":{"answer":{"type":"string"}}}),
    ));
    assert_local_denial(&engine, actual, &provider);
}
