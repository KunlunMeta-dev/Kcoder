use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::OnceLock;

static EXECUTABLE_SHA256: OnceLock<Option<String>> = OnceLock::new();

pub(crate) fn add_to_json(event: &mut Value) {
    let Some(event) = event.as_object_mut() else {
        return;
    };
    event.insert(
        "version".to_string(),
        Value::String(env!("CARGO_PKG_VERSION").to_string()),
    );
    event.insert(
        "build_commit".to_string(),
        Value::String(env!("KCODER_BUILD_COMMIT").to_string()),
    );
    event.insert(
        "build_dirty".to_string(),
        Value::Bool(env!("KCODER_BUILD_DIRTY") == "true"),
    );
    event.insert(
        "build_time_unix".to_string(),
        Value::Number(
            env!("KCODER_BUILD_TIME_UNIX")
                .parse::<u64>()
                .unwrap_or_default()
                .into(),
        ),
    );
    if let Some(hash) = executable_sha256() {
        event.insert("executable_sha256".to_string(), Value::String(hash));
    }
}

pub(crate) fn executable_sha256() -> Option<String> {
    EXECUTABLE_SHA256
        .get_or_init(|| {
            let path = std::env::current_exe().ok()?;
            let mut file = std::fs::File::open(path).ok()?;
            let mut hasher = Sha256::new();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer).ok()?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            Some(format!("{:x}", hasher.finalize()))
        })
        .clone()
}
