//! Durable endpoint semantics with credential slots, never URL credential values.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelEndpointSnapshot {
    address: String,
    username_required: bool,
    password_required: bool,
    query: Vec<QueryPart>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum QueryPart {
    Literal { name: String, value: String },
    Credential { name: String },
}

fn parse(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| anyhow::anyhow!("Invalid model transport URL"))?;
    ensure!(
        matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
            && url.host_str().is_some()
            && url.fragment().is_none(),
        "Unsupported model transport URL"
    );
    Ok(url)
}

fn base(url: &Url) -> Result<String> {
    let mut value = url.clone();
    value
        .set_username("")
        .map_err(|_| anyhow::anyhow!("Invalid URL authority"))?;
    value
        .set_password(None)
        .map_err(|_| anyhow::anyhow!("Invalid URL authority"))?;
    value.set_query(None);
    Ok(value.to_string())
}

fn contains_known_secret(text: &str, secrets: &[&str]) -> bool {
    secrets
        .iter()
        .any(|secret| !secret.is_empty() && text.contains(secret))
}

impl ModelEndpointSnapshot {
    /// `secrets` includes the resolved runtime key, including environment/CLI
    /// sources. The caller must not pass only the serialized settings fields.
    pub fn capture(value: &str, secrets: &[&str]) -> Result<Self> {
        let url = parse(value)?;
        let address = base(&url)?;
        ensure!(
            !contains_known_secret(&address, secrets)
                && !contains_known_secret(
                    &percent_encoding::percent_decode_str(url.path()).decode_utf8_lossy(),
                    secrets
                ),
            "Endpoint path contains credential material"
        );
        let mut query = Vec::new();
        for (name, value) in url.query_pairs() {
            ensure!(
                !contains_known_secret(&name, secrets),
                "Endpoint query name contains credential material"
            );
            let normalized = name.to_ascii_lowercase().replace(['-', '_'], "");
            let credential = matches!(
                normalized.as_str(),
                "key"
                    | "apikey"
                    | "token"
                    | "accesstoken"
                    | "refreshtoken"
                    | "signature"
                    | "sig"
                    | "authorization"
                    | "password"
            ) || normalized == "auth"
                || normalized.ends_with("key")
                || [
                    "token",
                    "secret",
                    "password",
                    "signature",
                    "authorization",
                    "credential",
                ]
                .iter()
                .any(|part| normalized.contains(part))
                || contains_known_secret(&value, secrets);
            query.push(if credential {
                QueryPart::Credential {
                    name: name.into_owned(),
                }
            } else {
                QueryPart::Literal {
                    name: name.into_owned(),
                    value: value.into_owned(),
                }
            });
        }
        Ok(Self {
            address,
            username_required: !url.username().is_empty(),
            password_required: url.password().is_some(),
            query,
        })
    }

