//! Pure SSH peer challenge facts. This module performs no enrollment, IO or authorization.
//!
//! Expected pins supplied by a caller are comparison inputs, not trusted grants.
//! Neither challenge state nor verified signatures implement a private parent or
//! routing authority. Production integration still needs a controlled pin store,
//! its fresh revocation check and the actual owned SSH transport on every use.
use kcoder_app_protocol::cross_session_router::ssh_enrollment::*;
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature,
};
use std::time::{Duration, Instant};

pub const MAX_CHALLENGE_LIFETIME: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SshPeerFactError {
    #[error("peer_ssh_pinned_enrollment_missing")]
    MissingPin,
    #[error("peer_ssh_fact_invalid")]
    Invalid,
    #[error("peer_ssh_expected_pins_changed")]
    PinsChanged,
    #[error("peer_ssh_challenge_expired")]
    Expired,
    #[error("peer_ssh_challenge_consumed")]
    Consumed,
    #[error("peer_ssh_challenge_scope_changed")]
    ScopeChanged,
    #[error("peer_ssh_fact_signature_invalid")]
    SignatureInvalid,
    #[error("peer_ssh_nonce_generation_unavailable")]
    RandomUnavailable,
}
type Result<T> = std::result::Result<T, SshPeerFactError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObservedSshPeer {
    NativeProfile,
    GatewayKey,
}

/// Signature facts relative to the supplied expected pins, never an access grant.
/// In particular, a Gateway's Native facts do not prove Native accepted its reply.
#[derive(Debug)]
pub struct VerifiedSshPeerFacts {
    peer: ObservedSshPeer,
    claims: PeerSshChallengeClaimsV1,
}
impl VerifiedSshPeerFacts {
    pub fn peer(&self) -> ObservedSshPeer {
        self.peer
    }
    pub fn claims(&self) -> &PeerSshChallengeClaimsV1 {
        &self.claims
    }
    /// Only compares the provided data. This does not read a store or authorize use.
    pub fn compare_expected_pins(&self, current: Option<&PeerSshEnrollmentV1>) -> Result<()> {
        compare_pins(&self.claims.enrollment, current)
    }
}

// Handshake checks below drop their sources on purpose: ring reports no
// detail, and a peer must not learn which of its supplied facts failed. Each
// fixed variant is the whole diagnostic.
fn pinned(expected: Option<&PeerSshEnrollmentV1>) -> Result<PeerSshEnrollmentV1> {
    let expected = expected.ok_or(SshPeerFactError::MissingPin)?;
    expected.validate().map_err(|_| SshPeerFactError::Invalid)?;
    Ok(expected.clone())
}
fn compare_pins(
    expected: &PeerSshEnrollmentV1,
    current: Option<&PeerSshEnrollmentV1>,
) -> Result<()> {
    let current = pinned(current)?;
    if current != *expected {
        return Err(SshPeerFactError::PinsChanged);
    }
    Ok(())
}
fn deadline(lifetime: Duration) -> Result<Instant> {
    if lifetime.is_zero() || lifetime > MAX_CHALLENGE_LIFETIME {
        return Err(SshPeerFactError::Invalid);
    }
    Instant::now()
        .checked_add(lifetime)
        .ok_or(SshPeerFactError::Invalid)
}
fn fresh_nonce() -> Result<PeerSshNonceV1> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| SshPeerFactError::RandomUnavailable)?;
    let value: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    value.try_into().map_err(|_| SshPeerFactError::Invalid)
}
fn live(until: Instant) -> Result<()> {
    if Instant::now() >= until {
        return Err(SshPeerFactError::Expired);
    }
    Ok(())
}
fn bytes<T: serde::Serialize>(domain: &[u8], value: &T) -> Result<Vec<u8>> {
    let mut output = domain.to_vec();
    output.extend(serde_json::to_vec(value).map_err(|_| SshPeerFactError::Invalid)?);
    Ok(output)
}
fn verify(key: &[u8; 32], input: &[u8], proof: &PeerSshSignatureV1) -> Result<()> {
    signature::UnparsedPublicKey::new(&signature::ED25519, key)
        .verify(input, proof.as_bytes())
        .map_err(|_| SshPeerFactError::SignatureInvalid)
}

enum NativePhase {
    AwaitChallenge,
    AwaitGateway(Box<PeerSshNativeProofV1>),
    Consumed,
}

/// One local Native nonce lifetime. Its existence proves no caller authority.
pub struct NativeSshFactChallenge {
    expected: PeerSshEnrollmentV1,
    offer: PeerSshChallengeOfferV1,
    until: Instant,
    phase: NativePhase,
}
impl NativeSshFactChallenge {
    /// Missing pins fail before any remote key can be considered. The future
    /// trusted store must supply these pins; this constructor does not trust them.
    pub fn new(expected: Option<&PeerSshEnrollmentV1>, lifetime: Duration) -> Result<Self> {
        let expected = pinned(expected)?;
        let until = deadline(lifetime)?;
        let offer = PeerSshChallengeOfferV1 {
            version: 1,
            purpose: PeerSshChallengePurposeV1::Challenge,
            enrollment_id: expected.enrollment_id.clone(),
            enrollment_generation: expected.generation,
            native_nonce: fresh_nonce()?,
            process_instance: fresh_nonce()?,
        };
        Ok(Self {
            expected,
            offer,
            until,
            phase: NativePhase::AwaitChallenge,
        })
    }
    pub fn offer(&self) -> &PeerSshChallengeOfferV1 {
        &self.offer
    }
    pub fn close(&mut self) {
        self.phase = NativePhase::Consumed;
    }

