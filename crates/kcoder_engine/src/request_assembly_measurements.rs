//! Opt-in local allocation/CPU measurements and isolated Linux RSS probes; no provider calls.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::time::Instant;

#[derive(Clone, Copy, Default)]
struct Allocations {
    calls: u64,
    bytes: u64,
    realloc_calls: u64,
    realloc_bytes: u64,
    free_calls: u64,
    free_bytes: u64,
}

thread_local! {
    static ENABLED: Cell<bool> = const { Cell::new(false) };
    static COUNTS: Cell<Allocations> = const { Cell::new(Allocations {
        calls: 0, bytes: 0, realloc_calls: 0, realloc_bytes: 0, free_calls: 0, free_bytes: 0,
    }) };
}

struct MeteredSystem;
#[global_allocator]
static ALLOCATOR: MeteredSystem = MeteredSystem;

fn record(kind: u8, bytes: usize) {
    if !ENABLED.try_with(Cell::get).unwrap_or(false) {
        return;
    }
    let _ = COUNTS.try_with(|counts| {
        let mut value = counts.get();
        match kind {
            0 => {
                value.calls += 1;
                value.bytes += bytes as u64;
            }
            1 => {
                value.realloc_calls += 1;
                value.realloc_bytes += bytes as u64;
            }
            _ => {
                value.free_calls += 1;
                value.free_bytes += bytes as u64;
            }
        }
        counts.set(value);
    });
}

// SAFETY: all allocation operations are delegated unchanged to System; counters own no memory.
unsafe impl GlobalAlloc for MeteredSystem {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller supplies the GlobalAlloc layout contract.
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            record(0, layout.size());
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forwarding the caller's unchanged allocation request.
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            record(0, layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        record(2, layout.size());
        // SAFETY: forwarding the original pointer and layout to its allocator.
        unsafe { System.dealloc(pointer, layout) };
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        // SAFETY: forwarding the caller's pointer/layout/new size without modification.
        let pointer = unsafe { System.realloc(pointer, layout, size) };
        if !pointer.is_null() {
            record(1, size);
        }
        pointer
    }
}

#[derive(Clone, Copy)]
struct Sample {
    wall_ns: u128,
    cpu_ns: Option<u128>,
    allocations: Allocations,
}

#[cfg(target_os = "linux")]
fn thread_cpu() -> Option<u128> {
    let mut value = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: clock_gettime writes one valid timespec and retains no pointer.
    if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut value) } != 0 {
        return None;
    }
    Some(value.tv_sec as u128 * 1_000_000_000 + value.tv_nsec as u128)
}
#[cfg(not(target_os = "linux"))]
fn thread_cpu() -> Option<u128> {
    None
}

fn measure<T>(work: impl FnOnce() -> T) -> (T, Sample) {
    struct Disable;
    impl Drop for Disable {
        fn drop(&mut self) {
            ENABLED.with(|enabled| enabled.set(false));
        }
    }
    COUNTS.with(|counts| counts.set(Allocations::default()));
    let wall = Instant::now();
    let cpu = thread_cpu();
    ENABLED.with(|enabled| {
        assert!(!enabled.replace(true));
    });
    let guard = Disable;
    let output = std::hint::black_box(work());
    drop(guard);
    let cpu_ns = cpu
        .zip(thread_cpu())
        .map(|(start, end)| end.saturating_sub(start));
    let sample = Sample {
        wall_ns: wall.elapsed().as_nanos(),
        cpu_ns,
        allocations: COUNTS.with(Cell::get),
    };
    (output, sample)
}

#[test]
#[ignore = "allocation instrumentation self-test; run exact in an isolated test process"]
fn allocation_meter_counts_real_heap_and_excludes_another_thread() {
    let (allocation, sample) = measure(|| std::hint::black_box(Box::new([0u8; 128])));
    assert!(sample.allocations.calls > 0);
    assert!(sample.allocations.bytes >= 128);
    drop(allocation);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let other = barrier.clone();
    let worker = std::thread::spawn(move || {
        other.wait();
        drop(std::hint::black_box(Box::new([0u8; 65536])));
        other.wait();
    });
    let (_, isolated) = measure(|| {
        barrier.wait();
        barrier.wait();
    });
    worker.join().unwrap();
    assert_eq!(isolated.allocations.calls, 0);
    assert_eq!(isolated.allocations.bytes, 0);
}

