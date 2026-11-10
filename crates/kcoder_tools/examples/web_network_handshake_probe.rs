//! Fixed Exa MCP handshake through Native HTTP; no Engine, model, query or tool execution.
//! Requires KCODER_E2E_WEB_EXTERNAL_NETWORK=1 and accepts no arguments.
//! A fresh private profile uses Native default inherit policy without loading credentials.
//! Stdout is one aggregate JSON document; stderr contains safe phase JSON only.
//! This does not exercise Engine permission, Hook, provider routing or tool-call authority.
use kcoder_tools::{ToolContext, ToolError, web_network};
use reqwest::{
    Method, Url,
    header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderValue, USER_AGENT},
};
use serde_json::{Value, json};
use std::{
    process::ExitCode,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const ENDPOINT: &str = "https://mcp.exa.ai/mcp";
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAIN_SECONDS: u64 = 42;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Failure {
    code: &'static str,
    native_code: Option<u32>,
}
impl Failure {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            native_code: None,
        }
    }
}

fn safe_error(error: ToolError) -> Failure {
    let message = match error {
        ToolError::Aborted => return Failure::new("cancelled"),
        ToolError::InvalidInput(_) => return Failure::new("invalid_input"),
        ToolError::SandboxDenied { .. } => return Failure::new("sandbox_denied"),
        ToolError::Execution(message) => message,
    };
    let code = match message.as_str() {
        "Web request cancelled" => "cancelled",
        "The web destination could not be resolved" => "dns_failed",
        "Web destination resolution timed out" => "dns_timeout",
        "Web destination is restricted by the current target or local-origin authorization" => {
            "destination_or_policy_denied"
        }
        "The web request timed out" => "request_timeout",
        "The web connection failed; check the target network, proxy and certificate policy" => {
            "connect_or_tls_failed"
        }
        "The web request failed" => "request_failed",
        "The target web HTTP client could not be prepared" => "http_client_preparation_failed",
        "The target web CA file could not be opened" => "ca_file_open_failed",
        "The target web CA file could not be read" => "ca_file_read_failed",
        "The target web CA file is invalid" => "ca_file_invalid",
        "The target web CA file contains no certificates" => "ca_file_empty",
        "The target web CA file exceeds the size limit" => "ca_file_too_large",
        _ => "native_execution_failed",
    };
    // Only this exact Native format is permitted to contribute a numeric code.
    let native_code = message
        .strip_prefix("The target Windows automatic proxy resolution failed (WinHTTP ")
        .and_then(|text| text.strip_suffix("); no destination request was sent"))
        .filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|text| text.parse::<u32>().ok());
    Failure {
        code: if native_code.is_some() {
            "winhttp_proxy_resolution_failed"
        } else {
            code
        },
        native_code,
    }
}

fn emit(events: &mut Vec<Value>, value: Value) {
    eprintln!("{value}");
    events.push(value);
}

fn document(step: usize) -> Value {
    match step {
        0 => json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-03-26","capabilities":{},
            "clientInfo":{"name":"kcoder","version":env!("CARGO_PKG_VERSION")}}}),
        1 => json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
        2 => json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        _ => unreachable!("The fixed probe has exactly three handshake steps"),
    }
}

fn headers(session: &Option<HeaderValue>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("KCoder/0.1"));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/event-stream"),
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "MCP-Protocol-Version",
        HeaderValue::from_static("2025-03-26"),
    );
    if let Some(session) = session {
        headers.insert("Mcp-Session-Id", session.clone());
    }
    headers
}

fn result(message: Value, expected: u64) -> Result<Option<Value>, Failure> {
    if message.get("id").and_then(Value::as_u64) != Some(expected) {
        return Ok(None);
    }
    if message.get("error").is_some() {
        return Err(Failure::new("rpc_error"));
    }
    message
        .get("result")
        .cloned()
        .map(Some)
        .ok_or_else(|| Failure::new("rpc_result_missing"))
}

