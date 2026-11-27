//! Owned offline adapter fixtures. No public search or external DNS is performed.
use super::*;
use kcoder_types::web_search::WebSearchErrorKind;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

const QUERY: &str = "owned redirect fixture";

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap()
}

async fn scripted(
    replies: Vec<(u16, Option<&'static str>, String)>,
    cancel: Option<CancellationToken>,
) -> (String, JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut paths = Vec::new();
        for (status, location, body) in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let mut buffer = [0; 2048];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0 && request.len() + count <= 8192);
                request.extend_from_slice(&buffer[..count]);
            }
            let request = std::str::from_utf8(&request).unwrap();
            let path = request
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let url = reqwest::Url::parse(&format!("http://fixture{path}")).unwrap();
            assert_eq!(
                url.query_pairs().find(|(key, _)| key == "q").unwrap().1,
                QUERY
            );
            paths.push(url.path().to_owned());
            if let Some(cancel) = &cancel {
                cancel.cancel();
            }
            let location = location
                .map(|value| format!("Location: {value}\r\n"))
                .unwrap_or_default();
            let reply = format!(
                "HTTP/1.1 {status} Fixture\r\n{location}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        paths
    });
    (format!("http://{address}/search"), server)
}

#[tokio::test]
async fn follows_owned_canonical_redirect_without_changing_the_query() {
    let (url,server)=scripted(vec![
        (302,Some("/canonical?q=owned+redirect+fixture"),String::new()),
        (200,None,r#"<li class="b_algo"><h2><a href="https://example.com/source">Owned source</a></h2><p>Snippet</p></li>"#.into())
    ],None).await;
    let input = serde_json::from_value(serde_json::json!({"query":QUERY})).unwrap();
    let page = search_bing_page(&client(), &input, &url, 0, None, None)
        .await
        .unwrap();
    assert_eq!(page.results.len(), 1);
    assert_eq!(page.results[0].url, "https://example.com/source");
    assert_eq!(server.await.unwrap(), ["/search", "/canonical"]);
}

#[tokio::test]
async fn redirect_loop_stops_without_a_third_dispatch() {
    let (url, server) = scripted(
        vec![
            (302, Some("/loop?q=owned+redirect+fixture"), String::new()),
            (302, Some("/loop?q=owned+redirect+fixture"), String::new()),
        ],
        None,
    )
    .await;
    let input = serde_json::from_value(serde_json::json!({"query":QUERY})).unwrap();
    let error = search_bing_page(&client(), &input, &url, 0, None, None)
        .await
        .unwrap_err();
    assert_eq!(error.kind, WebSearchErrorKind::ContractInvalid);
    assert!(error.message.contains("loop"));
    assert!(error.request_sent);
    assert_eq!(server.await.unwrap(), ["/search", "/loop"]);
}

#[tokio::test]
async fn cancellation_and_revocation_after_a_redirect_keep_the_sent_fact() {
    for kind in [
        WebSearchErrorKind::Cancelled,
        WebSearchErrorKind::PolicyDenied,
    ] {
        let cancel = CancellationToken::new();
        let (url, server) = scripted(
            vec![(302, Some("/next?q=owned+redirect+fixture"), String::new())],
            Some(cancel.clone()),
        )
        .await;
        let guard = SearchDispatchGuard::new(move |_| {
            if cancel.is_cancelled() {
                Err(SearchFailure::new(kind, "Owned dispatch revoked", false))
            } else {
                Ok(())
            }
        });
        let input = serde_json::from_value(serde_json::json!({"query":QUERY})).unwrap();
        let error = search_bing_page(&client(), &input, &url, 0, Some(&guard), None)
            .await
            .unwrap_err();
        assert_eq!(error.kind, kind);
        assert!(error.request_sent);
        assert_eq!(server.await.unwrap(), ["/search"]);
    }
}

#[tokio::test]
async fn page_reader_private_grants_cannot_authorize_a_search_hop() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = kcoder_state::AppState::new(".");
    let grant = crate::web_network::WebNetworkAuthority::new(&state);
    grant
        .grant_origin(&format!("http://{address}"), Duration::from_secs(5))
        .unwrap();
    let context = ToolContext::new(state).with_web_network_authority(grant);
    let input = serde_json::from_value(serde_json::json!({"query":QUERY})).unwrap();
    let error = search_bing_page(
        &client(),
        &input,
        &format!("http://{address}/search"),
        0,
        None,
        Some(&context),
    )
    .await
    .unwrap_err();
    assert!(!error.request_sent);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    assert!(
        context.web_network_authority.is_some(),
        "The page reader's original authority must remain intact"
    );
}
