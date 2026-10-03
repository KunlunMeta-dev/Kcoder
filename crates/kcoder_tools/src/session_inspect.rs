//! Bounded, current-owner introspection. This is an active-context projection,
//! never an arbitrary filesystem reader or a promise of full persisted history.
use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use kcoder_state::AppStateIdentity;
use kcoder_types::{ContentBlock, Message};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};

const MAX_SNAPSHOTS: usize = 4;
const TTL: Duration = Duration::from_secs(300);
const MAX_BYTES: usize = 1024 * 1024;
const MAX_ROWS: usize = 512;
#[derive(Debug, Clone, Serialize)]
struct Row {
    index: usize,
    role: &'static str,
    text: String,
    truncated: bool,
}
struct Snapshot {
    id: String,
    owner: AppStateIdentity,
    session_id: String,
    created: Instant,
    captured_at_ms: u64,
    rows: Vec<Row>,
    truncated: bool,
}
#[derive(Default)]
pub struct SessionInspectionStore {
    snapshots: Mutex<VecDeque<Snapshot>>,
}
pub type SessionObservation = std::sync::Arc<dyn Fn() -> Value + Send + Sync>;
#[derive(Debug, Default)]
pub struct CtxInspectTool;
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CtxInspectInput {
    /// status (default) or messages. messages returns a bounded active-context snapshot page.
    action: Option<Action>,
    /// Legacy focus filter; searches only the bounded snapshot, not full history.
    query: Option<String>,
    /// Opaque cursor from a previous page. Appending tool messages does not invalidate it.
    cursor: Option<String>,
    /// Maximum rows per page, 1..=20. Default 10.
    limit: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum Action {
    Status,
    Messages,
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn cancelled(ctx: &ToolContext) -> Result<(), ToolError> {
    if ctx
        .abort_token
        .as_ref()
        .is_some_and(|token| token.is_cancelled())
    {
        return Err(ToolError::Execution("CtxInspect cancelled".into()));
    }
    Ok(())
}
fn safe_text(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    if [
        "api_key",
        "api key",
        "authorization",
        "bearer ",
        "password",
        "secret",
        "token=",
        "sk-",
        "sk_",
        "private key",
        "密码",
        "密钥",
        "令牌",
        "cookie:",
    ]
    .iter()
    .any(|key| lower.contains(key))
    {
        return "[credential-like content omitted]".into();
    }
    text.chars()
        .map(|character| {
            if character.is_control() && character != '\n' {
                ' '
            } else {
                character
            }
        })
        .collect()
}

fn rows(ctx: &ToolContext, query: Option<&str>) -> Result<(Vec<Row>, bool), ToolError> {
    let (messages, _) = ctx.state.shared_messages_with_revision();
    let mut rows = Vec::new();
    let mut bytes = 0usize;
    let mut truncated = messages.len() > 8192;
    for (index, message) in messages.iter().enumerate().rev().take(8192) {
        cancelled(ctx)?;
        let (role, content) = match message {
            Message::User { content, .. } if kcoder_types::is_real_user_message(message) => {
                ("user", content)
            }
            Message::Assistant { content, .. } => ("assistant", content),
            _ => continue,
        };
        let mut text = String::new();
        let mut cut = content.len() > 128;
        for block in content.iter().take(128) {
            // No thinking, image/base64, tool arguments/results, runtime or
            // compaction instructions are exposed by this projection.
            if let ContentBlock::Text { text: part } = block {
                let remaining = 2048usize.saturating_sub(text.len());
                let mut end = part.len().min(remaining);
                while !part.is_char_boundary(end) {
                    end -= 1;
                }
                text.push_str(&part[..end]);
                cut |= end < part.len();
            }
        }
        if text.is_empty() {
            continue;
        }
        let text = safe_text(&text);
        if query.is_some_and(|query| !text.to_lowercase().contains(&query.to_lowercase())) {
            continue;
        }
        if rows.len() == MAX_ROWS || bytes + text.len() > MAX_BYTES {
            truncated = true;
            break;
        }
        bytes += text.len();
        rows.push(Row {
            index,
            role,
            text,
            truncated: cut,
        });
    }
    rows.reverse();
    Ok((rows, truncated))
}
#[async_trait]
impl Tool for CtxInspectTool {
    fn name(&self) -> String {
        "CtxInspect".into()
    }
    fn description(&self) -> String {
        "Read current session context estimates/budgets, cumulative usage and subagent capacity. Optional immutable, bounded active_context transcript pages exclude hidden thinking, system/runtime instructions and tool payloads. This is NOT full persisted history; snapshots expire after 5 minutes or four newer snapshots. No paths or other-session identifiers accepted.".into()
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(CtxInspectInput))
    }
    fn is_read_only(&self) -> bool {
        true
    }
    fn is_concurrency_safe(&self, _: &Value) -> bool {
        false
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: CtxInspectInput = parse_input(&input)?;
        cancelled(ctx)?;
        let session_id = ctx.state.session_id();
        if input.query.as_ref().is_some_and(|query| query.len() > 256) {
            return Err(ToolError::Execution("query exceeds 256 bytes".into()));
        }
        if input.cursor.is_some() && input.query.is_some() {
            return Err(ToolError::Execution(
                "query applies only when creating a new snapshot".into(),
            ));
        }
        let limit = input.limit.unwrap_or(10);
        if !(1..=20).contains(&limit) {
            return Err(ToolError::Execution("limit must be 1..=20".into()));
        }
        let mut observation = ctx
            .session_observation
            .as_ref()
            .map(|get| get())
            .unwrap_or_else(|| {
                json!({
                    "available":false,"source":"no_engine_observer","observed_at_ms":now_ms(),
                    "full_request_tokens":null,"cumulative_usage":null
                })
            });
        if let Some(subagents) = observation
            .get_mut("subagents")
            .and_then(Value::as_object_mut)
        {
            subagents.insert(
                "invocation_limit".into(),
                json!(ctx.max_concurrent_subagents),
            );
        }
        let mut result = json!({"observation":observation});
        if matches!(input.action, Some(Action::Messages))
            || input.query.is_some()
            || input.cursor.is_some()
        {
            let fresh = if input.cursor.is_none() {
                Some(rows(ctx, input.query.as_deref())?)
            } else {
                None
            };
            if ctx.state.session_id() != session_id {
                return Err(ToolError::Execution(
                    "session changed during inspection".into(),
                ));
            }
            let mut cache = ctx
                .session_inspection_store
                .snapshots
                .lock()
                .map_err(|_| ToolError::Execution("CtxInspect cache unavailable".into()))?;
            cache.retain(|snapshot| snapshot.created.elapsed() < TTL);
            let (id, offset) = if let Some(cursor) = input.cursor {
                if cursor.len() > 96 {
                    return Err(ToolError::Execution("invalid snapshot cursor".into()));
                }
                let (id, offset) = cursor
                    .split_once(':')
                    .ok_or_else(|| ToolError::Execution("invalid snapshot cursor".into()))?;
                (
                    id.to_owned(),
                    offset
                        .parse::<usize>()
                        .map_err(|_| ToolError::Execution("invalid snapshot offset".into()))?,
                )
            } else {
                while cache.len() >= MAX_SNAPSHOTS {
                    cache.pop_front();
                }
                let id = uuid::Uuid::new_v4().to_string();
                let (rows, truncated) = fresh.unwrap();
                cache.push_back(Snapshot {
                    id: id.clone(),
                    owner: ctx.state.inspection_identity(),
                    session_id: session_id.clone(),
                    created: Instant::now(),
                    captured_at_ms: now_ms(),
                    rows,
                    truncated,
                });
                (id, 0)
            };
            let snapshot = cache.iter().find(|snapshot| snapshot.id == id
                && snapshot.session_id == ctx.state.session_id() && snapshot.owner.matches(&ctx.state))
                .ok_or_else(|| ToolError::Execution("snapshot expired, evicted, or belongs to another session; request a new snapshot".into()))?;
            if offset > snapshot.rows.len() {
                return Err(ToolError::Execution("snapshot offset out of range".into()));
            }
            let end = offset.saturating_add(limit).min(snapshot.rows.len());
            result["transcript"] = json!({"scope":"active_context","selection":"recent_tail","full_persisted_history":false,"query_scope":"bounded_snapshot_not_full_history",
                "runtime_and_compaction_messages_omitted":true,"tool_payloads_omitted":true,"tool_events_omitted":true,
                "captured_at_ms":snapshot.captured_at_ms,"snapshot_truncated":snapshot.truncated,
                "snapshot_rows":snapshot.rows.len(),"scan_message_limit":8192,"row_text_byte_limit":2048,"rows":&snapshot.rows[offset..end],
                "next_cursor":(end < snapshot.rows.len()).then(||format!("{}:{end}",snapshot.id)),
                "ttl_seconds":TTL.as_secs(),"snapshot_limit":MAX_SNAPSHOTS,"snapshot_text_byte_limit":MAX_BYTES});
        }
        cancelled(ctx)?;
        if ctx.state.session_id() != session_id {
            return Err(ToolError::Execution(
                "session changed during inspection".into(),
            ));
        }
        Ok(ToolOutput {
            content: vec![ContentBlock::Text {
                text: result.to_string(),
            }],
            is_error: false,
            execution_metadata: vec![],
            user_context: vec![],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;
    fn context() -> ToolContext {
        ToolContext::new(AppState::with_messages(
            ".",
            (0..5)
                .map(|n| Message::user_text(format!("message {n}")))
                .collect(),
        ))
    }
    async fn call(ctx: &ToolContext, input: Value) -> Value {
        let output = CtxInspectTool.call(input, ctx).await.unwrap();
        let ContentBlock::Text { text } = &output.content[0] else {
            panic!("JSON output")
        };
        serde_json::from_str(text).unwrap()
    }
    #[tokio::test]
    async fn immutable_pages_survive_tool_append_and_reject_other_owner_expiry_and_eviction() {
        let ctx = context();
        let first = call(&ctx, json!({"action":"messages","limit":2})).await;
        let cursor = first["transcript"]["next_cursor"].clone();
        ctx.state
            .add_message(Message::assistant_text("tool call appended after snapshot"));
        let next = call(&ctx, json!({"cursor":cursor,"limit":2})).await;
        assert_eq!(next["transcript"]["rows"][0]["text"], "message 2");
        assert_eq!(next["transcript"]["snapshot_rows"], 5);
        let mut other = context();
        other.session_inspection_store = ctx.session_inspection_store.clone();
        assert!(
            CtxInspectTool
                .call(json!({"cursor":cursor}), &other)
                .await
                .is_err()
        );
        ctx.session_inspection_store.snapshots.lock().unwrap()[0].created = Instant::now() - TTL;
        assert!(
            CtxInspectTool
                .call(json!({"cursor":cursor}), &ctx)
                .await
                .is_err()
        );
        let first = call(&ctx, json!({"action":"messages","limit":1})).await;
        for _ in 0..MAX_SNAPSHOTS {
            call(&ctx, json!({"action":"messages"})).await;
        }
        assert_eq!(
            ctx.session_inspection_store.snapshots.lock().unwrap().len(),
            MAX_SNAPSHOTS
        );
        assert!(
            CtxInspectTool
                .call(json!({"cursor":first["transcript"]["next_cursor"]}), &ctx)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn projection_omits_runtime_compaction_thinking_payloads_and_credentials() {
        let ctx = ToolContext::new(AppState::with_messages(
            ".",
            vec![
                Message::runtime_text("SYSTEM_PROMPT_MARKER"),
                Message::compaction_text("COMPACTION_PRIVATE_MARKER"),
                Message::user_text("API_KEY=PRIVATE_CREDENTIAL\nCONTINUATION_SECRET"),
                Message::Assistant {
                    content: vec![
                        ContentBlock::Thinking {
                            thinking: "PRIVATE_THINKING".into(),
                            signature: "private".into(),
                        },
                        ContentBlock::ToolUse {
                            id: "t".into(),
                            name: "x".into(),
                            input: json!({"payload":"GIANT_PRIVATE".repeat(100_000)}),
                        },
                        ContentBlock::Text {
                            text: "public answer".into(),
                        },
                    ],
                    usage: None,
                },
            ],
        ));
        let result = call(&ctx, json!({"action":"messages"})).await;
        let text = result.to_string();
        for private in [
            "SYSTEM_PROMPT_MARKER",
            "COMPACTION_PRIVATE_MARKER",
            "PRIVATE_CREDENTIAL",
            "CONTINUATION_SECRET",
            "PRIVATE_THINKING",
            "GIANT_PRIVATE",
        ] {
            assert!(!text.contains(private), "{private}");
        }
        assert!(text.contains("public answer"));
        assert_eq!(result["transcript"]["full_persisted_history"], false);
        assert_eq!(result["observation"]["available"], false);
    }
    #[tokio::test]
    async fn recent_tail_limits_query_cancellation_and_schema_are_explicit() {
        let ctx = ToolContext::new(AppState::with_messages(
            ".",
            (0..9000)
                .map(|n| Message::user_text(format!("row {n}")))
                .collect(),
        ));
        let result = call(&ctx, json!({"action":"messages","limit":20})).await;
        assert_eq!(result["transcript"]["snapshot_truncated"], true);
        assert_eq!(result["transcript"]["snapshot_rows"], MAX_ROWS);
        assert_eq!(result["transcript"]["rows"][0]["text"], "row 8488");
        let filtered = call(&ctx, json!({"query":"row 8999"})).await;
        assert_eq!(filtered["transcript"]["rows"][0]["text"], "row 8999");
        assert!(
            CtxInspectTool
                .call(json!({"path":"/etc/shadow"}), &ctx)
                .await
                .is_err()
        );
        assert!(
            CtxInspectTool
                .call(json!({"limit":1000}), &ctx)
                .await
                .is_err()
        );
        assert!(CtxInspectTool.is_read_only());
        assert!(!CtxInspectTool.is_concurrency_safe(&json!({})));
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        assert!(
            CtxInspectTool
                .call(json!({}), &ctx.with_abort_token(token))
                .await
                .is_err()
        );
    }
    #[test]
    fn profiles_have_one_observability_tool_including_nano() {
        assert!(crate::nano_registry().get("CtxInspect").is_some());
        for registry in [crate::default_registry(), crate::core_registry()] {
            let names = registry.names();
            assert!(names.contains(&"CtxInspect".to_string()));
            assert!(!names.contains(&"SessionInspect".to_string()));
        }
    }
}
