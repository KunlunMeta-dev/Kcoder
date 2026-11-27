//! Read-only platform proxy discovery. Explicit environment variables, even
//! empty ones, take precedence. Snapshotting never downloads or executes PAC.
use kcoder_tool_error::ToolError;

pub(super) type Environment = Vec<(String, Option<String>)>;
#[derive(Clone, Default, Hash)]
struct StaticProxy {
    http: Option<String>,
    https: Option<String>,
    socks: Option<String>,
    bypass: Option<String>,
    automatic: bool,
    auto_detect: bool,
    auto_config_url: Option<String>,
}

/// Host-only configuration; never serialize PAC URLs or proxy endpoints.
#[derive(Clone, Hash)]
pub struct AutomaticProxy {
    pub auto_detect: bool,
    pub config_url: Option<String>,
    fallback: StaticProxy,
}

impl AutomaticProxy {
    #[cfg(all(windows, any(test, feature = "test-oracle")))]
    pub fn for_test(config_url: Option<String>, auto_detect: bool) -> Self {
        Self {
            config_url,
            auto_detect,
            fallback: StaticProxy::default(),
        }
    }

    #[cfg(any(windows, test))]
    pub fn fallback(&self, url: &url::Url) -> Result<Option<url::Url>, ToolError> {
        if super::bypasses(url, "localhost,127.0.0.1,::1")
            || super::bypasses(url, self.fallback.bypass.as_deref().unwrap_or(""))
        {
            return Ok(None);
        }
        let raw = if url.scheme() == "https" {
            &self.fallback.https
        } else {
            &self.fallback.http
        }
        .as_ref()
        .or(self.fallback.socks.as_ref());
        raw.map(|value| url::Url::parse(value).map_err(|_| invalid()))
            .transpose()
    }
}

fn has_environment_proxy(environment: &Environment) -> bool {
    [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ]
    .iter()
    .any(|name| {
        environment
            .iter()
            .any(|(key, value)| key == name && value.is_some())
    })
}
fn merge(environment: &mut Environment, snapshot: StaticProxy) -> Result<(), ToolError> {
    if has_environment_proxy(environment) {
        return Ok(());
    }
    if snapshot.automatic {
        return Err(ToolError::Execution("The target system uses PAC or automatic proxy discovery, which is not supported by this web transport".into()));
    }
    let mut configured = false;
    for (name, value) in [
        ("HTTP_PROXY", snapshot.http),
        ("HTTPS_PROXY", snapshot.https),
        ("ALL_PROXY", snapshot.socks),
    ] {
        if let Some(value) = value {
            set(environment, name, value);
            configured = true;
        }
    }
    if configured
        && !environment.iter().any(|(name, value)| {
            matches!(name.as_str(), "NO_PROXY" | "no_proxy") && value.is_some()
        })
    {
        set(
            environment,
            "NO_PROXY",
            match snapshot.bypass {
                Some(bypass) if !bypass.is_empty() => format!("localhost,127.0.0.1,::1,{bypass}"),
                _ => "localhost,127.0.0.1,::1".into(),
            },
        );
    }
    Ok(())
}
fn set(environment: &mut Environment, name: &str, value: String) {
    if let Some((_, current)) = environment.iter_mut().find(|(key, _)| key == name) {
        *current = Some(value);
    } else {
        environment.push((name.into(), Some(value)));
    }
}
fn normalized_proxy(raw: &str, scheme: &str) -> Result<String, ToolError> {
    let raw = raw.trim();
    let value = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("{scheme}://{raw}")
    };
    let url = url::Url::parse(&value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "socks4" | "socks5")
        || url.host_str().is_none()
        || url.port_or_known_default() == Some(0)
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url.to_string())
}
fn invalid() -> ToolError {
    ToolError::Execution(
        "The target system static proxy configuration is invalid or unsupported".into(),
    )
}

pub fn apply(environment: &mut Environment) -> Result<Option<AutomaticProxy>, ToolError> {
    if has_environment_proxy(environment) {
        return Ok(None);
    }
    #[cfg(windows)]
    {
        apply_windows(environment, windows_snapshot()?)
    }
    #[cfg(target_os = "macos")]
    {
        merge(environment, macos_snapshot()?).map(|()| None)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Ok(None)
    }
}

