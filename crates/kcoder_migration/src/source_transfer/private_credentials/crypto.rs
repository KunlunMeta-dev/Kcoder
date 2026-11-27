//! RFC 9180 single-shot HPKE through the explicit rustls AWS-LC implementation.
//! Application framing below is not a new cryptographic construction.
use super::model::*;
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use rustls::crypto::{
    aws_lc_rs::hpke::DH_KEM_X25519_HKDF_SHA256_AES_256,
    hpke::{EncapsulatedSecret, Hpke, HpkePrivateKey, HpkePublicKey},
};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const INFO: &[u8] = b"KCoder/private-credential-transfer/1";
const MAGIC: &[u8; 8] = b"KCPRIV01";

pub(super) struct PrivateKey(HpkePrivateKey);
impl PrivateKey {
    pub fn generate() -> Result<(String, Self)> {
        let (public, private) = DH_KEM_X25519_HKDF_SHA256_AES_256
            .generate_key_pair()
            .map_err(|_| anyhow::anyhow!("private_credentials_crypto_failed"))?;
        ensure!(
            public.0.len() == 32 && private.secret_bytes().len() == 32,
            "private_credentials_crypto_failed"
        );
        Ok((STANDARD.encode(public.0), Self(private)))
    }
    pub fn restore(bytes: Vec<u8>) -> Result<Self> {
        let mut bytes = Zeroizing::new(bytes);
        ensure!(bytes.len() == 32, "private_credentials_key_unknown");
        Ok(Self(HpkePrivateKey::from(std::mem::take(&mut *bytes))))
    }
    pub fn bytes(&self) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(self.0.secret_bytes().to_vec())
    }
}

/// Secret values never implement Debug or Serialize. Only this module frames them for HPKE.
pub(super) struct Values(pub Vec<Zeroizing<String>>);
impl Values {
    pub fn encode(&self) -> Result<Zeroizing<Vec<u8>>> {
        ensure!(
            !self.0.is_empty() && self.0.len() <= MAX_PRIVATE_SLOTS,
            "private_credentials_budget_exceeded"
        );
        let mut output = Zeroizing::new(Vec::new());
        output.extend_from_slice(MAGIC);
        output.extend_from_slice(&(self.0.len() as u16).to_le_bytes());
        for (index, value) in self.0.iter().enumerate() {
            ensure!(
                !value.is_empty() && value.len() <= MAX_PRIVATE_BYTES,
                "private_credentials_budget_exceeded"
            );
            ensure!(
                output
                    .len()
                    .checked_add(6 + value.len())
                    .is_some_and(|n| n <= MAX_PRIVATE_BYTES),
                "private_credentials_budget_exceeded"
            );
            output.extend_from_slice(&(index as u16).to_le_bytes());
            output.extend_from_slice(&(value.len() as u32).to_le_bytes());
            output.extend_from_slice(value.as_bytes());
        }
        Ok(output)
    }
    fn decode(bytes: &[u8], expected: usize) -> Result<Self> {
        ensure!(
            bytes.len() >= 10 && bytes.len() <= MAX_PRIVATE_BYTES && &bytes[..8] == MAGIC,
            "private_credentials_invalid_payload"
        );
        let count = u16::from_le_bytes(bytes[8..10].try_into().unwrap()) as usize;
        ensure!(
            count == expected && count > 0 && count <= MAX_PRIVATE_SLOTS,
            "private_credentials_invalid_payload"
        );
        let mut offset = 10usize;
        let mut values = Vec::new();
        for index in 0..count {
            ensure!(
                offset.checked_add(6).is_some_and(|n| n <= bytes.len()),
                "private_credentials_invalid_payload"
            );
            let slot = u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap()) as usize;
            let length =
                u32::from_le_bytes(bytes[offset + 2..offset + 6].try_into().unwrap()) as usize;
            offset += 6;
            ensure!(
                slot == index
                    && length > 0
                    && offset.checked_add(length).is_some_and(|n| n <= bytes.len()),
                "private_credentials_invalid_payload"
            );
            let value = std::str::from_utf8(&bytes[offset..offset + length])
                .map_err(|_| anyhow::anyhow!("private_credentials_invalid_payload"))?;
            values.push(Zeroizing::new(value.to_owned()));
            offset += length;
        }
        ensure!(offset == bytes.len(), "private_credentials_invalid_payload");
        Ok(Self(values))
    }
}

