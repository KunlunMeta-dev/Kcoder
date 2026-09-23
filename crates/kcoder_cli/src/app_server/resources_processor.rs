use kcoder_app_protocol::{ServerResourceActivity, ServerResourcesParams, ServerResourcesResult};
use serde_json::Value;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) fn process(id: Value, params: Value, activity: ServerResourceActivity) -> Value {
    if !params.is_object() || serde_json::from_value::<ServerResourcesParams>(params).is_err() {
        return super::error_response(id, -32602, "server/resources/read requires an empty object");
    }
    super::success_response(
        id,
        serde_json::to_value(snapshot(activity)).expect("resource snapshot serializes"),
    )
}

pub(super) fn instance_id() -> &'static str {
    static INSTANCE: OnceLock<String> = OnceLock::new();
    INSTANCE.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

fn snapshot(activity: ServerResourceActivity) -> ServerResourcesResult {
    let (resident_bytes, memory_source) = resident_memory();
    ServerResourcesResult {
        process_id: std::process::id(),
        instance_id: instance_id().to_owned(),
        sampled_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
        resident_bytes,
        memory_source: memory_source.into(),
        includes_children: false,
        activity_complete: false,
        reclaimable: None,
        activity,
    }
}

#[cfg(target_os = "linux")]
fn parse_resident_bytes(status: &str) -> Option<u64> {
    let mut rows = status
        .lines()
        .filter_map(|line| line.strip_prefix("VmRSS:"));
    let mut fields = rows.next()?.split_whitespace();
    let value = fields.next()?.parse::<u64>().ok()?.checked_mul(1024)?;
    if fields.next()? != "kB" || fields.next().is_some() || rows.next().is_some() {
        return None;
    }
    Some(value)
}

#[cfg(target_os = "linux")]
fn resident_memory() -> (Option<u64>, &'static str) {
    use std::io::Read;
    let value = (|| {
        let mut status = String::new();
        std::fs::File::open("/proc/self/status")
            .ok()?
            .take(65537)
            .read_to_string(&mut status)
            .ok()?;
        if status.len() > 65536 {
            return None;
        }
        parse_resident_bytes(&status)
    })();
    (value, "linux-vmrss")
}

#[cfg(windows)]
fn resident_memory() -> (Option<u64>, &'static str) {
    use windows_sys::Win32::System::{
        ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
        Threading::GetCurrentProcess,
    };
    let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let mut counters = PROCESS_MEMORY_COUNTERS {
        cb: size,
        ..Default::default()
    };
    // The pseudo handle refers only to this process and must not be closed.
    // The output struct is initialized and valid for the full declared size.
    let success = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size) };
    (
        (success != 0).then_some(counters.WorkingSetSize as u64),
        "windows-working-set",
    )
}

#[cfg(not(any(target_os = "linux", windows)))]
fn resident_memory() -> (Option<u64>, &'static str) {
    (None, "unsupported")
}

#[cfg(test)]
mod tests {
    #[test]
    fn resource_snapshot_is_thread_independent_and_not_reclamation_authority() {
        let a = super::process(
            serde_json::json!(1),
            serde_json::json!({}),
            Default::default(),
        );
        let b = super::process(
            serde_json::json!(2),
            serde_json::json!({}),
            Default::default(),
        );
        assert_eq!(a["result"]["processId"], std::process::id());
        assert_eq!(a["result"]["instanceId"], b["result"]["instanceId"]);
        assert_eq!(a["result"]["activityComplete"], false);
        assert_eq!(a["result"]["includesChildren"], false);
        assert!(a["result"]["reclaimable"].is_null());
        #[cfg(any(target_os = "linux", windows))]
        assert!(a["result"]["residentBytes"].as_u64().unwrap() > 0);
        for params in [
            serde_json::json!({"pid":1}),
            serde_json::json!([]),
            Value::Null,
        ] {
            let response = super::process(serde_json::json!(3), params, Default::default());
            assert_eq!(response["error"]["code"], -32602);
        }
    }
    use serde_json::Value;
    #[cfg(target_os = "linux")]
    #[test]
    fn resident_memory_uses_vmrss_and_rejects_ambiguous_values() {
        use super::parse_resident_bytes;
        assert_eq!(
            parse_resident_bytes("VmSize: 999 kB\nVmRSS:\t123 kB\n"),
            Some(125952)
        );
        for input in [
            "",
            "VmRSS: 123 MB",
            "VmRSS: -1 kB",
            "VmRSS: 18446744073709551615 kB",
            "VmRSS: 1 kB\nVmRSS: 2 kB",
            "VmRSS: 1 kB extra",
        ] {
            assert_eq!(parse_resident_bytes(input), None, "{input}");
        }
    }
}
