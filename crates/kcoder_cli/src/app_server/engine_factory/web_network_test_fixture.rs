//! A private owned fixture document, entirely absent from default release builds.
use anyhow::{Context, Result, ensure};
use kcoder_tools::web_network::test_fixture::WebNetworkTestDns;
use serde::Deserialize;
use std::{collections::HashMap, net::IpAddr, path::PathBuf};
const BUILD_TAG: &str = "kcoder-web-network-test-fixture/1";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    schema_version: u8,
    fixture_id: String,
    hosts: HashMap<String, Vec<IpAddr>>,
}
pub(super) fn load() -> Result<Option<WebNetworkTestDns>> {
    let Some(path) = std::env::var_os("KCODER_E2E_WEB_NETWORK_FIXTURE") else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    ensure!(
        path.is_absolute(),
        "{BUILD_TAG}: fixture path must be absolute"
    );
    let parent = kcoder_config::PrivateDirectory::open_existing(
        path.parent().context("fixture parent missing")?,
    )?;
    let snapshot = parent
        .read_source_document_snapshot(
            path.file_name().context("fixture leaf missing")?,
            8192,
            || true,
        )
        .with_context(|| format!("{BUILD_TAG}: fixture document unavailable"))?;
    let fixture: Fixture =
        serde_json::from_slice(snapshot.bytes()).context("fixture document invalid")?;
    ensure!(
        fixture.schema_version == 1 && uuid::Uuid::parse_str(&fixture.fixture_id).is_ok(),
        "{BUILD_TAG}: fixture identity invalid"
    );
    Ok(Some(
        WebNetworkTestDns::new(fixture.hosts).context("fixture origins invalid")?,
    ))
}