fn fixture_messages(records: usize, damaged: bool) -> Vec<kcoder_types::Message> {
    use kcoder_types::{ContentBlock, Message};
    let mut messages = Vec::with_capacity(records);
    for turn in 0..records / 4 {
        messages.push(Message::user_text("Inspect this fixture. 内容 ".repeat(12)));
        messages.push(Message::Assistant {
            usage: None,
            content: vec![ContentBlock::ToolUse {
                id: format!("call-{turn}"),
                name: "read".into(),
                input: serde_json::json!({"path":"fixture.rs","offset":turn}),
            }],
        });
        messages.push(Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: format!("call-{turn}"),
                is_error: Some(false),
                content: vec![ContentBlock::Text {
                    text: "Result data 示例 ".repeat(32),
                }],
            }],
        });
        messages.push(Message::assistant_text(
            "Result explanation. 解释 ".repeat(12),
        ));
    }
    if damaged {
        messages[records - 2] = Message::user_text("Interrupted fixture result");
    }
    messages
}

fn sampled<T>(
    samples: &mut std::collections::BTreeMap<&'static str, Vec<Sample>>,
    phase: &'static str,
    retain: bool,
    work: impl FnOnce() -> T,
) -> T {
    let (value, sample) = measure(work);
    if retain {
        samples.entry(phase).or_default().push(sample);
    }
    value
}

fn quantiles(mut values: Vec<u128>) -> serde_json::Value {
    values.sort_unstable();
    let at = |p: usize| values[(values.len() * p).div_ceil(100) - 1];
    serde_json::json!({"p50":at(50),"p95":at(95)})
}

fn report(records: usize, damaged: bool, tools: usize, phase: &str, samples: &[Sample]) {
    let cpu = samples
        .iter()
        .map(|sample| sample.cpu_ns)
        .collect::<Option<Vec<_>>>();
    println!(
        "{}",
        serde_json::json!({
            "kind":"phase", "records":records,"damaged_sequence":damaged,"tools":tools,
            "phase":phase,"n":samples.len(),"wall_ns":quantiles(samples.iter().map(|s|s.wall_ns).collect()),
            "thread_cpu_ns":cpu.map(quantiles),
            "alloc_calls":quantiles(samples.iter().map(|s|s.allocations.calls as u128).collect()),
            "realloc_calls":quantiles(samples.iter().map(|s|s.allocations.realloc_calls as u128).collect()),
            "requested_bytes":quantiles(samples.iter().map(|s|(s.allocations.bytes+s.allocations.realloc_bytes) as u128).collect()),
            "free_calls":quantiles(samples.iter().map(|s|s.allocations.free_calls as u128).collect()),
            "freed_bytes":quantiles(samples.iter().map(|s|s.allocations.free_bytes as u128).collect()),
        })
    );
}

#[test]
#[ignore = "isolated registry clone allocation measurement; no provider calls"]
fn tool_registry_clone_measurement() {
    let registry = kcoder_tools::default_registry();
    let tool_count = registry.names().len();
    let mut samples = Vec::new();
    for iteration in 0..23 {
        let (_, sample) = measure(|| {
            for _ in 0..1000 {
                drop(std::hint::black_box(registry.clone()));
            }
        });
        if iteration >= 2 {
            samples.push(sample);
        }
    }
    report(0, false, tool_count, "registry_clone_1000", &samples);
    assert!(
        samples
            .iter()
            .all(|sample| sample.allocations.calls == 0 && sample.allocations.realloc_calls == 0),
        "registry snapshot clones must not allocate payload storage"
    );
}

#[test]
#[ignore = "isolated unchanged-conversation token estimate measurement; no provider calls"]
fn token_estimate_cache_measurement() {
    use crate::context::TokenCounter;
    use crate::context::compact::messages_after_latest_compact_boundary;
    let root = tempfile::tempdir().unwrap();
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path()).build();
    engine.state.set_messages(fixture_messages(2000, false));
    let old = || {
        TokenCounter::count(&messages_after_latest_compact_boundary(
            &engine.state.messages(),
        ))
    };
    assert_eq!(engine.estimated_token_count(), old());
    for (name, cached) in [
        ("token_estimate_old_10", false),
        ("token_estimate_hot_10", true),
    ] {
        let mut samples = Vec::new();
        for iteration in 0..23 {
            let (_, sample) = measure(|| {
                for _ in 0..10 {
                    std::hint::black_box(if cached {
                        engine.estimated_token_count()
                    } else {
                        old()
                    });
                }
            });
            if iteration >= 2 {
                samples.push(sample);
            }
        }
        report(2000, false, 0, name, &samples);
        if cached {
            assert!(samples.iter().all(|sample| sample.allocations.calls == 0));
        }
    }
}