#[cfg(any(windows, test))]
fn apply_windows(
    environment: &mut Environment,
    snapshot: StaticProxy,
) -> Result<Option<AutomaticProxy>, ToolError> {
    if has_environment_proxy(environment) {
        return Ok(None);
    }
    if snapshot.automatic {
        // Manual bypass rules apply only if automatic discovery finds no PAC.
        // They must not silently bypass a PAC decision for the original URL.
        return Ok(Some(AutomaticProxy {
            auto_detect: snapshot.auto_detect,
            config_url: snapshot.auto_config_url.clone(),
            fallback: snapshot,
        }));
    }
    merge(environment, snapshot)?;
    Ok(None)
}

#[cfg(any(windows, test))]
fn windows_default_configuration() -> StaticProxy {
    // Microsoft's WinhttpProxy sample retains automatic discovery when the
    // account has no IE proxy settings yet. Discovery remains request-only.
    StaticProxy {
        automatic: true,
        auto_detect: true,
        ..StaticProxy::default()
    }
}

#[cfg(windows)]
fn windows_snapshot() -> Result<StaticProxy, ToolError> {
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, GetLastError, GlobalFree},
        Networking::WinHttp::{
            WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WinHttpGetIEProxyConfigForCurrentUser,
        },
    };
    struct OwnedConfig(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG);
    impl Drop for OwnedConfig {
        fn drop(&mut self) {
            for pointer in [
                self.0.lpszAutoConfigUrl,
                self.0.lpszProxy,
                self.0.lpszProxyBypass,
            ] {
                if !pointer.is_null() {
                    // SAFETY: WinHTTP allocates these strings with GlobalAlloc.
                    unsafe {
                        GlobalFree(pointer.cast());
                    }
                }
            }
        }
    }
    let mut config = OwnedConfig(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default());
    // SAFETY: the writable config outlives this synchronous, read-only call.
    if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config.0) } == 0 {
        // SAFETY: read immediately after the failed Win32 call.
        return if unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND {
            Ok(windows_default_configuration())
        } else {
            Err(invalid())
        };
    }
    // SAFETY: all three pointers are owned NUL-terminated WinHTTP strings.
    let text =
        |pointer| unsafe { super::windows_auto_proxy::read_wide(pointer) }.map_err(|_| invalid());
    let proxy = text(config.0.lpszProxy)?;
    let bypass = text(config.0.lpszProxyBypass)?;
    let pac = text(config.0.lpszAutoConfigUrl)?;
    let mut snapshot = match proxy {
        Some(raw) => windows_values(&raw, bypass.as_deref())?,
        None => StaticProxy::default(),
    };
    snapshot.auto_detect = config.0.fAutoDetect != 0;
    snapshot.auto_config_url = pac;
    snapshot.automatic = snapshot.auto_detect || snapshot.auto_config_url.is_some();
    Ok(snapshot)
}

#[cfg(any(windows, test))]
fn windows_values(raw: &str, bypass: Option<&str>) -> Result<StaticProxy, ToolError> {
    let mut result = StaticProxy::default();
    if raw.len() > 8192 || raw.trim().is_empty() {
        return Err(invalid());
    }
    if raw.contains('=') {
        for part in raw.split(';').map(str::trim).filter(|v| !v.is_empty()) {
            let (scheme, value) = part.split_once('=').ok_or_else(invalid)?;
            match scheme.to_ascii_lowercase().as_str() {
                "http" => result.http = Some(normalized_proxy(value, "http")?),
                "https" => result.https = Some(normalized_proxy(value, "http")?),
                "socks" => result.socks = Some(normalized_proxy(value, "socks4")?),
                _ => {}
            }
        }
    } else {
        let proxy = normalized_proxy(raw, "http")?;
        result.http = Some(proxy.clone());
        result.https = Some(proxy);
    }
    result.bypass = bypass.map(|bypass| {
        bypass
            .split(';')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| {
                v.strip_prefix("*.")
                    .map_or_else(|| v.to_owned(), |suffix| format!(".{suffix}"))
            })
            .collect::<Vec<_>>()
            .join(",")
    });
    Ok(result)
}

