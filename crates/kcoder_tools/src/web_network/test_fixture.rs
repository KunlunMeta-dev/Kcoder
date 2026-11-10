//! Compiled only for owned network protocol fixtures; never a release entry.
use crate::{ToolContext, ToolError};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

#[derive(Clone)]
pub struct WebNetworkTestDns(Arc<HashMap<String, Vec<IpAddr>>>);
impl WebNetworkTestDns {
    pub fn new(hosts: HashMap<String, Vec<IpAddr>>) -> Result<Self, ToolError> {
        if !(2..=4).contains(&hosts.len())
            || hosts.keys().any(|host| {
                !matches!(
                    host.as_str(),
                    "mcp.exa.ai" | "example.com" | "www.bing.com" | "cn.bing.com"
                )
            })
            || !["mcp.exa.ai", "example.com"]
                .iter()
                .all(|host| hosts.contains_key(*host))
            || hosts.values().any(|addresses| {
                addresses.is_empty()
                    || addresses.len() > 4
                    || addresses.iter().any(|ip| !super::is_public_ip(*ip))
            })
        {
            return Err(ToolError::InvalidInput(
                "The owned web fixture requires its fixed public origins and optional fixed fallback origins".into(),
            ));
        }
        Ok(Self(Arc::new(hosts)))
    }
    pub fn private_destination_origin(&self, raw: &str) -> Result<Option<String>, ToolError> {
        let url = super::validate_url(raw)?;
        let host = url.host_str().unwrap().trim_matches(['[', ']']);
        let addresses = self.resolve(host, url.port_or_known_default().unwrap())?;
        super::validate_addresses(&addresses, false)?;
        Ok(None)
    }
    pub(super) fn resolve(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, ToolError> {
        self.0
            .get(host)
            .map(|ips| ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect())
            .ok_or_else(|| {
                ToolError::Execution("The owned web fixture refuses an undeclared origin".into())
            })
    }
}
impl ToolContext {
    /// Host-owned immutable DNS fixture; all ordinary public-IP/policy/TLS checks still apply.
    pub fn with_web_network_test_dns(mut self, dns: Option<WebNetworkTestDns>) -> Self {
        self.web_network_test_dns = dns;
        self
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixture_refuses_unknown_origins_and_private_addresses() {
        let map = || {
            HashMap::from([
                ("mcp.exa.ai".into(), vec!["93.184.216.34".parse().unwrap()]),
                ("example.com".into(), vec!["93.184.215.14".parse().unwrap()]),
            ])
        };
        let dns = WebNetworkTestDns::new(map()).unwrap();
        assert!(dns.resolve("other.example", 443).is_err());
        assert_eq!(
            dns.resolve("example.com", 443).unwrap()[0].to_string(),
            "93.184.215.14:443"
        );
        let mut fallback = map();
        fallback.insert(
            "www.bing.com".into(),
            vec!["13.107.21.200".parse().unwrap()],
        );
        fallback.insert("cn.bing.com".into(), vec!["13.107.21.201".parse().unwrap()]);
        let dns = WebNetworkTestDns::new(fallback).unwrap();
        assert_eq!(
            dns.resolve("www.bing.com", 443).unwrap()[0].to_string(),
            "13.107.21.200:443"
        );
        assert_eq!(
            dns.resolve("cn.bing.com", 443).unwrap()[0].to_string(),
            "13.107.21.201:443"
        );
        let mut invalid = map();
        invalid.insert("example.com".into(), vec!["127.0.0.1".parse().unwrap()]);
        assert!(WebNetworkTestDns::new(invalid).is_err());
        let mut invalid = map();
        invalid.insert("extra.example".into(), vec!["8.8.8.8".parse().unwrap()]);
        assert!(WebNetworkTestDns::new(invalid).is_err());
    }
}
