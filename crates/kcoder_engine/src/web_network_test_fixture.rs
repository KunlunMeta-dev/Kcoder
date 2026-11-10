//! Explicit host-only fixture wiring. The normal build has no such API.
impl crate::QueryEngine {
    pub fn with_web_network_test_dns(
        mut self,
        dns: Option<kcoder_tools::web_network::test_fixture::WebNetworkTestDns>,
    ) -> Self {
        self.web_network_test_dns = dns;
        self
    }
}
