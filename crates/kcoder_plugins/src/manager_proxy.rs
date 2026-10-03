use super::*;
use crate::{PluginCancellationToken, ProxyDetection};
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct PluginProxySettings {
    pub auto_detect: bool,
    pub configured_url: Option<String>,
    pub detection: Option<ProxyDetection>,
}
impl PluginManager {
    pub fn proxy_settings(&self, cwd: &Path) -> Result<PluginProxySettings> {
        let settings = self.settings(cwd)?;
        if let Some(proxy) = &settings.installation.proxy_url {
            crate::validate_plugin_proxy(proxy)?;
        }
        Ok(PluginProxySettings {
            auto_detect: settings.installation.auto_detect_proxy,
            configured_url: settings.installation.proxy_url,
            detection: self
                .proxy_detection
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
        })
    }
    fn detect_download_proxy(
        &self,
        ports: &[u16],
        probe: &str,
        deadline: Instant,
        cancellation: &PluginCancellationToken,
    ) -> Result<ProxyDetection> {
        let preferred = self
            .proxy_detection
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .and_then(|r| r.proxy_url.clone());
        let result = crate::proxy_discovery::detect(
            ports,
            preferred.as_deref(),
            probe,
            deadline.min(Instant::now() + Duration::from_secs(20)),
            cancellation,
        )?;
        *self
            .proxy_detection
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(result.clone());
        Ok(result)
    }
    pub fn configure_auto_proxy(
        &self,
        cwd: &Path,
        enabled: bool,
        probe: Option<&str>,
        cancellation: &PluginCancellationToken,
    ) -> Result<PluginProxySettings> {
        let settings = self.settings(cwd)?;
        if enabled {
            self.detect_download_proxy(
                &settings.installation.proxy_scan_ports,
                probe.unwrap_or("https://github.com/"),
                Instant::now() + Duration::from_secs(20),
                cancellation,
            )?;
        }
        cancellation.check()?;
        let paths = self
            .config_paths
            .as_ref()
            .context("plugin manager has no writable settings path")?;
        update_scope(paths, ConfigScope::User, |document| {
            let root = document
                .as_object_mut()
                .context("settings root must be an object")?;
            object_entry(object_entry(root, "plugins")?, "installation")?
                .insert("auto_detect_proxy".into(), Value::Bool(enabled));
            Ok(())
        })?;
        self.update_cached_settings(|settings| settings.installation.auto_detect_proxy = enabled);
        if !enabled {
            *self
                .proxy_detection
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = None;
        }
        self.proxy_settings(cwd)
    }
    pub(super) fn effective_download_proxy(
        &self,
        installation: &kcoder_config::PluginInstallationSettings,
        probe: &str,
        deadline: Instant,
        cancellation: &PluginCancellationToken,
    ) -> Result<Option<String>> {
        if !installation.auto_detect_proxy {
            return Ok(installation.proxy_url.clone());
        }
        let detected = self.detect_download_proxy(
            &installation.proxy_scan_ports,
            probe,
            deadline,
            cancellation,
        )?;
        if let Some(proxy) = detected.proxy_url.clone() {
            return Ok(Some(proxy));
        }
        // Auto mode must never silently reuse a stale manual proxy.
        if let Some(proxy) = crate::network::resolve_proxy(installation.proxy_url.as_deref())? {
            let proxy = proxy.to_str().context("plugin proxy is not UTF-8")?;
            let origin = crate::proxy_discovery::probe_origin(probe)?;
            if crate::materialize::verify_proxy_https(proxy, &origin, deadline, cancellation)
                .is_ok()
            {
                let proxy = proxy.to_owned();
                let mut verified = detected;
                verified.proxy_url = Some(proxy.clone());
                verified.timed_out = false;
                *self
                    .proxy_detection
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(verified);
                return Ok(Some(proxy));
            }
        }
        bail!(
            "No working plugin proxy was verified after checking {} ports{}. Rescan the target's proxy ports or configure a working HTTP/SOCKS5 proxy.",
            detected.checked_ports,
            if detected.timed_out {
                " (scan timed out)"
            } else {
                ""
            }
        )
    }
}
