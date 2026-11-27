//! Bing GET canonicalization stays inside its original service and attempt.
use super::SearchFailure;
use kcoder_types::web_search::WebSearchErrorKind;
use reqwest::{Url, header::HeaderValue};
use std::collections::HashSet;

const MAX_HOPS: usize = 3;

pub(super) struct Chain {
    original: Url,
    current: Url,
    seen: HashSet<String>,
    hops: usize,
    fixture: bool,
}

fn bing(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url
            .host_str()
            .is_some_and(|host| host == "bing.com" || host.ends_with(".bing.com"))
        && matches!(url.path(), "/search" | "/search/")
}

fn denied() -> SearchFailure {
    SearchFailure::new(
        WebSearchErrorKind::PolicyDenied,
        "Bing redirect is outside the approved search source",
        true,
    )
}

impl Chain {
    pub(super) fn new(original: Url, fixture: bool) -> Self {
        let fixture = fixture
            && original.host().is_some_and(|host| match host {
                url::Host::Ipv4(ip) => ip.is_loopback(),
                url::Host::Ipv6(ip) => ip.is_loopback(),
                _ => false,
            });
        Self {
            current: original.clone(),
            seen: HashSet::from([original.to_string()]),
            original,
            hops: 0,
            fixture,
        }
    }

    pub(super) fn current(&self) -> &Url {
        &self.current
    }

    pub(super) fn follow(&mut self, location: Option<&HeaderValue>) -> Result<(), SearchFailure> {
        if self.hops >= MAX_HOPS {
            return Err(SearchFailure::new(
                WebSearchErrorKind::ContractInvalid,
                "Bing redirect limit exceeded",
                true,
            ));
        }
        let location = location
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                SearchFailure::new(
                    WebSearchErrorKind::ContractInvalid,
                    "Bing redirect has no valid location",
                    true,
                )
            })?;
        let target = self.current.join(location).map_err(|_| denied())?;
        let mut target = crate::policy::validate_url(target.as_str()).map_err(|_| denied())?;
        target.set_fragment(None);
        let allowed = if self.fixture {
            target.origin() == self.original.origin()
        } else {
            bing(&self.original) && bing(&target)
        };
        let query = |url: &Url| {
            url.query_pairs()
                .filter(|(key, _)| key == "q")
                .map(|(_, value)| value.into_owned())
                .collect::<Vec<_>>()
        };
        if !allowed
            || (self.current.scheme() == "https" && target.scheme() != "https")
            || query(&target) != query(&self.original)
        {
            return Err(denied());
        }
        if !self.seen.insert(target.to_string()) {
            return Err(SearchFailure::new(
                WebSearchErrorKind::ContractInvalid,
                "Bing redirect loop detected",
                true,
            ));
        }
        self.current = target;
        self.hops += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn regional_targets_stay_in_the_bing_https_search_family() {
        let original = reqwest::Url::parse("https://www.bing.com/search?q=owned").unwrap();
        let mut chain = Chain::new(original.clone(), false);
        chain
            .follow(Some(&HeaderValue::from_static(
                "https://cn.bing.com/search?q=owned",
            )))
            .unwrap();
        assert_eq!(chain.current().host_str(), Some("cn.bing.com"));
        for location in [
            "http://www.bing.com/search?q=owned",
            "https://www.bing.com.evil.invalid/search?q=owned",
            "https://notbing.com/search?q=owned",
            "https://127.0.0.1/search?q=owned",
            "https://[::1]/search?q=owned",
            "https://169.254.169.254/search?q=owned",
            "https://user:secret@cn.bing.com/search?q=owned",
            "https://cn.bing.com:444/search?q=owned",
            "https://cn.bing.com/ck/a?q=owned",
            "https://cn.bing.com/search?q=changed",
        ] {
            let error = Chain::new(original.clone(), false)
                .follow(Some(&HeaderValue::from_str(location).unwrap()))
                .unwrap_err();
            assert_eq!(error.kind, WebSearchErrorKind::PolicyDenied);
            assert!(error.request_sent);
        }
    }

    #[test]
    fn hop_limit_is_not_a_retry_or_a_new_source() {
        let mut chain = Chain::new(
            reqwest::Url::parse("https://www.bing.com/search?q=owned").unwrap(),
            false,
        );
        for hop in 0..3 {
            chain
                .follow(Some(
                    &HeaderValue::from_str(&format!("/search?q=owned&hop={hop}")).unwrap(),
                ))
                .unwrap();
        }
        let error = chain
            .follow(Some(&HeaderValue::from_static("/search?q=owned&hop=4")))
            .unwrap_err();
        assert_eq!(error.kind, WebSearchErrorKind::ContractInvalid);
        assert!(error.message.contains("limit"));
        assert!(error.request_sent);
    }
}
