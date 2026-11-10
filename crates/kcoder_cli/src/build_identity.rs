use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::OnceLock;

pub use kcoder_cli_commands::build_identity::current;

static EXECUTABLE_SHA256: OnceLock<Option<String>> = OnceLock::new();

pub fn add_to_json(event: &mut Value) {
    let Some(event) = event.as_object_mut() else {
        return;
    };
    event.insert(
        "version".to_string(),
        Value::String(kcoder_cli_commands::build_identity::version().to_string()),
    );
    event.insert(
        "build_commit".to_string(),
        Value::String(current().commit.to_string()),
    );
    event.insert(
        "build_dirty".to_string(),
        Value::Bool(current().dirty == "true"),
    );
    event.insert(
        "build_time_unix".to_string(),
        Value::Number(
            current()
                .time_unix
                .parse::<u64>()
                .unwrap_or_default()
                .into(),
        ),
    );
    if let Some(hash) = executable_sha256() {
        event.insert("executable_sha256".to_string(), Value::String(hash));
    }
}

pub fn executable_sha256() -> Option<String> {
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
