//! Immutable executable provenance, supplied once by the process entry point.
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildIdentity {
    pub version: &'static str,
    pub commit: &'static str,
    pub dirty: &'static str,
    pub time_unix: &'static str,
}

static IDENTITY: OnceLock<BuildIdentity> = OnceLock::new();
static RELEASE_METADATA: OnceLock<serde_json::Value> = OnceLock::new();
const UNKNOWN: BuildIdentity = BuildIdentity {
    version: "unknown",
    commit: "unknown",
    dirty: "true",
    time_unix: "0",
};

/// Library-only consumers have no executable provenance to assert.
pub fn current() -> &'static BuildIdentity {
    IDENTITY.get().unwrap_or(&UNKNOWN)
}

pub fn version() -> &'static str {
    current().version
}

/// Release facts are diagnostic data, never an authorization decision.
pub fn release_metadata() -> Option<&'static serde_json::Value> {
    RELEASE_METADATA.get()
}

/// Load post-link metadata once, keeping the original native build provenance.
pub fn initialize_release_metadata(
    payload: Option<&[u8]>,
    native_version: &'static str,
) -> Result<(), String> {
    let Some(payload) = payload else {
        return initialize(BuildIdentity {
            version: native_version,
            ..UNKNOWN
        })
        .map_err(str::to_owned);
    };
    let metadata: serde_json::Value = serde_json::from_slice(payload)
        .map_err(|_| "invalid executable release metadata JSON".to_owned())?;
    if metadata["schemaVersion"].as_u64() != Some(1) {
        return Err("unsupported executable release metadata schema".into());
    }
    fn text<'a>(value: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
        value[key]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or_else(|| format!("invalid executable metadata field: {key}"))
    }
    fn source(value: &serde_json::Value) -> Result<(&str, bool, u64), String> {
        let commit = text(value, "commit")?;
        let dirty = value["dirty"]
            .as_bool()
            .ok_or("invalid executable metadata dirty flag")?;
        let full_commit = commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit());
        if !(full_commit || (commit == "unknown" && dirty)) {
            return Err("invalid executable metadata source commit".into());
        }
        Ok((
            commit,
            dirty,
            value["timeUnix"]
                .as_u64()
                .ok_or("invalid executable metadata timestamp")?,
        ))
    }
    let release = &metadata["release"];
    let native = &metadata["native"];
    source(release)?;
    let (commit, dirty, timestamp) = source(native)?;
    if text(native, "version")? != native_version {
        return Err("executable metadata has a different native version".into());
    }
    let native_hash = text(native, "artifactSha256")?;
    if native_hash.len() != 64 || !native_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid executable metadata native artifact digest".into());
    }
    let version = text(release, "version")?;
    if !version
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
    {
        return Err("invalid executable release version".into());
    }
    if RELEASE_METADATA.get().is_some_and(|old| old != &metadata) {
        return Err("executable release metadata is already initialized".into());
    }
    let leak = |s: &str| -> &'static str { Box::leak(s.to_owned().into_boxed_str()) };
    initialize(BuildIdentity {
        version: leak(version),
        commit: leak(commit),
        dirty: if dirty { "true" } else { "false" },
        time_unix: leak(&timestamp.to_string()),
    })
    .map_err(str::to_owned)?;
    let _ = RELEASE_METADATA.set(metadata);
    Ok(())
}

/// Reinitializing with different provenance is an error, never a replacement.
pub fn initialize(identity: BuildIdentity) -> Result<(), &'static str> {
    if identity.version.is_empty() || identity.commit.is_empty() {
        return Err("executable build identity is incomplete");
    }
    if let Err(value) = IDENTITY.set(identity)
        && IDENTITY.get() != Some(&value)
    {
        return Err("executable build identity is already initialized");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_provenance_is_immutable() {
        let identity = BuildIdentity {
            version: "fixture",
            commit: "fixture-commit",
            dirty: "false",
            time_unix: "42",
        };
        initialize(identity).unwrap();
        initialize(identity).unwrap();
        assert!(
            initialize(BuildIdentity {
                commit: "other",
                ..identity
            })
            .is_err()
        );
        assert_eq!(*current(), identity);
    }
}
