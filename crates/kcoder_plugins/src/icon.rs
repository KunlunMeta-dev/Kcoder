use anyhow::{Context, Result, bail};
use base64::Engine;
use std::io::Read;
use std::path::{Component, Path};

const MAX_ICON_BYTES: u64 = 512 * 1024;

pub(crate) fn read_icon(root: &Path, dark: bool) -> Result<Option<String>> {
    let Some(loaded) = crate::load_plugin_manifest(root)? else {
        return Ok(None);
    };
    let Some(interface) = loaded.manifest.interface else {
        return Ok(None);
    };
    let assets = if dark {
        [interface.logo_dark, interface.logo, interface.composer_icon]
    } else {
        [interface.logo, interface.composer_icon, interface.logo_dark]
    };
    for asset in assets.into_iter().flatten() {
        let result = match asset {
            crate::PluginAsset::RemoteUrl(url) => {
                // No server-side fetching, credentials or non-HTTPS URL schemes.
                let parsed = url::Url::parse(&url)?;
                if parsed.scheme() == "https"
                    && parsed.username().is_empty()
                    && parsed.password().is_none()
                {
                    Ok(Some(url))
                } else {
                    Ok(None)
                }
            }
            crate::PluginAsset::Local(resource) => read_local(root, &resource.relative_path),
        };
        if let Ok(Some(url)) = result {
            return Ok(Some(url));
        }
    }
    Ok(None)
}

/// Catalogs can provide HTTPS artwork before a package has been installed.
/// Never interpret catalog strings as target/client filesystem paths.
pub(crate) fn catalog_icon(metadata: Option<&serde_json::Value>, dark: bool) -> Option<String> {
    let metadata = metadata?;
    let paths = if dark {
        [
            "/interface/logoDark",
            "/logoDark",
            "/interface/logo",
            "/icon",
            "/icon_url",
            "/logo",
            "/interface/composerIcon",
        ]
    } else {
        [
            "/interface/logo",
            "/icon",
            "/icon_url",
            "/logo",
            "/interface/composerIcon",
            "/interface/logoDark",
            "/logoDark",
        ]
    };
    paths
        .into_iter()
        .filter_map(|path| metadata.pointer(path)?.as_str())
        .find_map(|value| {
            let url = url::Url::parse(value).ok()?;
            (url.scheme() == "https" && url.username().is_empty() && url.password().is_none())
                .then(|| url.to_string())
        })
}

