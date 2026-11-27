//! Read-only compatibility with the one documented Windows startup registration.
//! Registration supplies source hints; Native handles, fences and owners still admit the operation.
use anyhow::Result;
#[cfg(any(windows, test))]
use anyhow::{Context, ensure};
use kcoder_types::StoragePaths;
#[cfg(any(windows, test))]
use serde::Deserialize;
#[cfg(any(windows, test))]
use sha2::{Digest, Sha256};
#[cfg(any(windows, test))]
use std::path::Component;
use std::path::{Path, PathBuf};

#[cfg(any(windows, test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registration {
    version: u32,
    sid: String,
    source_directory: PathBuf,
    directory: PathBuf,
    source_data_key: Option<String>,
    data_directory: Option<PathBuf>,
    servers_store: Option<PathBuf>,
    clear_catalog_inputs: Option<bool>,
    selection_source: Option<String>,
}

pub(super) struct RegisteredSources {
    pub(super) native: PathBuf,
    pub(super) gateway: Option<PathBuf>,
}

#[cfg(any(windows, test))]
fn normalized(path: &Path) -> Result<PathBuf> {
    let text = path
        .to_str()
        .context("STORAGE_LEGACY_REGISTRATION_INVALID")?;
    ensure!(
        path.is_absolute() && text.len() <= 32767 && !text.contains(['\0', '\r', '\n']),
        "STORAGE_LEGACY_REGISTRATION_INVALID"
    );
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            value => result.push(value.as_os_str()),
        }
    }
    Ok(result)
}

#[cfg(any(windows, test))]
fn same(left: &Path, right: &Path) -> Result<bool> {
    Ok(normalized(left)?.to_str().unwrap().to_lowercase()
        == normalized(right)?.to_str().unwrap().to_lowercase())
}

#[cfg(any(windows, test))]
fn data_key(data: &str, store: &str, catalog: Option<&str>, inline: &str) -> Result<String> {
    let input = serde_json::to_vec(&(
        data.to_lowercase(),
        store.to_lowercase(),
        catalog,
        format!("{:x}", Sha256::digest(inline.as_bytes())),
    ))?;
    Ok(format!("{:x}", Sha256::digest(input)))
}

#[cfg(any(windows, test))]
fn parse(
    raw: &str,
    sid: &str,
    home: &Path,
    gateway: &Path,
    check_input: bool,
    catalog: Option<&str>,
    inline: &str,
) -> Result<Option<RegisteredSources>> {
    let record: Registration =
        serde_json::from_str(raw).context("STORAGE_LEGACY_REGISTRATION_INVALID")?;
    if record.sid != sid || !same(&record.source_directory, &home.join(".config/kcoder"))? {
        return Ok(None);
    }
    ensure!(
        [1, 2].contains(&record.version)
            && record
                .selection_source
                .as_deref()
                .is_none_or(|source| ["interactive", "installer"].contains(&source)),
        "STORAGE_LEGACY_REGISTRATION_INVALID"
    );
    let default_native = home.join(".config/kcoder");
    let native = if same(&record.directory, &default_native)? {
        default_native
    } else {
        normalized(&record.directory)?
    };
    let gateway = if record.version == 2 {
        let key = record
            .source_data_key
            .context("STORAGE_LEGACY_REGISTRATION_INVALID")?;
        ensure!(
            key.len() == 64
                && key
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && record.clear_catalog_inputs.is_some(),
            "STORAGE_LEGACY_REGISTRATION_INVALID"
        );
        if check_input {
            ensure!(
                key == data_key(
                    gateway.to_str().context("STORAGE_PATH_INVALID")?,
                    gateway
                        .join("servers.json")
                        .to_str()
                        .context("STORAGE_PATH_INVALID")?,
                    catalog,
                    inline
                )?,
                "STORAGE_LEGACY_REGISTRATION_INPUT_CHANGED"
            );
        }
        let data = normalized(
            &record
                .data_directory
                .context("STORAGE_LEGACY_REGISTRATION_INVALID")?,
        )?;
        let store = normalized(
            &record
                .servers_store
                .context("STORAGE_LEGACY_REGISTRATION_INVALID")?,
        )?;
        ensure!(
            same(&store, &data.join("servers.json"))?,
            "STORAGE_LEGACY_REGISTERED_CATALOG_UNSUPPORTED"
        );
        Some(if same(&data, gateway)? {
            gateway.to_owned()
        } else {
            data
        })
    } else {
        None
    };
    Ok(Some(RegisteredSources { native, gateway }))
}

#[cfg(not(windows))]
pub(super) fn read(_home: &Path, _check_input: bool) -> Result<Option<RegisteredSources>> {
    Ok(None)
}

