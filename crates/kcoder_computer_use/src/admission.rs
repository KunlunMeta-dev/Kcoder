//! Host-issued, one-use connection grants. Tokens travel only over the trusted
//! parent/child bootstrap channel, never in model arguments or diagnostic output.
use kcoder_types::computer_use::{DesktopOperation, DesktopOwner, DesktopRequest};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

const MAX_PENDING: usize = 64;
const GRANT_LIFETIME: Duration = Duration::from_secs(30);

/// Intentionally no Debug or Serialize implementation.
pub struct GrantSecret(Zeroizing<[u8; 32]>);
impl GrantSecret {
    pub fn expose_for_bootstrap(&self) -> &[u8; 32] {
        &self.0
    }
}
struct Grant {
    token: GrantSecret,
    process_id: u32,
    session_id: u32,
    owner: DesktopOwner,
    expires: Instant,
}
#[derive(Default)]
pub struct Admissions {
    pending: HashMap<String, Grant>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AdmissionError {
    InvalidIdentity,
    Capacity,
    Entropy,
    Denied,
    WrongOwner,
    ReplayedRequest,
}

/// Connection identity is bound to the full authorized turn, not merely the OS user.
/// Transport owns the verified OS process handle for the entire connection.
pub struct AuthorizedConnection {
    owner: DesktopOwner,
    last_request: u64,
}
impl AuthorizedConnection {
    pub fn owner(&self) -> &DesktopOwner {
        &self.owner
    }
    pub fn validate(&mut self, request: &DesktopRequest) -> Result<(), AdmissionError> {
        if request.request_id <= self.last_request {
            return Err(AdmissionError::ReplayedRequest);
        }
        let supplied = match &request.operation {
            DesktopOperation::Status => None,
            DesktopOperation::Acquire { owner }
            | DesktopOperation::Call { owner, .. }
            | DesktopOperation::Stop { owner, .. } => Some(owner),
        };
        if supplied.is_some_and(|owner| owner != &self.owner) {
            return Err(AdmissionError::WrongOwner);
        }
        self.last_request = request.request_id;
        Ok(())
    }
}
impl Admissions {
    /// Call only from the trusted host after permission and OS peer registration.
    pub fn issue(
        &mut self,
        process_id: u32,
        session_id: u32,
        owner: DesktopOwner,
    ) -> Result<(String, GrantSecret), AdmissionError> {
        self.issue_at(process_id, session_id, owner, Instant::now())
    }
    fn issue_at(
        &mut self,
        process_id: u32,
        session_id: u32,
        owner: DesktopOwner,
        now: Instant,
    ) -> Result<(String, GrantSecret), AdmissionError> {
        if process_id == 0
            || session_id == 0
            || [&owner.client_instance, &owner.thread_id, &owner.turn_id]
                .iter()
                .any(|value| {
                    value.is_empty() || value.len() > 256 || value.chars().any(char::is_control)
                })
        {
            return Err(AdmissionError::InvalidIdentity);
        }
        self.pending.retain(|_, grant| grant.expires > now);
        if self.pending.len() >= MAX_PENDING {
            return Err(AdmissionError::Capacity);
        }
        let mut secret = Zeroizing::new([0; 32]);
        getrandom::fill(secret.as_mut()).map_err(|_| AdmissionError::Entropy)?;
        let id = uuid::Uuid::new_v4().to_string();
        let returned = GrantSecret(Zeroizing::new(*secret));
        self.pending.insert(
            id.clone(),
            Grant {
                token: GrantSecret(secret),
                process_id,
                session_id,
                owner,
                expires: now + GRANT_LIFETIME,
            },
        );
        Ok((id, returned))
    }
    /// PID and Session must come from the authenticated named-pipe peer, not JSON.
    pub fn consume(
        &mut self,
        id: &str,
        token: &[u8; 32],
        process_id: u32,
        session_id: u32,
    ) -> Result<AuthorizedConnection, AdmissionError> {
        self.consume_at(id, token, process_id, session_id, Instant::now())
    }
    fn consume_at(
        &mut self,
        id: &str,
        token: &[u8; 32],
        process_id: u32,
        session_id: u32,
        now: Instant,
    ) -> Result<AuthorizedConnection, AdmissionError> {
        // Consume even failed attempts so a leaked identifier cannot be brute-forced.
        let grant = self.pending.remove(id).ok_or(AdmissionError::Denied)?;
        if grant.expires <= now
            || grant.process_id != process_id
            || grant.session_id != session_id
            || !bool::from(grant.token.0.as_ref().ct_eq(token))
        {
            return Err(AdmissionError::Denied);
        }
        Ok(AuthorizedConnection {
            owner: grant.owner,
            last_request: 0,
        })
    }
    pub fn revoke_client(&mut self, client: &str) {
        self.pending
            .retain(|_, grant| grant.owner.client_instance != client);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner() -> DesktopOwner {
        DesktopOwner {
            client_instance: "client".into(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
        }
    }
    #[test]
    fn wrong_secret_consumes_grant_and_pending_capacity_is_bounded() {
        let mut admissions = Admissions::default();
        let (id, secret) = admissions.issue(12, 3, owner()).unwrap();
        assert!(matches!(
            admissions.consume(&id, &[0; 32], 12, 3),
            Err(AdmissionError::Denied)
        ));
        assert!(
            admissions
                .consume(&id, secret.expose_for_bootstrap(), 12, 3)
                .is_err()
        );
        let now = Instant::now();
        for _ in 0..MAX_PENDING {
            admissions.issue_at(12, 3, owner(), now).unwrap();
        }
        assert!(matches!(
            admissions.issue_at(12, 3, owner(), now),
            Err(AdmissionError::Capacity)
        ));
        assert!(
            admissions
                .issue_at(12, 3, owner(), now + Duration::from_secs(31))
                .is_ok()
        );
    }

    #[test]
    fn grant_is_peer_bound_expiring_single_use_and_revocable() {
        let now = Instant::now();
        let mut admissions = Admissions::default();
        for (pid, session, delay) in [(99, 3, 0), (12, 4, 0), (12, 3, 31)] {
            let (id, secret) = admissions.issue_at(12, 3, owner(), now).unwrap();
            assert!(matches!(
                admissions.consume_at(
                    &id,
                    secret.expose_for_bootstrap(),
                    pid,
                    session,
                    now + Duration::from_secs(delay)
                ),
                Err(AdmissionError::Denied)
            ));
        }
        let (id, secret) = admissions.issue(12, 3, owner()).unwrap();
        assert!(
            admissions
                .consume(&id, secret.expose_for_bootstrap(), 12, 3)
                .is_ok()
        );
        assert!(
            admissions
                .consume(&id, secret.expose_for_bootstrap(), 12, 3)
                .is_err()
        );
        let (id, secret) = admissions.issue(12, 3, owner()).unwrap();
        admissions.revoke_client("client");
        assert!(
            admissions
                .consume(&id, secret.expose_for_bootstrap(), 12, 3)
                .is_err()
        );
    }
    #[test]
    fn connection_cannot_claim_another_turn_or_replay_request() {
        let mut admissions = Admissions::default();
        let (id, secret) = admissions.issue(12, 3, owner()).unwrap();
        let mut connection = admissions
            .consume(&id, secret.expose_for_bootstrap(), 12, 3)
            .unwrap();
        let mut request = DesktopRequest {
            protocol_version: 1,
            request_id: 1,
            operation: DesktopOperation::Acquire { owner: owner() },
        };
        connection.validate(&request).unwrap();
        assert_eq!(
            connection.validate(&request),
            Err(AdmissionError::ReplayedRequest)
        );
        request.request_id = 2;
        let mut other = owner();
        other.turn_id = "another-turn".into();
        request.operation = DesktopOperation::Acquire { owner: other };
        assert_eq!(
            connection.validate(&request),
            Err(AdmissionError::WrongOwner)
        );
    }
}
