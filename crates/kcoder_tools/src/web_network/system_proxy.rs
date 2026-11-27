//! Live acceptance remains on the actual Tools fetch entry.

#[cfg(windows)]
pub(super) use kcoder_web::policy::system_proxy::{AutomaticProxy, apply};

#[cfg(all(test, any(windows, target_os = "macos")))]
mod native_observation {
    #[tokio::test]
    #[ignore = "requires native platform and external-provider consent for one fixed public URL"]
    async fn native_inherited_proxy_reads_one_fixed_public_source_with_verified_tls() {
        assert_eq!(
            std::env::var("KCODER_TEST_LIVE_WEB_READ").as_deref(),
            Ok("1"),
            "UNMET_PREREQUISITE: explicit bounded external web read consent"
        );
        let root = tempfile::tempdir().unwrap();
        let context = crate::ToolContext::new(kcoder_state::AppState::new(root.path()));
        let source_url = match std::env::var("KCODER_TEST_LIVE_WEB_CASE").as_deref() {
            Ok("python-asyncio") => "https://docs.python.org/3/library/asyncio.html",
            Ok("example") | Err(_) => "https://example.com/",
            _ => panic!("Only the fixed public acceptance sources are allowed"),
        };
        let page = crate::web_fetch::read_page(source_url, true, &context)
            .await
            .expect("the fixed public source must be read through the actual target policy");
        assert!(page.page.status.is_success());
        assert!(matches!(page.page.content.state, "read" | "partial"));
        assert!(!page.page.content.markdown.is_empty());
        assert!(!page.cached);
        println!(
            "NATIVE_PUBLIC_WEB_READ={}",
            serde_json::json!({"publicUrl":source_url,"status":page.page.status.as_u16(),"bytes":page.page.bytes,"tlsVerification":true,"cacheHit":false,"modelCalls":0})
        );
    }
}