pub(super) fn offer_bytes(offer: &PrivateCredentialOffer) -> Result<Vec<u8>> {
    offer.context.validate()?;
    ensure!(
        offer.suite == PRIVATE_SUITE,
        "private_credentials_suite_unsupported"
    );
    decode(&offer.public_key, 32)?;
    let bytes = serde_json::to_vec(offer)
        .map_err(|_| anyhow::anyhow!("private_credentials_invalid_offer"))?;
    ensure!(
        bytes.len() <= 128 * 1024,
        "private_credentials_budget_exceeded"
    );
    Ok(bytes)
}
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn seal(
    offer: &PrivateCredentialOffer,
    values: &Values,
) -> Result<PrivateCredentialEnvelope> {
    let aad = offer_bytes(offer)?;
    ensure!(
        values.0.len() == offer.context.selections.len(),
        "private_credentials_invalid_payload"
    );
    let key = HpkePublicKey(decode(&offer.public_key, 32)?);
    let plaintext = values.encode()?;
    let (enc, ciphertext) = DH_KEM_X25519_HKDF_SHA256_AES_256
        .seal(INFO, &aad, &plaintext, &key)
        .map_err(|_| anyhow::anyhow!("private_credentials_crypto_failed"))?;
    ensure!(
        enc.0.len() == 32 && ciphertext.len() == plaintext.len() + 16,
        "private_credentials_crypto_failed"
    );
    Ok(PrivateCredentialEnvelope {
        version: 1,
        offer_id: offer.context.offer_id.clone(),
        offer_sha256: digest(&aad),
        encapsulated_key: STANDARD.encode(enc.0),
        ciphertext: STANDARD.encode(ciphertext),
    })
}
pub(super) fn open(
    offer: &PrivateCredentialOffer,
    envelope: &PrivateCredentialEnvelope,
    key: &PrivateKey,
) -> Result<Values> {
    let aad = offer_bytes(offer)?;
    ensure!(
        envelope.version == 1
            && envelope.offer_id == offer.context.offer_id
            && envelope.offer_sha256 == digest(&aad),
        "private_credentials_envelope_changed"
    );
    let enc = EncapsulatedSecret(decode(&envelope.encapsulated_key, 32)?);
    ensure!(
        envelope.ciphertext.len() <= ((MAX_PRIVATE_BYTES + 18) / 3) * 4,
        "private_credentials_budget_exceeded"
    );
    let ciphertext = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| anyhow::anyhow!("private_credentials_invalid_envelope"))?;
    ensure!(
        ciphertext.len() >= 16
            && ciphertext.len() <= MAX_PRIVATE_BYTES + 16
            && STANDARD.encode(&ciphertext) == envelope.ciphertext,
        "private_credentials_invalid_envelope"
    );
    let plaintext = Zeroizing::new(
        DH_KEM_X25519_HKDF_SHA256_AES_256
            .open(&enc, INFO, &aad, &ciphertext, &key.0)
            .map_err(|_| anyhow::anyhow!("private_credentials_authentication_failed"))?,
    );
    Values::decode(&plaintext, offer.context.selections.len())
}
fn decode(text: &str, length: usize) -> Result<Vec<u8>> {
    ensure!(
        text.len() <= length.div_ceil(3) * 4,
        "private_credentials_invalid_key"
    );
    let value = STANDARD
        .decode(text)
        .map_err(|_| anyhow::anyhow!("private_credentials_invalid_key"))?;
    ensure!(
        value.len() == length && STANDARD.encode(&value) == text,
        "private_credentials_invalid_key"
    );
    Ok(value)
}

#[cfg(test)]
#[path = "crypto_tests.rs"]
mod tests;