#[test]
#[ignore = "isolated input-hint assembly measurement; no provider calls"]
fn tool_input_hint_measurement() {
    let root = tempfile::tempdir().unwrap();
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
        .tool_registry(kcoder_tools::default_registry())
        .build();
    let mut fallback = engine.clone();
    fallback.tool_input_hints =
        std::sync::Arc::new(crate::tool_input_hints::ToolInputHints::default());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let expected = runtime.block_on(fallback.tool_definitions_for_model());
    let tool_count = expected.len();
    assert_eq!(
        serde_json::to_value(&expected).unwrap(),
        serde_json::to_value(runtime.block_on(engine.tool_definitions_for_model())).unwrap()
    );
    for (name, subject) in [
        ("tool_hint_fallback", &fallback),
        ("tool_hint_cached", &engine),
    ] {
        let mut samples = Vec::new();
        for iteration in 0..23 {
            let (definitions, sample) =
                measure(|| runtime.block_on(subject.tool_definitions_for_model()));
            assert_eq!(definitions.len(), tool_count);
            drop(definitions);
            if iteration >= 2 {
                samples.push(sample);
            }
        }
        report(0, false, tool_count, name, &samples);
    }
}

#[test]
#[ignore = "isolated final static-prefix measurement; no provider calls"]
fn static_prefix_allocation_measurement() {
    use std::hash::{Hash, Hasher};
    let tools = kcoder_tools::default_registry();
    let (definitions, _, _) = crate::tool_schema_runtime::build_tool_caches(&tools);
    let request = kcoder_types::MessagesRequest::new("fixture", vec![]).with_tools(definitions);
    let legacy = || {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        request.system.hash(&mut hasher);
        let mut raw = 0;
        for tool in &request.tools {
            tool.name.hash(&mut hasher);
            let serialized = serde_json::to_string(tool).unwrap_or_default();
            serialized.hash(&mut hasher);
            raw += crate::context::tokens::TokenCounter::rough_char_estimate(&serialized);
        }
        (hasher.finish(), (raw as f64 * (4.0 / 3.0)).ceil() as usize)
    };
    let cache = crate::tool_serialization_cache::ToolSerializationCache::default();
    for (name, mode) in [
        ("static_prefix_legacy", 0),
        ("static_prefix_reuse", 1),
        ("static_prefix_cached", 2),
    ] {
        let mut samples = Vec::new();
        for iteration in 0..23 {
            let (actual, sample) = measure(|| {
                if mode != 0 {
                    let measured = if mode == 2 {
                        cache.measure(&request)
                    } else {
                        crate::context::tokens::StaticPrefixMeasurement::new(&request)
                    };
                    (measured.fingerprint(), measured.padded_tokens())
                } else {
                    legacy()
                }
            });
            assert_eq!(actual, legacy());
            if iteration >= 2 {
                samples.push(sample);
            }
        }
        report(0, false, request.tools.len(), name, &samples);
    }
}

#[test]
#[ignore = "isolated bounded history snapshot measurement; no provider calls"]
fn recent_message_snapshot_measurement() {
    for records in [2000, 20000] {
        let root = tempfile::tempdir().unwrap();
        let state =
            kcoder_state::AppState::with_messages(root.path(), fixture_messages(records, false));
        let all = state.messages();
        assert_eq!(state.recent_messages(8), all[all.len() - 8..]);
        drop(all);
        for (name, bounded) in [
            ("recent_snapshot_legacy", false),
            ("recent_snapshot_bounded", true),
        ] {
            let mut samples = Vec::new();
            for iteration in 0..23 {
                let (count, sample) = measure(|| {
                    let snapshot = if bounded {
                        state.recent_messages(8)
                    } else {
                        state.messages()
                    };
                    std::hint::black_box(snapshot.iter().rev().take(8).count())
                });
                assert_eq!(count, 8);
                if iteration >= 2 {
                    samples.push(sample);
                }
            }
            report(records, false, 0, name, &samples);
        }
    }
}

#[test]
#[ignore = "isolated latest-user query allocation measurement; no provider calls"]
fn latest_user_query_projection_measurement() {
    for records in [2000, 20000] {
        let root = tempfile::tempdir().unwrap();
        let mut messages = fixture_messages(records, false);
        messages.push(kcoder_types::Message::user_text("selected memory query"));
        let state = kcoder_state::AppState::with_messages(root.path(), messages);
        for (name, projected) in [
            ("memory_query_legacy", false),
            ("memory_query_projected", true),
        ] {
            let mut samples = Vec::new();
            for iteration in 0..23 {
                let (selected, sample) = measure(|| {
                    if projected {
                        crate::latest_real_user_text(&state)
                    } else {
                        let snapshot = state.messages();
                        // This fixture ends in a plain user text, so the old selector returns it.
                        match snapshot.last().unwrap() {
                            kcoder_types::Message::User { content, .. } => match &content[0] {
                                kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                                _ => unreachable!(),
                            },
                            _ => unreachable!(),
                        }
                    }
                });
                assert_eq!(selected.as_deref(), Some("selected memory query"));
                if iteration >= 2 {
                    samples.push(sample);
                }
            }
            report(records, false, 0, name, &samples);
        }
    }
}