fn read_local(root: &Path, relative: &Path) -> Result<Option<String>> {
    let mime = match relative
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => return Ok(None),
    };
    let mut parts = relative.components().peekable();
    let mut directory = kcoder_config::PrivateDirectory::open_existing(root)?;
    while let Some(part) = parts.next() {
        let Component::Normal(name) = part else {
            bail!("invalid icon path")
        };
        if parts.peek().is_some() {
            directory = directory.open_child(name, false)?;
            continue;
        }
        let file = directory.open_regular_file(name)?;
        if file.metadata()?.len() > MAX_ICON_BYTES {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        file.take(MAX_ICON_BYTES + 1)
            .read_to_end(&mut bytes)
            .context("read plugin icon")?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_ICON_BYTES {
            return Ok(None);
        }
        return Ok(Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selects_original_dark_logo_and_falls_back_when_it_is_too_large() {
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(temp.path().join(".codex-plugin")).unwrap();
        std::fs::write(temp.path().join("light.svg"), b"<svg>light</svg>").unwrap();
        std::fs::write(temp.path().join("dark.svg"), b"<svg>dark</svg>").unwrap();
        std::fs::write(
            temp.path().join(".codex-plugin/plugin.json"),
            r#"{"name":"icons","interface":{"logo":"./light.svg","logoDark":"./dark.svg"}}"#,
        )
        .unwrap();
        let light = read_icon(temp.path(), false).unwrap().unwrap();
        let dark = read_icon(temp.path(), true).unwrap().unwrap();
        assert_ne!(light, dark);
        std::fs::write(
            temp.path().join("dark.svg"),
            vec![0; MAX_ICON_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(read_icon(temp.path(), true).unwrap(), Some(light));
    }

    #[test]
    fn icons_are_bounded_and_read_relative_to_the_plugin() {
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            temp.path().join("icon.svg"),
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
        )
        .unwrap();
        assert!(
            read_local(temp.path(), Path::new("icon.svg"))
                .unwrap()
                .unwrap()
                .starts_with("data:image/svg+xml;base64,")
        );
        assert!(read_local(temp.path(), Path::new("../icon.svg")).is_err());
        std::fs::write(
            temp.path().join("huge.png"),
            vec![0; MAX_ICON_BYTES as usize + 1],
        )
        .unwrap();
        assert!(
            read_local(temp.path(), Path::new("huge.png"))
                .unwrap()
                .is_none()
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("icon.svg", temp.path().join("link.svg")).unwrap();
            assert!(read_local(temp.path(), Path::new("link.svg")).is_err());
        }
    }
}

#[cfg(test)]
mod catalog_tests {
    use super::catalog_icon;
    use serde_json::json;
    #[test]
    fn original_catalog_icons_use_safe_https_and_theme_fallbacks() {
        let value = json!({"interface":{"logo":"https://cdn.example/light.svg","logoDark":"https://cdn.example/dark.svg"}});
        assert_eq!(
            catalog_icon(Some(&value), false).as_deref(),
            Some("https://cdn.example/light.svg")
        );
        assert_eq!(
            catalog_icon(Some(&value), true).as_deref(),
            Some("https://cdn.example/dark.svg")
        );
        for icon in [
            "javascript:alert(1)",
            "file:///private/icon.png",
            "C:/private/icon.png",
            "https://user:secret@example.com/icon.svg",
        ] {
            assert!(catalog_icon(Some(&json!({"icon":icon})), false).is_none());
        }
        assert_eq!(
            catalog_icon(Some(&json!({"icon":"https://cdn.example/icon.png"})), true).as_deref(),
            Some("https://cdn.example/icon.png")
        );
    }
}

// Only known public catalog artwork hosts are fetched by the target. Arbitrary
// plugin URLs retain browser loading; they cannot cause target-side LAN requests.
pub(crate) fn is_hosted_icon(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && matches!(
            url.host_str(),
            Some("qoder-skills.oss-accelerate.aliyuncs.com" | "p11-market.byteimg.com")
        )
}

pub(crate) fn image_data_url(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES as usize {
        return None;
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if bytes.starts_with(b"\x00\x00\x01\x00") {
        "image/x-icon"
    } else if std::str::from_utf8(bytes).ok().is_some_and(|text| {
        let text = text.trim_start_matches('\u{feff}').trim_start();
        text.starts_with("<svg") || (text.starts_with("<?xml") && text.contains("<svg"))
    }) {
        "image/svg+xml"
    } else {
        return None;
    };
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod download_tests {
    use super::*;
    #[test]
    fn hosted_artwork_is_bounded_and_cannot_proxy_arbitrary_urls() {
        assert!(is_hosted_icon(
            "https://qoder-skills.oss-accelerate.aliyuncs.com/public/icon.png"
        ));
        for url in [
            "http://p11-market.byteimg.com/icon",
            "https://127.0.0.1/icon",
            "https://p11-market.byteimg.com.evil.test/icon",
            "https://user@p11-market.byteimg.com/icon",
        ] {
            assert!(!is_hosted_icon(url));
        }
        assert!(
            image_data_url(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>")
                .unwrap()
                .starts_with("data:image/svg+xml;base64,")
        );
        assert!(image_data_url(b"<html>login required</html>").is_none());
        assert!(image_data_url(&vec![0; MAX_ICON_BYTES as usize + 1]).is_none());
    }
}
