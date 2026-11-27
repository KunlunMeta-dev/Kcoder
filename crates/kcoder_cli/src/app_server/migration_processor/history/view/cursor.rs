//! Metadata-page cursors are scoped to this connection and authenticated profile.
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub(super) struct Cursor([u8; 32]);
impl Default for Cursor {
    fn default() -> Self {
        let mut bytes = [0; 32];
        bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        Self(bytes)
    }
}
impl Cursor {
    fn mac(&self, profile: &Path, bytes: &[u8]) -> Result<Hmac<Sha256>> {
        let identity =
            kcoder_config::PrivateDirectory::open_existing(profile)?.directory_identity()?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0)
            .map_err(|_| anyhow::anyhow!("history_retirement_invalid_cursor"))?;
        mac.update(b"kcoder.history.retirement.page/1\0");
        mac.update(identity.as_bytes());
        mac.update(&[0]);
        mac.update(bytes);
        Ok(mac)
    }
    pub(super) fn seal(&self, profile: &Path, after: &str) -> Result<String> {
        Ok(format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(after),
            URL_SAFE_NO_PAD.encode(self.mac(profile, after.as_bytes())?.finalize().into_bytes())
        ))
    }
    pub(super) fn open(&self, profile: &Path, encoded: &str) -> Result<String> {
        ensure!(encoded.len() <= 512, "history_retirement_invalid_cursor");
        let (value, signature) = encoded
            .split_once('.')
            .ok_or_else(|| anyhow::anyhow!("history_retirement_invalid_cursor"))?;
        let value = URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| anyhow::anyhow!("history_retirement_invalid_cursor"))?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| anyhow::anyhow!("history_retirement_invalid_cursor"))?;
        self.mac(profile, &value)?
            .verify_slice(&signature)
            .map_err(|_| anyhow::anyhow!("history_retirement_invalid_cursor"))?;
        String::from_utf8(value).map_err(|_| anyhow::anyhow!("history_retirement_invalid_cursor"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retirement_page_cursors_never_cross_a_connection_profile_or_domain() {
        let profile = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let first = Cursor::default();
        let second = Cursor::default();
        let id = uuid::Uuid::new_v4().to_string();
        let cursor = first.seal(profile.path(), &id).unwrap();
        assert_eq!(first.open(profile.path(), &cursor).unwrap(), id);
        assert!(first.open(other.path(), &cursor).is_err());
        assert!(second.open(profile.path(), &cursor).is_err());
        assert!(first.open(profile.path(), &format!("{cursor}x")).is_err());
    }
}