#[test]
#[ignore = "isolated inactive skill injection allocation check; no provider calls"]
fn inactive_skill_injection_does_not_snapshot_history() {
    let root = tempfile::tempdir().unwrap();
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path()).build();
    engine.active_skills.write().unwrap().clear();
    engine.state.set_messages(fixture_messages(20_000, false));
    let revision = engine.state.message_revision();
    let (_, sample) = measure(|| engine.inject_active_skill_user_context());
    assert_eq!(sample.allocations.calls, 0);
    assert_eq!(sample.allocations.bytes, 0);
    assert_eq!(engine.state.message_revision(), revision);
    report(20_000, false, 0, "inactive_skill_injection", &[sample]);
}

#[test]
#[ignore = "C8 retained-snapshot append prototype; no production container change"]
fn retained_history_snapshot_cow_append_measurement() {
    use std::sync::Arc;
    for records in [2000, 20000] {
        let whole = Arc::new(fixture_messages(records, false));
        let per_message = Arc::new(whole.iter().cloned().map(Arc::new).collect::<Vec<_>>());
        for shared_payload in [false, true] {
            let mut samples = Vec::new();
            for iteration in 0..23 {
                let sample = if shared_payload {
                    let mut current = Arc::clone(&per_message);
                    let (_, sample) = measure(|| {
                        Arc::make_mut(&mut current)
                            .push(Arc::new(kcoder_types::Message::user_text("next")));
                    });
                    assert_eq!(current.len(), records + 1);
                    assert_eq!(per_message.len(), records);
                    assert!(Arc::ptr_eq(&current[0], &per_message[0]));
                    sample
                } else {
                    let mut current = Arc::clone(&whole);
                    let (_, sample) = measure(|| {
                        Arc::make_mut(&mut current).push(kcoder_types::Message::user_text("next"));
                    });
                    assert_eq!(current.len(), records + 1);
                    assert_eq!(whole.len(), records);
                    sample
                };
                if iteration >= 2 {
                    samples.push(sample);
                }
            }
            report(
                records,
                false,
                0,
                if shared_payload {
                    "retained_cow_per_message"
                } else {
                    "retained_cow_whole_vec"
                },
                &samples,
            );
        }
    }
}

#[test]
#[ignore = "isolated fork snapshot handle measurement; no provider calls"]
fn fork_snapshot_handle_measurement() {
    let root = tempfile::tempdir().unwrap();
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path()).build();
    *engine.last_cache_safe_params.write().unwrap() =
        Some(std::sync::Arc::new(crate::agent::CacheSafeParams {
            fork_context_messages: fixture_messages(2000, false).into(),
            active_skills: vec![],
            snapshot_provider: "fixture".into(),
            snapshot_model: "fixture".into(),
            full_context_compatible: true,
        }));
    for (name, shared) in [
        ("fork_snapshot_owned_10", false),
        ("fork_snapshot_shared_10", true),
    ] {
        let mut samples = Vec::new();
        for iteration in 0..23 {
            let (_, sample) = measure(|| {
                for _ in 0..10 {
                    if shared {
                        std::hint::black_box(engine.cache_safe_snapshot().unwrap());
                    } else {
                        std::hint::black_box(engine.last_cache_safe_params().unwrap());
                    }
                }
            });
            if iteration >= 2 {
                samples.push(sample);
            }
        }
        report(2000, false, 0, name, &samples);
    }
}

#[test]
#[ignore = "isolated recent-context boundary measurement; no provider calls"]
fn recent_context_boundary_measurement() {
    for records in [2000, 20000] {
        let messages = fixture_messages(records, false);
        let legacy = || {
            let indices = messages
                .iter()
                .enumerate()
                .filter_map(|(index, message)| {
                    crate::agent::is_real_user_message(message).then_some(index)
                })
                .collect::<Vec<_>>();
            indices.get(indices.len().saturating_sub(2)).copied()
        };
        let expected = legacy();
        for (name, reverse) in [
            ("recent_boundary_legacy", false),
            ("recent_boundary_reverse", true),
        ] {
            let mut samples = Vec::new();
            for iteration in 0..23 {
                let (actual, sample) = measure(|| {
                    if reverse {
                        crate::agent::recent_parent_start(&messages, 2)
                    } else {
                        legacy()
                    }
                });
                assert_eq!(actual, expected);
                if iteration >= 2 {
                    samples.push(sample);
                }
            }
            report(records, false, 0, name, &samples);
        }
    }
}

fn shared_context_fixture(records: usize, summary: bool) -> Vec<kcoder_types::Message> {
    let mut messages = fixture_messages(records, false);
    if summary {
        messages[0] = kcoder_types::Message::user_text(
            "Earlier conversation summary: isolated shared-context fixture",
        );
    }
    messages
}

