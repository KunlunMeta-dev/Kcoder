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
