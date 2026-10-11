//! Serializable identities for private filesystem objects. These are evidence,
//! not capabilities: callers must also verify scope, ownership and lifecycle.

use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrivateFileKind {
    RegularFile,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "camelCase", deny_unknown_fields)]
pub enum PrivateNativeFileIdentity {
    Linux { device: u64, inode: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateFileIdentityV1 {
    #[serde(deserialize_with = "identity_version")]
    pub version: u32,
    pub kind: PrivateFileKind,
    pub native: PrivateNativeFileIdentity,
}

impl PrivateFileIdentityV1 {
    pub const VERSION: u32 = 1;
}

fn identity_version<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let version = u32::deserialize(deserializer)?;
    if version != PrivateFileIdentityV1::VERSION {
        return Err(serde::de::Error::custom(
            "unsupported private identity version",
        ));
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_file_identity_round_trips_without_io() {
        let identity = PrivateFileIdentityV1 {
            version: PrivateFileIdentityV1::VERSION,
            kind: PrivateFileKind::RegularFile,
            native: PrivateNativeFileIdentity::Linux {
                device: 42,
                inode: 99,
            },
        };
        let encoded = serde_json::to_value(&identity).unwrap();
        assert_eq!(
            serde_json::from_value::<PrivateFileIdentityV1>(encoded.clone()).unwrap(),
            identity
        );
        let mut future = encoded;
        future["version"] = 2.into();
        assert!(serde_json::from_value::<PrivateFileIdentityV1>(future).is_err());
        assert!(serde_json::from_str::<PrivateFileIdentityV1>(
            r#"{"version":1,"kind":"regularFile","native":{"platform":"unverified","device":42,"inode":99}}"#
        ).is_err());
    }
}