    /// Sign only this purpose-bound transcript through the existing profile key.
    /// A failed attempt burns this state too; callers cannot substitute a new peer.
    pub fn respond(
        &mut self,
        claims: PeerSshChallengeClaimsV1,
        current: Option<&PeerSshEnrollmentV1>,
        sign: impl FnOnce(&[u8]) -> Result<PeerSshSignatureV1>,
    ) -> Result<PeerSshNativeProofV1> {
        let prior = std::mem::replace(&mut self.phase, NativePhase::Consumed);
        if !matches!(prior, NativePhase::AwaitChallenge) {
            return Err(SshPeerFactError::Consumed);
        }
        live(self.until)?;
        compare_pins(&self.expected, current)?;
        claims.validate().map_err(|_| SshPeerFactError::Invalid)?;
        if claims.enrollment != self.expected
            || claims.native_nonce != self.offer.native_nonce
            || claims.process_instance != self.offer.process_instance
        {
            return Err(SshPeerFactError::ScopeChanged);
        }
        let input = bytes(PEER_SSH_NATIVE_FACT_DOMAIN, &claims)?;
        let proof = PeerSshNativeProofV1 {
            claims,
            signature: sign(&input)?,
        };
        verify(&self.expected.native.public_key, &input, &proof.signature)?;
        live(self.until)?;
        compare_pins(&self.expected, current)?;
        self.phase = NativePhase::AwaitGateway(Box::new(proof.clone()));
        Ok(proof)
    }

    pub fn finish(
        &mut self,
        proof: PeerSshGatewayProofV1,
        current: Option<&PeerSshEnrollmentV1>,
    ) -> Result<VerifiedSshPeerFacts> {
        let NativePhase::AwaitGateway(native) =
            std::mem::replace(&mut self.phase, NativePhase::Consumed)
        else {
            return Err(SshPeerFactError::Consumed);
        };
        live(self.until)?;
        compare_pins(&self.expected, current)?;
        if proof.native != *native {
            return Err(SshPeerFactError::ScopeChanged);
        }
        verify(
            &self.expected.gateway.public_key,
            &bytes(PEER_SSH_GATEWAY_FACT_DOMAIN, &native)?,
            &proof.signature,
        )?;
        live(self.until)?;
        Ok(VerifiedSshPeerFacts {
            peer: ObservedSshPeer::GatewayKey,
            claims: native.claims,
        })
    }
}

/// One Gateway challenge on one prospective transport. This is not a transport owner.
pub struct GatewaySshFactChallenge {
    expected: PeerSshEnrollmentV1,
    claims: Option<PeerSshChallengeClaimsV1>,
    until: Instant,
}
impl GatewaySshFactChallenge {
    pub fn new(
        expected: Option<&PeerSshEnrollmentV1>,
        offer: PeerSshChallengeOfferV1,
        lifetime: Duration,
    ) -> Result<Self> {
        let expected = pinned(expected)?;
        let until = deadline(lifetime)?;
        if offer.version != 1
            || offer.enrollment_id != expected.enrollment_id
            || offer.enrollment_generation != expected.generation
        {
            return Err(SshPeerFactError::ScopeChanged);
        }
        let claims = PeerSshChallengeClaimsV1 {
            version: 1,
            purpose: PeerSshChallengePurposeV1::Challenge,
            enrollment: expected.clone(),
            native_nonce: offer.native_nonce,
            gateway_nonce: fresh_nonce()?,
            process_instance: offer.process_instance,
        };
        claims.validate().map_err(|_| SshPeerFactError::Invalid)?;
        Ok(Self {
            expected,
            claims: Some(claims),
            until,
        })
    }
    pub fn claims(&self) -> Result<&PeerSshChallengeClaimsV1> {
        live(self.until)?;
        self.claims.as_ref().ok_or(SshPeerFactError::Consumed)
    }
    pub fn close(&mut self) {
        self.claims = None;
    }

    /// Verify Native before asking the Gateway-only signer for its distinct reply.
    /// The signer callback must later be wired to a real owned, authorized Gateway.
    pub fn finish(
        &mut self,
        native: PeerSshNativeProofV1,
        current: Option<&PeerSshEnrollmentV1>,
        sign: impl FnOnce(&[u8]) -> Result<PeerSshSignatureV1>,
    ) -> Result<(PeerSshGatewayProofV1, VerifiedSshPeerFacts)> {
        let claims = self.claims.take().ok_or(SshPeerFactError::Consumed)?;
        live(self.until)?;
        compare_pins(&self.expected, current)?;
        if native.claims != claims {
            return Err(SshPeerFactError::ScopeChanged);
        }
        verify(
            &self.expected.native.public_key,
            &bytes(PEER_SSH_NATIVE_FACT_DOMAIN, &claims)?,
            &native.signature,
        )?;
        let input = bytes(PEER_SSH_GATEWAY_FACT_DOMAIN, &native)?;
        let proof = PeerSshGatewayProofV1 {
            native,
            signature: sign(&input)?,
        };
        verify(&self.expected.gateway.public_key, &input, &proof.signature)?;
        live(self.until)?;
        Ok((
            proof,
            VerifiedSshPeerFacts {
                peer: ObservedSshPeer::NativeProfile,
                claims,
            },
        ))
    }
}

#[cfg(test)]
#[path = "ssh_peer_facts/tests.rs"]
mod tests;
