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