#[cfg(windows)]
pub(super) fn read(home: &Path, check_input: bool) -> Result<Option<RegisteredSources>> {
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, LocalFree},
        Security::Authorization::ConvertSidToStringSidW,
        System::{
            Registry::{HKEY_CURRENT_USER, RRF_RT_REG_SZ, RegGetValueW},
            Threading::GetCurrentProcess,
        },
    };
    if kcoder_config::storage::current_storage_paths()?.externally_configured {
        return Ok(None);
    }
    // SAFETY: this pseudo-handle names this process; the existing reader copies its validated SID.
    let mut sid_bytes =
        kcoder_native_scope::service_identity::process_sid(unsafe { GetCurrentProcess() })?;
    let mut sid_text = std::ptr::null_mut();
    // SAFETY: the validated SID remains live; the API owns the returned LocalAlloc string below.
    ensure!(
        unsafe { ConvertSidToStringSidW(sid_bytes.as_mut_ptr().cast(), &mut sid_text) } != 0,
        "STORAGE_LEGACY_REGISTRATION_UNAVAILABLE"
    );
    // SAFETY: a successful conversion returns a terminated SID string shorter than this bound.
    let sid = unsafe {
        let mut length = 0;
        while length < 256 && *sid_text.add(length) != 0 {
            length += 1;
        }
        let result = String::from_utf16(std::slice::from_raw_parts(sid_text, length));
        LocalFree(sid_text.cast());
        result.context("STORAGE_LEGACY_REGISTRATION_UNAVAILABLE")?
    };
    let key: Vec<u16> = "Software\\KunlunMeta\\KCoder Studio\0"
        .encode_utf16()
        .collect();
    let value: Vec<u16> = "SelectedPrivateProfileV1\0".encode_utf16().collect();
    let mut bytes = 0;
    // SAFETY: both names are terminated; the first query writes only the required byte count.
    let first = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut bytes,
        )
    };
    if [ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND].contains(&first) {
        return Ok(None);
    }
    ensure!(
        first == ERROR_SUCCESS && bytes > 0 && bytes <= 512 * 1024 && bytes % 2 == 0,
        "STORAGE_LEGACY_REGISTRATION_UNAVAILABLE"
    );
    let mut buffer = vec![0u16; (bytes / 2) as usize];
    // SAFETY: the live UTF-16 allocation holds the bounded requested byte count.
    ensure!(
        unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            )
        } == ERROR_SUCCESS
            && bytes as usize <= buffer.len() * 2
            && bytes % 2 == 0,
        "STORAGE_LEGACY_REGISTRATION_UNAVAILABLE"
    );
    buffer.truncate((bytes / 2) as usize);
    if buffer.last() == Some(&0) {
        buffer.pop();
    }
    ensure!(!buffer.contains(&0), "STORAGE_LEGACY_REGISTRATION_INVALID");
    let raw = String::from_utf16(&buffer).context("STORAGE_LEGACY_REGISTRATION_INVALID")?;
    let gateway = dirs::config_dir()
        .context("STORAGE_HOME_UNAVAILABLE")?
        .join("kcoder-studio");
    let catalog = std::env::var("KCODER_STUDIO_SERVERS_FILE")
        .ok()
        .filter(|value| !value.is_empty());
    parse(
        &raw,
        &sid,
        home,
        &gateway,
        check_input,
        catalog.as_deref(),
        &std::env::var("KCODER_STUDIO_SERVERS").unwrap_or_default(),
    )
}

pub(super) fn apply(paths: &mut StoragePaths, source: &RegisteredSources) {
    paths.data_root = source.native.clone();
    paths.cache_root = source.native.join("tmp");
    paths.temporary_root = paths.cache_root.clone();
    if let Some(gateway) = &source.gateway {
        paths.gateway_root = gateway.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn windows_input_fingerprint_matches_the_retired_node_reader() {
        assert_eq!(
            data_key(
                r"C:\Users\Example\AppData\Roaming\kcoder-studio",
                r"C:\Users\Example\AppData\Roaming\kcoder-studio\servers.json",
                Some(r"D:\输入\servers.json"),
                r#"[{"id":"fixture"}]"#
            )
            .unwrap(),
            "78ab1eb9cbfdeac1cca197cd79b67ef5164fb5e095690b1d4112c3f8170d68d0"
        );
    }

    #[test]
    fn only_current_sid_and_original_native_input_select_a_registered_source() {
        let home = tempfile::tempdir().unwrap();
        let source = home.path().join("old-native");
        let mut record = json!({"version":1,"sid":"current","sourceDirectory":home.path().join(".config/kcoder"),"directory":source});
        assert_eq!(
            parse(
                &record.to_string(),
                "current",
                home.path(),
                home.path(),
                true,
                None,
                ""
            )
            .unwrap()
            .unwrap()
            .native,
            source
        );
        record["sid"] = json!("another-account");
        assert!(
            parse(
                &record.to_string(),
                "current",
                home.path(),
                home.path(),
                true,
                None,
                ""
            )
            .unwrap()
            .is_none()
        );
        record["sid"] = json!("current");
        record["sourceDirectory"] = json!(home.path().join("another-profile"));
        assert!(
            parse(
                &record.to_string(),
                "current",
                home.path(),
                home.path(),
                true,
                None,
                ""
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn v2_requires_matching_catalog_inputs_and_an_owned_gateway_catalog() {
        let home = tempfile::tempdir().unwrap();
        let original = home.path().join("original-gateway");
        let data = home.path().join("registered-gateway");
        let key = data_key(
            original.to_str().unwrap(),
            original.join("servers.json").to_str().unwrap(),
            None,
            "",
        )
        .unwrap();
        let mut record = json!({"version":2,"sid":"current","sourceDirectory":home.path().join(".config/kcoder"),
            "directory":home.path().join("old-native"),"sourceDataKey":key,"dataDirectory":data,
            "serversStore":data.join("servers.json"),"clearCatalogInputs":true});
        assert_eq!(
            parse(
                &record.to_string(),
                "current",
                home.path(),
                &original,
                true,
                None,
                ""
            )
            .unwrap()
            .unwrap()
            .gateway,
            Some(data)
        );
        assert_eq!(
            parse(
                &record.to_string(),
                "current",
                home.path(),
                &original,
                true,
                None,
                "changed"
            )
            .err()
            .unwrap()
            .to_string(),
            "STORAGE_LEGACY_REGISTRATION_INPUT_CHANGED"
        );
        record["serversStore"] = json!(home.path().join("other-catalog/servers.json"));
        assert_eq!(
            parse(
                &record.to_string(),
                "current",
                home.path(),
                &original,
                true,
                None,
                ""
            )
            .err()
            .unwrap()
            .to_string(),
            "STORAGE_LEGACY_REGISTERED_CATALOG_UNSUPPORTED"
        );
    }
}
