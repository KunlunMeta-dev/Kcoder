//! Private native recovery bootstrap. Never log or expose this as a tool value.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
#[cfg(any(windows, test))]
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

const MAX_BOOTSTRAP_BYTES: usize = 4096;
const PIPE_PREFIX: &str = r"\\.\pipe\kcoder-desktop-";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryBootstrap {
    version: u32,
    pipe: String,
    parent_pid: u32,
    secret: [u8; 32],
}
impl Drop for RecoveryBootstrap {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}
impl RecoveryBootstrap {
    pub fn new(pipe: String, parent_pid: u32) -> Result<Self> {
        let mut secret = [0; 32];
        getrandom::fill(&mut secret)
            .map_err(|_| anyhow::anyhow!("recovery entropy unavailable"))?;
        let value = Self {
            version: 1,
            pipe,
            parent_pid,
            secret,
        };
        value.validate()?;
        Ok(value)
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1 && self.parent_pid != 0,
            "invalid recovery bootstrap identity"
        );
        ensure!(
            self.pipe
                .strip_prefix(PIPE_PREFIX)
                .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok()),
            "invalid recovery bootstrap pipe"
        );
        ensure!(
            self.secret.iter().any(|byte| *byte != 0),
            "invalid recovery bootstrap secret"
        );
        Ok(())
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure!(
            !bytes.is_empty() && bytes.len() <= MAX_BOOTSTRAP_BYTES,
            "invalid recovery bootstrap size"
        );
        let value: Self = serde_json::from_slice(bytes)
            .map_err(|_| anyhow::anyhow!("invalid recovery bootstrap"))?;
        value.validate()?;
        Ok(value)
    }
    pub fn encode_private(&self) -> Result<Zeroizing<Vec<u8>>> {
        Ok(Zeroizing::new(serde_json::to_vec(self)?))
    }
    pub fn pipe(&self) -> &str {
        &self.pipe
    }
    pub fn parent_pid(&self) -> u32 {
        self.parent_pid
    }
    #[cfg(any(windows, test))]
    pub(crate) fn secret(&self) -> &[u8; 32] {
        &self.secret
    }
    #[cfg(any(windows, test))]
    pub(crate) fn accepts(&self, candidate: &[u8; 32]) -> bool {
        bool::from(self.secret.ct_eq(candidate))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bootstrap_is_bounded_versioned_and_rejects_wrong_secret() {
        let original =
            RecoveryBootstrap::new(format!("{PIPE_PREFIX}{}", uuid::Uuid::new_v4()), 42).unwrap();
        let restored = RecoveryBootstrap::decode(&original.encode_private().unwrap()).unwrap();
        assert_eq!(restored.parent_pid(), 42);
        assert_eq!(restored.pipe(), original.pipe());
        assert!(restored.accepts(original.secret()));
        let mut wrong = *original.secret();
        wrong[0] ^= 1;
        assert!(!restored.accepts(&wrong));
        assert!(RecoveryBootstrap::decode(&vec![b' '; MAX_BOOTSTRAP_BYTES + 1]).is_err());
        for (field, value) in [
            ("version", serde_json::json!(2)),
            ("parent_pid", serde_json::json!(0)),
            (
                "pipe",
                serde_json::json!(r"\\other-host\pipe\kcoder-desktop-x"),
            ),
            ("unexpected", serde_json::json!(true)),
        ] {
            let mut bad = serde_json::to_value(&original).unwrap();
            bad[field] = value;
            assert!(RecoveryBootstrap::decode(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
    }
}