    /// Credential-bearing addresses require a freshly authorized URL for the
    /// same endpoint. Ordinary URL parameters stay frozen even if defaults change.
    pub fn restore(&self, current: Option<&str>) -> Result<String> {
        let mut output = parse(&self.address)?;
        ensure!(
            base(&output)? == self.address
                && output.query().is_none()
                && output.username().is_empty()
                && output.password().is_none(),
            "Invalid snapshot endpoint address"
        );
        let needs_credentials = self.username_required
            || self.password_required
            || self
                .query
                .iter()
                .any(|part| matches!(part, QueryPart::Credential { .. }));
        let current = if needs_credentials {
            let current = parse(
                current.ok_or_else(|| anyhow::anyhow!("Current URL credentials are required"))?,
            )?;
            ensure!(
                base(&current)? == self.address,
                "URL credential authority changed"
            );
            ensure!(
                !self.username_required || !current.username().is_empty(),
                "URL username is unavailable"
            );
            ensure!(
                !self.password_required
                    || current.password().is_some_and(|value| !value.is_empty()),
                "URL password is unavailable"
            );
            Some(current)
        } else {
            None
        };
        if let Some(current) = &current {
            if self.username_required || self.password_required {
                output
                    .set_username(current.username())
                    .map_err(|_| anyhow::anyhow!("Invalid URL username"))?;
                output
                    .set_password(current.password())
                    .map_err(|_| anyhow::anyhow!("Invalid URL password"))?;
            }
        }
        let live_query = current
            .as_ref()
            .map(|url| {
                url.query_pairs()
                    .map(|(name, value)| (name.into_owned(), value.into_owned()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !self.query.is_empty() {
            let mut target = output.query_pairs_mut();
            for (index, part) in self.query.iter().enumerate() {
                match part {
                    QueryPart::Literal { name, value } => {
                        target.append_pair(name, value);
                    }
                    QueryPart::Credential { name } => {
                        let (live_name, value) = live_query.get(index).ok_or_else(|| {
                            anyhow::anyhow!("URL credential parameter is unavailable")
                        })?;
                        ensure!(
                            live_name == name && !value.is_empty(),
                            "URL credential parameter changed"
                        );
                        target.append_pair(name, value);
                    }
                }
            }
        }
        Ok(output.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_semantics_and_rotates_url_credentials_without_persisting_them() {
        let snapshot = ModelEndpointSnapshot::capture(
            "https://old-user:old-password@example.invalid/v1?version=old&api_key=old-key",
            &["old-key"],
        )
        .unwrap();
        let bytes = serde_json::to_vec(&snapshot).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        for secret in ["old-user", "old-password", "old-key"] {
            assert!(!text.contains(secret));
        }
        let snapshot: ModelEndpointSnapshot = serde_json::from_slice(&bytes).unwrap();
        assert!(snapshot.restore(None).is_err());
        assert!(
            snapshot
                .restore(Some(
                    "https://new-user:new-password@other.invalid/v1?version=new&api_key=new-key"
                ))
                .is_err()
        );
        assert_eq!(
            snapshot
                .restore(Some(
                    "https://new-user:new-password@example.invalid/v1?version=new&api_key=new-key"
                ))
                .unwrap(),
            "https://new-user:new-password@example.invalid/v1?version=old&api_key=new-key"
        );
    }
    #[test]
    fn plain_endpoint_does_not_follow_the_new_default() {
        let snapshot =
            ModelEndpointSnapshot::capture("https://original.invalid/v1?version=old", &[]).unwrap();
        assert_eq!(
            snapshot.restore(Some("https://new.invalid/v2")).unwrap(),
            "https://original.invalid/v1?version=old"
        );
        assert!(
            ModelEndpointSnapshot::capture(
                "https://original.invalid/private-fixture/v1",
                &["private-fixture"]
            )
            .is_err()
        );
    }
    #[test]
    fn missing_or_reordered_secret_parameters_cannot_rebind() {
        let snapshot = ModelEndpointSnapshot::capture(
            "https://fixture.invalid/v1?version=old&token=private",
            &[],
        )
        .unwrap();
        for current in [
            "https://fixture.invalid/v1?version=old",
            "https://fixture.invalid/v1?token=new&version=old",
            "https://fixture.invalid/v1?version=old&token=",
        ] {
            assert!(snapshot.restore(Some(current)).is_err());
        }
    }

    #[test]
    fn encoded_path_secrets_and_signed_query_credentials_are_not_persisted() {
        assert!(ModelEndpointSnapshot::capture("https://fixture.invalid/a%2Fb", &["a/b"]).is_err());
        let snapshot = ModelEndpointSnapshot::capture(
            "https://fixture.invalid/v1?X-Amz-Signature=private-sig&subscription-key=private-key",
            &[],
        )
        .unwrap();
        let wire = serde_json::to_string(&snapshot).unwrap();
        assert!(!wire.contains("private-sig"));
        assert!(!wire.contains("private-key"));
        assert!(snapshot.restore(None).is_err());
    }
}