#[test]
fn shared_context_assembly_matches_owned_control() {
    use crate::message_repair::{prepare_request_messages, prepare_shared_request_messages};
    use kcoder_types::{Message, MessagesRequest};
    for summary in [false, true] {
        for damaged in [false, true] {
            let mut baseline = shared_context_fixture(8, summary);
            if damaged {
                baseline[6] = Message::user_text("interrupted result");
            }
            let (owned, owned_writeback) = prepare_request_messages(baseline.clone());
            let (shared, shared_writeback) = prepare_shared_request_messages(baseline.into());
            assert_eq!(shared, owned);
            assert_eq!(shared_writeback, owned_writeback);
            assert_eq!(owned_writeback.is_some(), damaged);
            let shared_request = MessagesRequest::new_shared("fixture", shared);
            let owned_request = MessagesRequest::new("fixture", owned);
            assert_eq!(
                serde_json::to_value(&shared_request).unwrap(),
                serde_json::to_value(&owned_request).unwrap(),
            );
            let cloned = shared_request.clone();
            assert!(std::ptr::eq(
                cloned.messages.first().unwrap(),
                shared_request.messages.first().unwrap(),
            ));
        }
    }
}

fn shared_context_complete_chain(
    state: &kcoder_state::AppState,
) -> (kcoder_types::MessagesRequest, kcoder_types::SharedMessages) {
    let (raw, _) = state.shared_messages_with_revision();
    let (messages, writeback) = crate::message_repair::prepare_shared_request_messages(raw);
    assert!(writeback.is_none());
    let fork = messages.clone();
    let request = kcoder_types::MessagesRequest::new_shared("fixture", messages);
    (request.clone(), fork)
}

fn owned_context_complete_chain(
    state: &kcoder_state::AppState,
) -> (kcoder_types::MessagesRequest, Vec<kcoder_types::Message>) {
    let (messages, writeback) = crate::message_repair::prepare_request_messages(state.messages());
    assert!(writeback.is_none());
    let fork = messages.clone();
    // This is the current compatibility constructor: it now converts Vec into SharedMessages.
    // Its cost is not the historical pre-migration MessagesRequest constructor's cost.
    let request = kcoder_types::MessagesRequest::new("fixture", messages);
    (request.clone(), fork)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "child of isolated retained-history RSS probe"]
fn shared_context_rss_child() {
    let Ok(mode) = std::env::var("KCODER_TEST_SHARED_RSS_MODE") else {
        return;
    };
    assert!(matches!(mode.as_str(), "shared" | "owned"));
    let root = tempfile::tempdir().unwrap();
    let state =
        kcoder_state::AppState::with_messages(root.path(), shared_context_fixture(20_000, false));
    let rss = || {
        let status = std::fs::read_to_string("/proc/self/status").unwrap();
        let value = |key: &str| {
            status
                .lines()
                .find_map(|line| line.strip_prefix(key))
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        };
        (value("VmRSS:"), value("VmHWM:"))
    };
    let initial = rss();
    let mut shared = Vec::new();
    let mut owned = Vec::new();
    for index in 0..4 {
        if mode == "shared" {
            shared.push(shared_context_complete_chain(&state));
        } else {
            owned.push(owned_context_complete_chain(&state));
        }
        state.add_message(kcoder_types::Message::user_text(format!(
            "appended {index}"
        )));
    }
    for (index, (request, fork)) in shared.iter().enumerate() {
        assert_eq!(request.messages.len(), 20_000 + index);
        assert_eq!(fork.len(), 20_000 + index);
    }
    for (index, (request, fork)) in owned.iter().enumerate() {
        assert_eq!(request.messages.len(), 20_000 + index);
        assert_eq!(fork.len(), 20_000 + index);
    }
    let retained = rss();
    drop((shared, owned, state));
    let released = rss();
    println!(
        "\nSHARED_RSS_RESULT {}",
        serde_json::json!({
            "mode":mode,"initial_rss_kib":initial.0,"retained_rss_kib":retained.0,
            "peak_rss_kib":retained.1,"released_rss_kib":released.0,
            "scope":"four retained request/fork pairs with intervening appends; current owned compatibility control",
        })
    );
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "isolated subprocess RSS; no real model or Windows claim"]
fn shared_context_retained_snapshot_rss() {
    use std::process::{Command, Stdio};
    struct ChildGuard(Option<std::process::Child>);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            if let Some(child) = self.0.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    let mut peaks = Vec::new();
    for mode in ["owned", "shared"] {
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "request_assembly_measurements::shared_context_rss_child",
                "--ignored",
                "--nocapture",
            ])
            .env("KCODER_TEST_SHARED_RSS_MODE", mode)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut guard = ChildGuard(Some(child));
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        while guard.0.as_mut().unwrap().try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "RSS child deadline exceeded");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let output = guard.0.take().unwrap().wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let result = stdout
            .lines()
            .find_map(|line| line.strip_prefix("SHARED_RSS_RESULT "))
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(result).unwrap();
        assert_eq!(value["mode"], mode);
        peaks.push(value["peak_rss_kib"].as_u64().unwrap());
        println!("{result}");
    }
    assert!(
        peaks[1] < peaks[0],
        "shared fixture must retain less peak RSS than owned control"
    );
}