#[derive(Default)]
struct Decoder {
    bytes: Vec<u8>,
    event: Vec<String>,
    received: usize,
}
impl Decoder {
    fn push(&mut self, chunk: &[u8], sse: bool, id: u64) -> Result<Option<Value>, Failure> {
        self.received = self.received.saturating_add(chunk.len());
        if self.received > MAX_BYTES {
            return Err(Failure::new("response_limit"));
        }
        self.bytes.extend_from_slice(chunk);
        if sse {
            let mut consumed = 0;
            while let Some(end) = self.bytes[consumed..]
                .iter()
                .position(|byte| *byte == b'\n')
            {
                let end = consumed + end + 1;
                let line = self.bytes[consumed..end].to_vec();
                consumed = end;
                let line = std::str::from_utf8(&line)
                    .map_err(|_| Failure::new("invalid_utf8"))?
                    .trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    if let Some(value) = self.finish_event(id)? {
                        return Ok(Some(value));
                    }
                } else if let Some(data) = line.strip_prefix("data:") {
                    self.event
                        .push(data.strip_prefix(' ').unwrap_or(data).into());
                }
            }
            self.bytes.drain(..consumed);
        }
        Ok(None)
    }
    fn finish_event(&mut self, id: u64) -> Result<Option<Value>, Failure> {
        if self.event.is_empty() {
            return Ok(None);
        }
        let message = serde_json::from_str(&self.event.join("\n"))
            .map_err(|_| Failure::new("invalid_sse_json"))?;
        self.event.clear();
        result(message, id)
    }
    fn finish(&mut self, sse: bool, id: u64) -> Result<Value, Failure> {
        let value = if sse {
            if !self.bytes.is_empty() {
                let trailing = std::str::from_utf8(&self.bytes)
                    .map_err(|_| Failure::new("invalid_utf8"))?
                    .trim_end_matches('\r');
                if let Some(data) = trailing.strip_prefix("data:") {
                    self.event
                        .push(data.strip_prefix(' ').unwrap_or(data).into());
                }
                self.bytes.clear();
            }
            self.finish_event(id)?
        } else {
            result(
                serde_json::from_slice(&self.bytes).map_err(|_| Failure::new("invalid_json"))?,
                id,
            )?
        };
        value.ok_or_else(|| Failure::new("matching_rpc_response_missing"))
    }
}

