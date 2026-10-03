use super::*;
use std::time::Instant;

impl PluginManager {
    pub(super) fn materialize_icon(
        &self,
        cwd: &Path,
        icon: Option<String>,
    ) -> Result<Option<String>> {
        let Some(url) = icon else { return Ok(None) };
        if !crate::icon::is_hosted_icon(&url) {
            return Ok(Some(url));
        }
        if let Some(data) = self
            .icon_cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&url)
            .cloned()
        {
            return Ok(Some(data));
        }
        let installation = self.settings(cwd)?.installation;
        if !installation.allow_http {
            return Ok(Some(url));
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        let cancellation = crate::PluginCancellationToken::default();
        // Reuse the verified target proxy for artwork; do not scan every port for
        // every visible card. The actual HTTPS download still verifies TLS.
        let known = self
            .proxy_detection
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .and_then(|r| r.proxy_url.clone());
        let proxy = if installation.auto_detect_proxy {
            match known {
                Some(proxy) => Some(proxy),
                None => {
                    self.effective_download_proxy(&installation, &url, deadline, &cancellation)?
                }
            }
        } else {
            installation.proxy_url.clone()
        };
        let bytes = crate::materialize::download_https(
            &url,
            proxy.as_deref(),
            512 * 1024,
            deadline,
            &cancellation,
        )?;
        let Some(data) = crate::icon::image_data_url(&bytes) else {
            return Ok(None);
        };
        let mut cache = self.icon_cache.lock().unwrap_or_else(|p| p.into_inner());
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(url, data.clone());
        Ok(Some(data))
    }
}
