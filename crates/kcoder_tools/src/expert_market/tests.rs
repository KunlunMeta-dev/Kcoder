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
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "skills/stats/data/sample.csv",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
    writer.write_all(&b"0,1,male,22\n".repeat(5000)).unwrap();
    let small = writer.finish().unwrap().into_inner();
    assert_eq!(parse_zip(&small).unwrap().len(), 1);
}

#[test]
fn expert_download_redirects_only_to_verified_asset_hosts() {
    for url in [
        "https://skillhub-1388575217.cos.accelerate.myqcloud.com/package.zip",
        "https://api.skillhub.cn/download",
        "https://octop.cloud/api/market/experts",
        "https://download.octop.cloud/octop/market/experts/a/1.0.0/a-1.0.0.zip",
    ] {
        assert!(allowed_asset_url(&reqwest::Url::parse(url).unwrap()));
    }
    for url in [
        "http://api.skillhub.cn/file",
        "https://api.skillhub.cn:8443/file",
        "https://user@api.skillhub.cn/file",
        "https://api.skillhub.cn.evil.invalid/file",
        "https://127.0.0.1/file",
        "http://download.octop.cloud/file",
        "https://download.octop.cloud.evil.invalid/file",
        "https://evil.octop.cloud/file",
    ] {
        assert!(!allowed_asset_url(&reqwest::Url::parse(url).unwrap()));
    }
}

#[test]
fn merged_catalog_prefers_octop_and_orders_by_scene_not_source() {
    let expert = |slug: &str, title: &str, scene: &str| AgentMarketDefinition {
        slug: slug.into(),
        title: title.into(),
        description: String::new(),
        scene: scene.into(),
        skill_slugs: Vec::new(),
    };
    let merged = merge_sources(
        vec![
            expert("shared", "B octop", "tech"),
            expert("octop-only", "D octop", "unknown"),
        ],
        vec![
            expert("shared", "B skillhub", "tech"),
            expert("skillhub-only", "A skillhub", "tech"),
        ],
        vec![
            expert("lobehub-a", "C lobehub", "tech"),
            expert("lobehub-b", "E lobehub", "office"),
        ],
    );
    let pairs: Vec<_> = merged
        .iter()
        .map(|item| (item.slug.as_str(), item.title.as_str()))
        .collect();
    assert_eq!(
        pairs,
        [
            ("lobehub-b", "E lobehub"),
            ("skillhub-only", "A skillhub"),
            ("shared", "B octop"),
            ("lobehub-a", "C lobehub"),
            ("octop-only", "D octop"),
        ]
    );
}