async fn handshake(
    context: &ToolContext,
    session: &mut Option<HeaderValue>,
    events: &mut Vec<Value>,
    active: &mut &'static str,
) -> Result<(), Failure> {
    let phases = ["initialize", "initialized_notification", "tools_list"];
    for (step, phase) in phases.into_iter().enumerate() {
        *active = phase;
        let started = Instant::now();
        emit(events, json!({"phase":phase,"event":"started"}));
        let boundary = Arc::new(AtomicBool::new(false));
        let signal = boundary.clone();
        let call = context.clone().with_web_dispatch_check(Arc::new(move || {
            signal.store(true, Ordering::Release);
            Ok(())
        }));
        let request = document(step);
        let response = web_network::send(
            &call,
            Method::POST,
            Url::parse(ENDPOINT).expect("Fixed endpoint is valid"),
            headers(session),
            Some(serde_json::to_vec(&request).expect("Fixed document serializes")),
        )
        .await;
        let mut response = match response {
            Ok(response) => response,
            Err(error) => {
                let failure = safe_error(error);
                emit(
                    events,
                    json!({"phase":phase,"event":"native_http_failed",
                    "elapsedMs":started.elapsed().as_millis() as u64,
                    "dispatchBoundaryReached":boundary.load(Ordering::Acquire),
                    "errorCode":failure.code,"nativeCode":failure.native_code}),
                );
                return Err(failure);
            }
        };
        let status = response.response.status().as_u16();
        let sse = response
            .response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        emit(
            events,
            json!({"phase":phase,"event":"headers_received","httpStatus":status,
            "elapsedMs":started.elapsed().as_millis() as u64,"sse":sse,
            "dispatchBoundaryReached":boundary.load(Ordering::Acquire)}),
        );
        if let Some(value) = response.response.headers().get("Mcp-Session-Id") {
            if value.as_bytes().len() > 512 {
                return Err(Failure::new("session_header_limit"));
            }
            *session = Some(value.clone());
        }
        if !(200..300).contains(&status) {
            return Err(Failure::new("http_non_success"));
        }
        if let Some(id) = request.get("id").and_then(Value::as_u64) {
            let mut decoder = Decoder::default();
            let result = loop {
                let chunk = tokio::select! {
                    biased;
                    _ = context.cancelled() => return Err(Failure::new("cancelled")),
                    chunk = response.response.chunk() => chunk.map_err(|_| Failure::new("response_read_failed"))?,
                };
                match chunk {
                    Some(chunk) => {
                        if let Some(result) = decoder.push(&chunk, sse, id)? {
                            break result;
                        }
                    }
                    None => break decoder.finish(sse, id)?,
                }
            };
            if step == 0
                && (!result.is_object()
                    || result
                        .get("protocolVersion")
                        .and_then(Value::as_str)
                        .is_none())
            {
                return Err(Failure::new("initialize_result_invalid"));
            }
            if step == 2 {
                let tools = result
                    .get("tools")
                    .and_then(Value::as_array)
                    .ok_or_else(|| Failure::new("tools_array_missing"))?;
                if tools.len() > 256 {
                    return Err(Failure::new("tool_count_limit"));
                }
                let available = tools
                    .iter()
                    .any(|tool| tool.get("name").and_then(Value::as_str) == Some("web_search_exa"));
                emit(
                    events,
                    json!({"phase":phase,"event":"catalog_observed","toolCount":tools.len(),
                    "nativeSearchToolAvailable":available}),
                );
                if !available {
                    return Err(Failure::new("native_search_tool_missing"));
                }
            }
            emit(
                events,
                json!({"phase":phase,"event":"completed","bodyBytes":decoder.received,
                "elapsedMs":started.elapsed().as_millis() as u64}),
            );
        } else {
            emit(
                events,
                json!({"phase":phase,"event":"completed",
                "elapsedMs":started.elapsed().as_millis() as u64}),
            );
        }
    }
    Ok(())
}

async fn run(
    context: &ToolContext,
    cancel: &CancellationToken,
    session: &mut Option<HeaderValue>,
    events: &mut Vec<Value>,
    active: &mut &'static str,
) -> Result<(), Failure> {
    *active = "dns";
    let started = Instant::now();
    emit(events, json!({"phase":"dns","event":"started"}));
    let addresses = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::lookup_host(("mcp.exa.ai", 443)),
    )
    .await
    .map_err(|_| Failure::new("dns_timeout"))?
    .map_err(|_| Failure::new("dns_failed"))?
    .take(65)
    .collect::<Vec<_>>();
    let public = addresses
        .iter()
        .filter(|address| web_network::is_public_ip(address.ip()))
        .count();
    let v4 = addresses.iter().filter(|address| address.is_ipv4()).count();
    emit(
        events,
        json!({"phase":"dns","event":"completed","addresses":addresses.len(),
        "ipv4":v4,"ipv6":addresses.len()-v4,"public":public,"nonPublic":addresses.len()-public,
        "diagnosticSnapshotOnly":true,"nativeSendRevalidatesDns":true,
        "elapsedMs":started.elapsed().as_millis() as u64}),
    );
    if addresses.is_empty() || addresses.len() > 64 || public != addresses.len() {
        return Err(Failure::new("dns_destination_restricted"));
    }
    *active = "proxy_resolve";
    let started = Instant::now();
    emit(events, json!({"phase":"proxy_resolve","event":"started"}));
    let selection = web_network::resolve_proxy_for_url(
        &context.effective_web_settings().map_err(safe_error)?.fetch,
        &Url::parse(ENDPOINT).expect("Fixed endpoint is valid"),
        cancel,
    )
    .await
    .map_err(safe_error)?;
    let scheme = selection.as_ref().map(|url| match url.scheme() {
        "http" => "http",
        "https" => "https",
        "socks4" => "socks4",
        "socks5" => "socks5",
        _ => "other",
    });
    emit(
        events,
        json!({"phase":"proxy_resolve","event":"completed",
        "proxyUsed":selection.is_some(),"scheme":scheme,"selectionTimeOnly":true,
        "elapsedMs":started.elapsed().as_millis() as u64}),
    );
    handshake(context, session, events, active).await
}