#[cfg(target_os = "macos")]
fn macos_snapshot() -> Result<StaticProxy, ToolError> {
    use system_configuration::core_foundation::{
        array::CFArray,
        base::{CFType, TCFType},
        dictionary::CFDictionary,
        number::CFNumber,
        string::CFString,
    };
    use system_configuration::dynamic_store::SCDynamicStoreBuilder;
    fn number(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<i64> {
        dict.find(CFString::new(key))
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_i64())
    }
    fn text(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<String> {
        dict.find(CFString::new(key))
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string())
    }
    fn server(
        dict: &CFDictionary<CFString, CFType>,
        prefix: &str,
        scheme: &str,
    ) -> Result<Option<String>, ToolError> {
        if number(dict, &format!("{prefix}Enable")).unwrap_or(0) == 0 {
            return Ok(None);
        }
        let host = text(dict, &format!("{prefix}Proxy")).ok_or_else(invalid)?;
        let port = number(dict, &format!("{prefix}Port"))
            .filter(|port| (1..=65535).contains(port))
            .ok_or_else(invalid)?;
        if host
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '@' | '?' | '#'))
        {
            return Err(invalid());
        }
        let host = if host.parse::<std::net::Ipv6Addr>().is_ok() {
            format!("[{host}]")
        } else {
            host
        };
        Ok(Some(normalized_proxy(&format!("{host}:{port}"), scheme)?))
    }
    let store = SCDynamicStoreBuilder::new("KCoder web network policy")
        .build()
        .ok_or_else(invalid)?;
    let Some(dict) = store.get_proxies() else {
        return Ok(StaticProxy::default());
    };
    let automatic = number(&dict, "ProxyAutoConfigEnable").unwrap_or(0) != 0
        || number(&dict, "ProxyAutoDiscoveryEnable").unwrap_or(0) != 0;
    let mut bypass = vec!["localhost".into(), "127.0.0.1".into(), "::1".into()];
    if number(&dict, "ExcludeSimpleHostnames").unwrap_or(0) != 0 {
        bypass.push("<local>".into());
    }
    if let Some(array) = dict
        .find(CFString::new("ExceptionsList"))
        .and_then(|v| v.downcast::<CFArray>())
    {
        if array.len() > 256 {
            return Err(invalid());
        }
        for item in array.iter() {
            // The untyped CF array retains its values. Type-check each borrowed
            // element before accessing it as a string; never assume its class.
            let value = unsafe { CFType::wrap_under_get_rule(*item) };
            let value = value
                .downcast::<CFString>()
                .ok_or_else(invalid)?
                .to_string();
            if value.len() > 8192 {
                return Err(invalid());
            }
            bypass.push(
                value
                    .strip_prefix("*.")
                    .map_or_else(|| value.clone(), |suffix| format!(".{suffix}")),
            );
        }
    }
    Ok(StaticProxy {
        http: server(&dict, "HTTP", "http")?,
        https: server(&dict, "HTTPS", "http")?,
        socks: server(&dict, "SOCKS", "socks5")?,
        bypass: Some(bypass.join(",")),
        automatic,
        ..StaticProxy::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_environment_including_empty_values_prevents_native_fallback() {
        for name in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            let mut env = vec![(name.into(), Some(String::new()))];
            merge(
                &mut env,
                StaticProxy {
                    automatic: true,
                    ..StaticProxy::default()
                },
            )
            .unwrap();
            assert_eq!(env, vec![(name.into(), Some(String::new()))]);
        }
    }

    #[test]
    fn windows_automatic_only_is_lazy_and_static_does_not_override_pac() {
        let mut environment = Vec::new();
        let automatic = apply_windows(
            &mut environment,
            StaticProxy {
                automatic: true,
                auto_detect: true,
                http: Some("http://manual.invalid:80".into()),
                bypass: Some("*.example.org".into()),
                ..StaticProxy::default()
            },
        )
        .unwrap()
        .unwrap();
        assert!(environment.is_empty());
        assert!(automatic.auto_detect);
        assert_eq!(automatic.config_url, None);
        assert!(
            automatic
                .fallback(&url::Url::parse("http://www.example.org/doc").unwrap())
                .unwrap()
                .is_none()
        );
        assert_eq!(
            automatic
                .fallback(&url::Url::parse("http://other.invalid/doc").unwrap())
                .unwrap()
                .unwrap()
                .host_str(),
            Some("manual.invalid")
        );
    }

    #[test]
    fn missing_user_proxy_settings_retain_lazy_windows_discovery() {
        let mut environment = Vec::new();
        let automatic = apply_windows(&mut environment, windows_default_configuration())
            .unwrap()
            .unwrap();
        assert!(environment.is_empty());
        assert!(automatic.auto_detect);
        assert!(automatic.config_url.is_none());
        assert!(
            automatic
                .fallback(&url::Url::parse("https://example.org/").unwrap())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn automatic_pac_and_fallback_changes_have_a_private_generation() {
        use std::hash::{Hash, Hasher};
        let generation = |pac: &str| {
            let automatic = apply_windows(
                &mut Vec::new(),
                StaticProxy {
                    automatic: true,
                    auto_config_url: Some(pac.into()),
                    ..StaticProxy::default()
                },
            )
            .unwrap();
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            automatic.hash(&mut hash);
            hash.finish()
        };
        assert_eq!(
            generation("http://private.invalid/a.pac"),
            generation("http://private.invalid/a.pac")
        );
        assert_ne!(
            generation("http://private.invalid/a.pac"),
            generation("http://private.invalid/b.pac")
        );
        for name in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            let mut environment = vec![(name.into(), Some(String::new()))];
            assert!(
                apply_windows(
                    &mut environment,
                    StaticProxy {
                        automatic: true,
                        auto_detect: true,
                        ..StaticProxy::default()
                    }
                )
                .unwrap()
                .is_none()
            );
        }
    }
    #[test]
    fn windows_static_mapping_is_scheme_correct_and_preserves_explicit_bypass() {
        let snapshot = windows_values(
            "http=127.0.0.1:80;https=127.0.0.1:81",
            Some("*.example.com;<local>"),
        )
        .unwrap();
        let mut env = vec![("NO_PROXY".into(), Some("owned.example".into()))];
        merge(&mut env, snapshot).unwrap();
        assert!(env.contains(&("HTTP_PROXY".into(), Some("http://127.0.0.1/".into()))));
        assert!(env.contains(&("HTTPS_PROXY".into(), Some("http://127.0.0.1:81/".into()))));
        assert!(env.contains(&("NO_PROXY".into(), Some("owned.example".into()))));
    }
    #[test]
    fn windows_unversioned_socks_preserves_the_platform_socks4_default() {
        let snapshot = windows_values("socks=127.0.0.1:1080", None).unwrap();
        let proxy = url::Url::parse(snapshot.socks.as_deref().unwrap()).unwrap();
        assert_eq!(proxy.scheme(), "socks4");
        assert_eq!(proxy.port(), Some(1080));
    }

    #[test]
    fn unsupported_automatic_modes_and_invalid_static_values_fail_explicitly() {
        assert!(
            merge(
                &mut Vec::new(),
                StaticProxy {
                    automatic: true,
                    ..StaticProxy::default()
                }
            )
            .is_err()
        );
        assert!(windows_values("https://proxy.example:443", None).is_err());
        assert!(windows_values("", None).is_err());
    }
}

#[cfg(all(test, any(windows, target_os = "macos")))]
mod native_observation {
    use super::*;
    #[test]
    #[ignore = "requires explicitly consented native read-only system proxy observation"]
    fn native_static_proxy_observation_is_read_only_and_redacted() {
        #[cfg(windows)]
        let snapshot =
            windows_snapshot().expect("the actual Windows static proxy state must be readable");
        #[cfg(target_os = "macos")]
        let snapshot =
            macos_snapshot().expect("the actual macOS static proxy state must be readable");
        let observation = serde_json::json!({"readOnly":true,"platform":std::env::consts::OS,
            "httpConfigured":snapshot.http.is_some(),"httpsConfigured":snapshot.https.is_some(),
            "socksConfigured":snapshot.socks.is_some(),"automaticConfigured":snapshot.automatic,
            "automaticUnsupported":snapshot.automatic && cfg!(target_os = "macos"),
            "credentialsPrinted":false,"externalRequests":0,"registryWrites":0});
        let automatic = snapshot.automatic;
        let mut environment = Vec::new();
        #[cfg(windows)]
        let effective = apply_windows(&mut environment, snapshot);
        #[cfg(target_os = "macos")]
        let effective = merge(&mut environment, snapshot);
        #[cfg(windows)]
        assert_eq!(
            effective
                .expect("Windows settings are captured without PAC network I/O")
                .is_some(),
            automatic
        );
        #[cfg(target_os = "macos")]
        if automatic {
            assert!(effective.is_err());
        } else {
            effective.expect("static system proxy must yield an effective target policy");
        }
        println!("NATIVE_WEB_PROXY_OBSERVATION={observation}");
    }
}