/// Compare actual local message ownership paths, not prototypes or a provider request.
/// Retained fixtures and equality/wire checks stay outside measured regions. Whole-chain samples
/// are measured independently, not synthesized by adding individual stage percentiles.
#[test]
#[ignore = "isolated shared-context production-function measurements; no provider or RSS claims"]
fn shared_context_production_path_measurement() {
    use crate::message_repair::{prepare_request_messages, prepare_shared_request_messages};
    use kcoder_types::MessagesRequest;
    const WARMUPS: usize = 2;
    const SAMPLES: usize = 21;
    let version = std::process::Command::new("rustc")
        .arg("--version")
        .output()
        .unwrap();
    let cpu = std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|line| line.starts_with("model name"))
                .map(str::to_owned)
        });
    println!(
        "{}",
        serde_json::json!({
            "kind":"shared_context_environment", "os":std::env::consts::OS,
            "arch":std::env::consts::ARCH, "cpu":cpu,
            "rustc":String::from_utf8_lossy(&version.stdout).trim(),
            "debug_assertions":cfg!(debug_assertions), "warmups":WARMUPS, "samples":SAMPLES,
            "order":"owned/shared order alternates each iteration",
            "scope":"AppState and production repair/request constructors; no Engine construction, Provider, personal config, prompt injection, tool definitions or MoA",
            "control":"owned compatibility path on current code, not a historical binary: MessagesRequest::new(Vec) now allocates SharedMessages; request.clone shares message payloads on BOTH paths",
            "fork":"shared fork_context_messages field clone versus owned Vec clone; other CacheSafeParams fields excluded",
            "clock":"thread CPU where supported; never wall substituted for CPU",
            "allocation":"successful allocator request/reallocation volume, not serde bytes or live heap",
            "rss":"not measured; fixture retention and allocator reuse prevent interpreting these allocation samples as RSS",
            "complete_chain":"separate measurement including local intermediate drops; stage output drops otherwise excluded",
        })
    );
    for records in [2000, 20000] {
        for summary in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let baseline = shared_context_fixture(records, summary);
            let state = kcoder_state::AppState::with_messages(root.path(), baseline.clone());
            let (retained, revision) = state.shared_messages_with_revision();
            let (oracle, writeback) = prepare_request_messages(baseline.clone());
            assert!(writeback.is_none());
            assert_eq!(oracle, baseline);
            let expected_wire =
                serde_json::to_vec(&MessagesRequest::new("fixture", oracle)).unwrap();
            println!(
                "{}",
                serde_json::json!({
                    "kind":"shared_context_fixture", "records":records, "leading_summary":summary,
                    "tool_pairs":records / 4, "n":SAMPLES,
                    "stage_names":"shared_* and owned_compat_*; fixture boundary supplied by this record",
                })
            );
            let mut samples = std::collections::BTreeMap::new();
            for iteration in 0..WARMUPS + SAMPLES {
                let retain = iteration >= WARMUPS;
                for shared in if iteration % 2 == 0 {
                    [false, true]
                } else {
                    [true, false]
                } {
                    if shared {
                        let (raw, observed_revision) = sampled(
                            &mut samples,
                            "shared_state_snapshot_revision",
                            retain,
                            || state.shared_messages_with_revision(),
                        );
                        assert_eq!(observed_revision, revision);
                        assert!(std::ptr::eq(
                            raw.first().unwrap(),
                            retained.first().unwrap()
                        ));
                        let (messages, writeback) =
                            sampled(&mut samples, "shared_canonical_prepare", retain, || {
                                prepare_shared_request_messages(raw)
                            });
                        assert!(writeback.is_none());
                        assert!(std::ptr::eq(
                            messages.first().unwrap(),
                            retained.first().unwrap()
                        ));
                        let fork =
                            sampled(&mut samples, "shared_fork_messages_clone", retain, || {
                                messages.clone()
                            });
                        let request =
                            sampled(&mut samples, "shared_request_new_shared", retain, || {
                                MessagesRequest::new_shared("fixture", messages)
                            });
                        let cloned =
                            sampled(&mut samples, "shared_request_clone_current", retain, || {
                                request.clone()
                            });
                        let fork_params = crate::agent::CacheSafeParams {
                            fork_context_messages: fork,
                            active_skills: vec![],
                            snapshot_provider: "fixture".into(),
                            snapshot_model: "fixture".into(),
                            full_context_compatible: true,
                        };
                        assert!(std::ptr::eq(
                            fork_params.fork_context_messages.first().unwrap(),
                            retained.first().unwrap()
                        ));
                        assert!(std::ptr::eq(
                            cloned.messages.first().unwrap(),
                            retained.first().unwrap()
                        ));
                        assert_eq!(cloned.messages, baseline);
                        if iteration == 0 {
                            assert_eq!(serde_json::to_vec(&cloned).unwrap(), expected_wire);
                        }
                        assert!(
                            cloned
                                .messages
                                .iter()
                                .zip(retained.iter())
                                .all(|(left, right)| std::ptr::eq(left, right))
                        );
                        drop((cloned, request, fork_params));
                        let ((complete, fork), sample) =
                            measure(|| shared_context_complete_chain(&state));
                        assert_eq!(complete.messages, baseline);
                        assert_eq!(fork, baseline);
                        assert!(std::ptr::eq(
                            complete.messages.first().unwrap(),
                            retained.first().unwrap()
                        ));
                        if retain {
                            samples
                                .entry("shared_complete_chain")
                                .or_default()
                                .push(sample);
                        }
                    } else {
                        let raw =
                            sampled(&mut samples, "owned_compat_state_messages", retain, || {
                                state.messages()
                            });
                        assert!(!std::ptr::eq(
                            raw.first().unwrap(),
                            retained.first().unwrap()
                        ));
                        let (messages, writeback) =
                            sampled(&mut samples, "owned_compat_prepare", retain, || {
                                prepare_request_messages(raw)
                            });
                        assert!(writeback.is_none());
                        let fork =
                            sampled(&mut samples, "owned_compat_fork_vec_clone", retain, || {
                                messages.clone()
                            });
                        let request = sampled(
                            &mut samples,
                            "owned_compat_request_new_now_shared",
                            retain,
                            || MessagesRequest::new("fixture", messages),
                        );
                        let cloned = sampled(
                            &mut samples,
                            "owned_compat_request_clone_current",
                            retain,
                            || request.clone(),
                        );
                        // The control's current request clone is shared too; do not label it a deep clone.
                        assert!(std::ptr::eq(
                            cloned.messages.first().unwrap(),
                            request.messages.first().unwrap()
                        ));
                        assert_eq!(cloned.messages, baseline);
                        assert_eq!(fork, baseline);
                        if iteration == 0 {
                            assert_eq!(serde_json::to_vec(&cloned).unwrap(), expected_wire);
                        }
                        drop((cloned, request, fork));
                        let ((complete, fork), sample) =
                            measure(|| owned_context_complete_chain(&state));
                        assert_eq!(complete.messages, baseline);
                        assert_eq!(fork, baseline);
                        if retain {
                            samples
                                .entry("owned_compat_complete_chain")
                                .or_default()
                                .push(sample);
                        }
                    }
                }
                assert_eq!(state.message_revision(), revision);
            }
            for (phase, values) in &samples {
                // Summary is a fixture tag, not the existing report's damaged-sequence flag.
                let tagged = format!(
                    "{}_{}",
                    if summary { "leading_summary" } else { "plain" },
                    phase
                );
                report(records, false, 0, &tagged, values);
            }
        }
    }
}