fn main() -> ExitCode {
    if std::env::var("KCODER_E2E_WEB_EXTERNAL_NETWORK").as_deref() != Ok("1")
        || std::env::args_os().len() != 1
    {
        println!(
            "{}",
            json!({"passed":false,"errorCode":"explicit_consent_and_no_arguments_required",
            "queryCalls":0,"paidModelCalls":0,"fullEngineCall":false})
        );
        return ExitCode::FAILURE;
    }
    let started = Instant::now();
    let profile = match kcoder_config::create_private_temp_dir("kcoder-web-handshake") {
        Ok(profile) => profile,
        Err(_) => {
            println!(
                "{}",
                json!({"passed":false,"errorCode":"owned_profile_unavailable",
            "queryCalls":0,"paidModelCalls":0,"fullEngineCall":false})
            );
            return ExitCode::FAILURE;
        }
    };
    let path = profile.path().to_owned();
    let cancel = CancellationToken::new();
    let context =
        ToolContext::new(kcoder_state::AppState::new(&path)).with_abort_token(cancel.clone());
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            println!(
                "{}",
                json!({"passed":false,"errorCode":"runtime_unavailable",
            "queryCalls":0,"paidModelCalls":0,"fullEngineCall":false})
            );
            return ExitCode::FAILURE;
        }
    };
    let mut events = Vec::new();
    let mut active = "setup";
    let mut session = None;
    let outcome = runtime.block_on(async {
        let deadline = tokio::time::sleep_until(tokio::time::Instant::from_std(
            started + Duration::from_secs(MAIN_SECONDS),
        ));
        tokio::pin!(deadline);
        let result = {
            let work = run(&context, &cancel, &mut session, &mut events, &mut active);
            tokio::pin!(work);
            tokio::select! {
                biased;
                _=&mut deadline=>{cancel.cancel();Err(Failure::new("overall_deadline"))},
                result=&mut work=>result,
            }
        };
        cancel.cancel();
        let observed = session.is_some();
        let remaining = Duration::from_secs(45)
            .saturating_sub(started.elapsed() + Duration::from_millis(250))
            .min(Duration::from_secs(2));
        let cleanup = if let Some(session) = session.take() {
            let cleanup_context = context.clone().with_abort_token(CancellationToken::new());
            tokio::time::timeout(
                remaining,
                web_network::send(
                    &cleanup_context,
                    Method::DELETE,
                    Url::parse(ENDPOINT).expect("Fixed endpoint is valid"),
                    headers(&Some(session)),
                    None,
                ),
            )
            .await
            .map(|value| {
                value
                    .map(|response| response.response.status().is_success())
                    .unwrap_or(false)
            })
            .unwrap_or(false)
        } else {
            true
        };
        emit(
            &mut events,
            json!({"phase":"cleanup","event":"completed","sessionObserved":observed,
            "sessionCleanupConfirmed":cleanup}),
        );
        (result, cleanup)
    });
    // Shutdown is bounded even if the OS DNS implementation is still unwinding.
    runtime.shutdown_timeout(Duration::from_millis(250));
    drop(context);
    drop(profile);
    let cleaned = !path.exists();
    let (outcome, session_cleaned) = outcome;
    let failure = outcome.err().or_else(|| {
        if !session_cleaned {
            Some(Failure::new("session_cleanup_unconfirmed"))
        } else if !cleaned {
            Some(Failure::new("owned_profile_cleanup_failed"))
        } else {
            None
        }
    });
    println!(
        "{}",
        json!({"schemaVersion":1,"endpoint":"fixed_exa_mcp","passed":outcome.is_ok()&&cleaned&&session_cleaned,
        "handshakePassed":outcome.is_ok(),
        "errorCode":failure.map(|error|error.code),"nativeCode":failure.and_then(|error|error.native_code),"activePhase":active,
        "elapsedMs":started.elapsed().as_millis() as u64,"deadlineMs":45000,
        "fullEngineCall":false,"nativeIngress":"kcoder_tools::web_network::send",
        "profile":"fresh_owned_native_defaults","profileRemoved":cleaned,"proxyMode":"inherit",
        "sessionCleanupConfirmed":session_cleaned,
        "queryCalls":0,"toolCalls":0,"paidModelCalls":0,"events":events})
    );
    if outcome.is_ok() && cleaned && session_cleaned {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fixed_handshake_documents_are_emitted() {
        let methods = (0..3)
            .map(|step| document(step)["method"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            ["initialize", "notifications/initialized", "tools/list"]
        );
        assert!(document(1).get("id").is_none());
    }

    #[test]
    fn json_and_chunked_sse_decode_only_the_expected_reply() {
        let mut json = Decoder::default();
        assert!(
            json.push(
                br#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#,
                false,
                1
            )
            .unwrap()
            .is_none()
        );
        assert_eq!(json.finish(false, 1).unwrap()["ok"], true);
        let mut sse = Decoder::default();
        assert!(
            sse.push(b": keepalive\n\ndata: {\"id\":2,\"res", true, 2)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            sse.push(b"ult\":{\"tools\":[]}}\n\n", true, 2)
                .unwrap()
                .unwrap()["tools"],
            json!([])
        );
        let mut eof = Decoder::default();
        eof.push(b"data: {\"id\":2,\"result\":{\"tools\":[]}}", true, 2)
            .unwrap();
        assert_eq!(eof.finish(true, 2).unwrap()["tools"], json!([]));
        let mut comments = Decoder::default();
        let mut bytes = b": keepalive\n\n".repeat(4096);
        bytes.extend_from_slice(b"data: {\"id\":2,\"result\":{\"tools\":[]}}\n\n");
        assert_eq!(
            comments.push(&bytes, true, 2).unwrap().unwrap()["tools"],
            json!([])
        );
    }

    #[test]
    fn invalid_or_excessive_responses_do_not_echo_untrusted_content() {
        let mut decoder = Decoder::default();
        decoder
            .push(b"<html>private token</html>", false, 1)
            .unwrap();
        assert_eq!(
            decoder.finish(false, 1).unwrap_err(),
            Failure::new("invalid_json")
        );
        assert_eq!(
            Decoder::default()
                .push(&vec![0; MAX_BYTES + 1], false, 1)
                .unwrap_err(),
            Failure::new("response_limit")
        );
        assert_eq!(
            result(json!({"id":1,"error":{"message":"private body"}}), 1).unwrap_err(),
            Failure::new("rpc_error")
        );
    }

    #[test]
    fn only_exact_native_winhttp_numeric_errors_are_exported() {
        let failure=safe_error(ToolError::Execution("The target Windows automatic proxy resolution failed (WinHTTP 12180); no destination request was sent".into()));
        assert_eq!(failure.native_code, Some(12180));
        assert_eq!(
            safe_error(ToolError::Execution(
                "secret proxy URL WinHTTP 12180".into()
            ))
            .code,
            "native_execution_failed"
        );
    }
}
