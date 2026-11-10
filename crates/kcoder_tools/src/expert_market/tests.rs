use super::*;
use std::io::Write;

fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn expert_zip_refuses_traversal_and_accepts_inert_files() {
    assert!(parse_zip(&archive(&[("../outside", b"no")])).is_err());
    assert!(parse_zip(&archive(&[("C:/outside", b"no")])).is_err());
    assert!(parse_zip(&archive(&[("skills\\outside", b"no")])).is_err());
    let content = archive(&[
        ("SKILL.md", b"Instructions"),
        ("scripts/run.py", b"print('sample')"),
    ]);
    assert_eq!(parse_zip(&content).unwrap().len(), 2);
}

#[test]
fn expert_manifest_keeps_dependency_order_and_rejects_bad_slugs() {
    let value = serde_json::json!({"slug":"sample","displayName":{"zh":"专家","en":"Expert"},"summary":"Summary","skills":[{"slug":"one"},{"slug":"one"},{"slug":"two"}]});
    let item = market_item(&value, "en").unwrap();
    assert_eq!(item.title, "Expert");
    assert_eq!(item.skill_slugs, ["one", "two"]);
    assert!(manifest_skills(&serde_json::json!({"skillSlugs":["../secret"]})).is_err());
}

#[tokio::test]
async fn cancelled_market_request_never_publishes_content() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = ExpertMarketClient::new().unwrap().list("en", &cancel).await;
    assert!(result.is_err());
}

#[test]
fn expert_zip_rejects_high_compression_ratio() {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "SKILL.md",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
    writer.write_all(&vec![b'x'; 1024 * 1024]).unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    assert!(parse_zip(&bytes).is_err());
}

#[test]
fn expert_download_redirects_only_to_verified_asset_hosts() {
    for url in [
        "https://skillhub-1388575217.cos.accelerate.myqcloud.com/package.zip",
        "https://api.skillhub.cn/download",
    ] {
        assert!(allowed_asset_url(&reqwest::Url::parse(url).unwrap()));
    }
    for url in [
        "http://api.skillhub.cn/file",
        "https://api.skillhub.cn:8443/file",
        "https://user@api.skillhub.cn/file",
        "https://api.skillhub.cn.evil.invalid/file",
        "https://127.0.0.1/file",
    ] {
        assert!(!allowed_asset_url(&reqwest::Url::parse(url).unwrap()));
    }
}