/// Execute only with --ignored --exact in a dedicated process. Setup, fixture resets and final
/// drops stay outside regions; operation-owned temporary drops remain part of their real cost.
#[test]
#[ignore = "opt-in instrumented request-assembly measurement; not a provider or RSS benchmark"]
fn request_assembly_stage_measurements() {
    use super::*;
    if std::env::var_os("KCODER_C4_MEASUREMENT_CHILD").is_none() {
        // Set only the child environment: the test harness may have other threads.
        let config = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "request_assembly_measurements::request_assembly_stage_measurements",
                "--nocapture",
            ])
            .env("KCODER_C4_MEASUREMENT_CHILD", "1")
            .env(kcoder_config::CONFIG_DIR_ENV, config.path())
            .env(kcoder_config::KCODER_HOME_ENV, config.path())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(60);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "isolated measurement process failed");
                return;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("isolated measurement process exceeded its time budget");
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    const WARMUPS: usize = 2;
    const SAMPLES: usize = 21;
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("AGENTS.md"), "").unwrap();
    assert_eq!(
        kcoder_config::user_config_dir().unwrap(),
        std::path::PathBuf::from(std::env::var_os(kcoder_config::CONFIG_DIR_ENV).unwrap())
    );
    let mut settings = kcoder_config::Settings::default();
    settings.model_capabilities.tools = true;
    let engine = test_support::engine_builder::TestEngineBuilder::new(temp.path())
        .settings(settings)
        .folder_trusted(Some(false))
        .skill_registry(kcoder_skills::SkillRegistry::empty())
        .memory_manager(kcoder_memory::MemoryManager::global_only(
            kcoder_memory::MemoryStore::empty(),
        ))
        .tool_registry(kcoder_tools::default_registry())
        .build();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let version = std::process::Command::new("rustc")
        .arg("--version")
        .output()
        .unwrap();
    let cpu = std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|line| line.starts_with("model name"))
                .map(str::to_owned)
        });
    println!(
        "{}",
        serde_json::json!({
            "kind":"environment","os":std::env::consts::OS,"arch":std::env::consts::ARCH,
            "rustc":String::from_utf8_lossy(&version.stdout).trim(),"cpu":cpu,
        "debug_assertions":cfg!(debug_assertions),"isolated_config":true,"profile":"cargo test profile; see invocation",
            "warmups":WARMUPS,"samples":SAMPLES,"clock":"CLOCK_THREAD_CPUTIME_ID where supported",
            "allocator":"System with same-thread TLS counters; requested allocation/reallocation volume, not RSS, live heap or serde bytes",
            "scope":"actual assembly functions only; no provider, prompt building, hooks or full turn latency; fixed private fixture inputs",
        })
    );
    let system = "Fixed isolated fixture instructions. ".repeat(128);
    for records in [100, 2000, 20000] {
        for damaged in [false, true] {
            let baseline = fixture_messages(records, damaged);
            let mut samples = std::collections::BTreeMap::new();
            let mut tool_count = 0;
            for iteration in 0..WARMUPS + SAMPLES {
                let retain = iteration >= WARMUPS;
                engine.state.set_messages(baseline.clone());
                let mut raw = sampled(&mut samples, "state_messages_snapshot", retain, || {
                    engine.state.messages()
                });
                let compact = sampled(&mut samples, "compact_view_owned", retain, || {
                    message_repair::take_compact_aware_snapshot(&mut raw)
                });
                let (messages, changed) = sampled(&mut samples, "sequence_repair", retain, || {
                    repair_tool_message_sequence(compact)
                });
                assert_eq!(changed, damaged);
                if changed {
                    sampled(&mut samples, "repair_state_writeback", retain, || {
                        let mut repaired_state = raw;
                        repaired_state.extend(messages.clone());
                        engine.state.set_messages(repaired_state);
                    });
                }
                let fork = sampled(&mut samples, "fork_context_clone", retain, || {
                    messages.clone()
                });
                let definitions = sampled(&mut samples, "tool_definitions_dynamic", retain, || {
                    runtime.block_on(engine.tool_definitions_for_model())
                });
                tool_count = definitions.len();
                assert!(tool_count > 0);
                let request = sampled(&mut samples, "request_fixed_fields", retain, || {
                    MessagesRequest::new("fixture-model", messages)
                        .with_system(system.clone())
                        .with_tools(definitions)
                });
                context::tokens::STATIC_TOOL_SERIALIZATIONS.with(|count| count.set(0));
                let (changed, measurement) =
                    sampled(&mut samples, "static_prefix_note", retain, || {
                        engine.note_static_prefix(&request)
                    });
                let count = sampled(&mut samples, "token_estimate_no_usage", retain, || {
                    TokenCounter::count_request_with_static_prefix(&request, changed, &measurement)
                });
                assert!(count.tokens > 0);
                assert_eq!(
                    context::tokens::STATIC_TOOL_SERIALIZATIONS.with(Cell::get),
                    tool_count,
                    "static tools must remain serialized once, not the former three times"
                );
                let mut owned =
                    sampled(&mut samples, "provider_owned_request_clone", retain, || {
                        request.clone()
                    });
                for message in owned.messages.iter_mut() {
                    if let Message::Assistant { usage, .. } = message {
                        *usage = Some(kcoder_types::Usage {
                            input_tokens: 1000,
                            output_tokens: 50,
                            total_tokens: None,
                            cache_creation_input_tokens: None,
                            cache_read_input_tokens: None,
                            iterations: None,
                        });
                    }
                }
                let anchored = sampled(&mut samples, "token_estimate_usage_anchor", retain, || {
                    TokenCounter::count_request_with_static_prefix(&owned, false, &measurement)
                });
                assert_eq!(
                    anchored.source,
                    context::TokenCountSource::UsageAnchorWithEstimatedDelta
                );
                drop((owned, request, fork));
            }
            for (phase, values) in &samples {
                report(records, damaged, tool_count, phase, values);
            }
        }
    }
}
