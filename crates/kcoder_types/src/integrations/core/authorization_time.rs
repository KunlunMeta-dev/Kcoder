//! Explicit consent lifetime. A required JSON null means valid until revoked.
use serde::{Deserialize, Serialize};

/// Numeric legacy deadlines retain their signed encoding. Missing fields, zero,
/// and oversized durations never become persistent authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum IntegrationAuthorizationTime {
    UntilRevoked,
    Limited(u64),
}

impl From<u64> for IntegrationAuthorizationTime {
    fn from(value: u64) -> Self {
        Self::Limited(value)
    }
}

impl IntegrationAuthorizationTime {
    pub fn valid_duration(self) -> bool {
        match self {
            Self::UntilRevoked => true,
            Self::Limited(value) => (1..=super::MAX_INTEGRATION_DELEGATION_TTL_MS).contains(&value),
        }
    }

    pub fn valid_deadline(self) -> bool {
        match self {
            Self::UntilRevoked => true,
            Self::Limited(value) => (1..=9_007_199_254_740_991).contains(&value),
        }
    }

    pub fn deadline(self, now_ms: u64) -> Option<Self> {
        if !self.valid_duration() {
            return None;
        }
        let result = match self {
            Self::UntilRevoked => Self::UntilRevoked,
            Self::Limited(value) => Self::Limited(now_ms.checked_add(value)?),
        };
        result.valid_deadline().then_some(result)
    }

    pub fn active_at(self, now_ms: u64) -> bool {
        self.valid_deadline()
            && match self {
                Self::UntilRevoked => true,
                Self::Limited(value) => now_ms < value,
            }
    }

    pub fn valid_issuance(self, issued_at_ms: u64) -> bool {
        self.valid_deadline()
            && match self {
                Self::UntilRevoked => true,
                Self::Limited(value) => value.checked_sub(issued_at_ms).is_some_and(|duration| {
                    (1..=super::MAX_INTEGRATION_DELEGATION_TTL_MS).contains(&duration)
                }),
            }
    }

    /// A child cannot outlive a limited parent or credential reference.
    pub fn covers(self, child: Self) -> bool {
        self.valid_deadline()
            && child.valid_deadline()
            && match (self, child) {
                (Self::UntilRevoked, _) => true,
                (Self::Limited(parent), Self::Limited(child)) => child <= parent,
                _ => false,
            }
    }

    pub fn intersect(self, other: Self) -> Self {
        match (self, other) {
            (Self::UntilRevoked, value) | (value, Self::UntilRevoked) => value,
            (Self::Limited(a), Self::Limited(b)) => Self::Limited(a.min(b)),
        }
    }

    pub fn extends(self, original: Self) -> bool {
        self.covers(original) && self != original
    }

    pub fn remaining(self, now_ms: u64) -> Option<Self> {
        match self {
            Self::UntilRevoked => Some(Self::UntilRevoked),
            Self::Limited(value) => Some(Self::Limited(value.checked_sub(now_ms)?)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Deserialize)]
    struct Consent {
        expires_in_ms: IntegrationAuthorizationTime,
    }

    #[test]
    fn persistent_authorization_requires_explicit_null_and_limited_encoding_survives() {
        assert!(serde_json::from_str::<Consent>("{}").is_err());
        let value: Consent = serde_json::from_str("{\"expires_in_ms\":null}").unwrap();
        assert_eq!(
            value.expires_in_ms,
            IntegrationAuthorizationTime::UntilRevoked
        );
        assert_eq!(
            serde_json::to_string(&IntegrationAuthorizationTime::Limited(60000)).unwrap(),
            "60000"
        );
        assert!(IntegrationAuthorizationTime::UntilRevoked.active_at(u64::MAX));
        assert!(!IntegrationAuthorizationTime::Limited(0).valid_duration());
        assert!(!IntegrationAuthorizationTime::Limited(86_400_001).valid_duration());
        assert!(!IntegrationAuthorizationTime::Limited(100).active_at(100));
        assert!(
            !IntegrationAuthorizationTime::Limited(100)
                .covers(IntegrationAuthorizationTime::UntilRevoked)
        );
        assert_eq!(
            IntegrationAuthorizationTime::UntilRevoked.intersect(100.into()),
            100.into()
        );
    }
}
