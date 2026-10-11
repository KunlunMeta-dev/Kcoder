use super::*;
use crate::proxy_discovery::ProxyCacheKey;
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
        configured: Option<&str>,
        probe: &str,
        deadline: Instant,
        cancellation: &PluginCancellationToken,
    ) -> Result<ProxyDetection> {
        let started = Instant::now();
        let deadline = deadline.min(started + Duration::from_secs(20));
        cancellation.check()?;
        let key = ProxyCacheKey::new(probe, ports, configured)?;
        let recent = self
            .proxy_cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .recent(&key, started);
        let mut failed_proxy = None;
        let mut quick_checks = 0;
        let mut result = None;
        if let Some(entry) = recent {
            quick_checks = 1;
            let verified = crate::materialize::verify_proxy_https_targets(
                &entry.proxy,
                probe,
                deadline.min(Instant::now() + Duration::from_secs(2)),
                cancellation,
            );
            cancellation.check()?;
            match verified {
                Ok(target_hosts) => {
                    result = Some(ProxyDetection {
                        proxy_url: Some(entry.proxy),
                        target_hosts,
                        source: "cache",
                        quick_checks,
                        cache_age_ms: Some(
                            started
                                .saturating_duration_since(entry.verified_at)
                                .as_millis()
                                .min(u64::MAX as u128) as u64,
                        ),
                        ..Default::default()
                    })
                }
                Err(_) => {
                    self.proxy_cache
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .invalidate(&key);
                    failed_proxy = Some(entry.proxy);
                }
            }
        }
        let mut result = match result {
            Some(result) => result,
            None => crate::proxy_discovery::detect(
                ports,
                None,
                failed_proxy.as_deref(),
                probe,
                deadline,
                cancellation,
            )?,
        };
        result.quick_checks = quick_checks;
        if result.proxy_url.is_none()
            && Instant::now() < deadline
            && let Some(proxy) = configured.filter(|proxy| Some(*proxy) != failed_proxy.as_deref())
        {
            result.checked_candidates += 1;
            let verified = crate::materialize::verify_proxy_https_targets(
                proxy,
                probe,
                deadline,
                cancellation,
            );
            cancellation.check()?;
            if let Ok(target_hosts) = verified {
                result.proxy_url = Some(proxy.to_owned());
                result.target_hosts = target_hosts;
                result.source = "configured";
                result.timed_out = false;
            }
        }
        cancellation.check()?;
        result.duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        result.timed_out |= result.proxy_url.is_none() && Instant::now() >= deadline;
        if let Some(proxy) = result.proxy_url.clone() {
            self.proxy_cache
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remember(key, proxy, Instant::now());
        }
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
            self.proxy_cache
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clear();
            let configured =
                crate::network::resolve_proxy(settings.installation.proxy_url.as_deref())?;
            self.detect_download_proxy(
                &settings.installation.proxy_scan_ports,
                configured.as_ref().and_then(|proxy| proxy.to_str()),
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
            self.proxy_cache
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clear();
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
        let configured = crate::network::resolve_proxy(installation.proxy_url.as_deref())?;
        let detected = self.detect_download_proxy(
            &installation.proxy_scan_ports,
            configured.as_ref().and_then(|proxy| proxy.to_str()),
            probe,
            deadline,
            cancellation,
        )?;
        if let Some(proxy) = detected.proxy_url.clone() {
            return Ok(Some(proxy));
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

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};

    struct OwnedProcess(Child);
    impl OwnedProcess {
        fn stop(&mut self) {
            if self.0.try_wait().unwrap().is_none() {
                self.0.kill().unwrap();
            }
            self.0.wait().unwrap();
        }
    }
    impl Drop for OwnedProcess {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    // These fixtures test transport/cache boundaries independently of model behavior.
    const TLS_PROXY: &str = r#"
import json, pathlib, socket, ssl, sys, threading, time
root = pathlib.Path(sys.argv[1])
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(str(root / 'cert.pem'), str(root / 'key.pem'))
listeners = []
for family, host, good in [(socket.AF_INET, '127.0.0.1', False), (socket.AF_INET, '127.0.0.1', True), (socket.AF_INET6, '::1', True)]:
    s = socket.socket(family)
    if family == socket.AF_INET6: s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    s.bind((host, 0)); s.listen(32); s.settimeout(.05)
    listeners.append((s, good))
(root / 'ports.json').write_text(json.dumps([s.getsockname()[1] for s, good in listeners]))
def serve(conn, good):
    try:
        conn.settimeout(1)
        request = conn.recv(8192)
        if request.startswith(b'\x05'): conn.sendall(b'\x05\xff'); return
        if not request.startswith(b'CONNECT '): return
        if b'blocked.test:' in request or (root / 'network-down').exists():
            conn.sendall(b'HTTP/1.1 502 Bad Gateway\r\n\r\n'); return
        conn.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
        if not good: return
        if (root / 'stall').exists(): time.sleep(1); return
        with ctx.wrap_socket(conn, server_side=True) as tls:
            request = tls.recv(8192)
            path = request.split(b' ')[1] if request else b'/'
            location = None
            if path.startswith(b'/redirect'): location = b'https://redirect.test/final?secret=redirect-token'
            elif path.startswith(b'/blocked'): location = b'https://blocked.test/unavailable'
            elif path.startswith(b'/downgrade'): location = b'http://first.test/plain'
            elif path.startswith(b'/credentials'): location = b'https://user:secret@redirect.test/'
            elif path.startswith(b'/loop'): location = b'https://first.test/loop'
            if location:
                tls.sendall(b'HTTP/1.1 302 Found\r\nLocation: ' + location + b'\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            else:
                status = b'401 Unauthorized' if path.startswith(b'/auth') else b'429 Too Many Requests' if path.startswith(b'/rate') else b'204 No Content'
                tls.sendall(b'HTTP/1.1 ' + status + b'\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    except (OSError, ssl.SSLError): pass
    finally:
        conn.close()
while True:
    for s, good in listeners:
        if good and (root / 'stop-good').exists():
            s.close(); continue
        try:
            conn, _ = s.accept()
            threading.Thread(target=serve, args=(conn, good), daemon=True).start()
        except (socket.timeout, OSError): pass
    time.sleep(.005)
"#;

    #[test]
    fn owned_tls_proxy_cache_redirect_failure_recovery_and_target_isolation() {
        if let Some(root) = std::env::var_os("KCODER_OWNED_PROXY_TEST_ROOT") {
            run_owned_tls_cases(Path::new(&root));
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let generated = Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=first.test",
                "-addext",
                "subjectAltName=DNS:first.test,DNS:second.test,DNS:redirect.test",
            ])
            .arg("-keyout")
            .arg(root.path().join("key.pem"))
            .arg("-out")
            .arg(root.path().join("cert.pem"))
            .output()
            .unwrap();
        assert!(
            generated.status.success(),
            "owned TLS certificate generation failed"
        );
        let mut fixture = OwnedProcess(
            Command::new("python3")
                .arg("-c")
                .arg(TLS_PROXY)
                .arg(root.path())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        while !root.path().join("ports.json").is_file() {
            assert!(
                Instant::now() < deadline,
                "owned proxy fixture failed to start"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        // Certificate trust belongs only to this child test process, never the
        // parent test runner's shared environment or a developer profile.
        let mut child = OwnedProcess(Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "manager::proxy::tests::owned_tls_proxy_cache_redirect_failure_recovery_and_target_isolation", "--nocapture"])
            .env("KCODER_OWNED_PROXY_TEST_ROOT", root.path())
            .env("CURL_CA_BUNDLE", root.path().join("cert.pem"))
            .env_remove("KCODER_PLUGIN_GIT_PROXY")
            .env_remove("HTTPS_PROXY").env_remove("https_proxy")
            .env_remove("ALL_PROXY").env_remove("all_proxy")
            .env_remove("HTTP_PROXY").env_remove("http_proxy")
            .spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success(), "owned TLS proxy child cases failed");
                break;
            }
            assert!(
                Instant::now() < deadline,
                "owned TLS proxy child exceeded total test deadline"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        fixture.stop();
        assert!(
            fixture.0.try_wait().unwrap().is_some(),
            "owned fixture process must be reaped before success"
        );
        // OwnedProcess also guarantees cleanup during unwinding before certificates disappear.
    }

    fn run_owned_tls_cases(root: &Path) {
        let ports: Vec<u16> =
            serde_json::from_slice(&std::fs::read(root.join("ports.json")).unwrap()).unwrap();
        assert_eq!(ports.len(), 3);
        assert!(ports.iter().all(|port| *port > 1024));
        let cancellation = PluginCancellationToken::default();
        let installation = kcoder_config::PluginInstallationSettings {
            auto_detect_proxy: true,
            proxy_scan_ports: ports[..2].to_vec(),
            ..Default::default()
        };
        let manager = PluginManager::open(&root.join("store-a")).unwrap();
        let deadline = || Instant::now() + Duration::from_secs(5);
        let source = "https://first.test/source?secret=source-token";
        let first = manager
            .effective_download_proxy(&installation, source, deadline(), &cancellation)
            .unwrap()
            .unwrap();
        assert_eq!(first, format!("http://127.0.0.1:{}", ports[1]));
        let first_scan = manager.proxy_settings(root).unwrap().detection.unwrap();
        assert_eq!(first_scan.source, "scan");
        assert_eq!(first_scan.checked_ports, 2);
        assert_eq!(
            first_scan.checked_candidates, 2,
            "failed first candidate must not win"
        );
        manager
            .effective_download_proxy(&installation, source, deadline(), &cancellation)
            .unwrap();
        let cached = manager.proxy_settings(root).unwrap().detection.unwrap();
        assert_eq!(cached.source, "cache");
        assert_eq!(
            cached.checked_ports, 0,
            "recent success avoids listener discovery"
        );
        assert_eq!(cached.quick_checks, 1);
        assert_eq!(cached.target_hosts, ["https://first.test/"]);

        manager
            .effective_download_proxy(
                &installation,
                "https://second.test/source",
                deadline(),
                &cancellation,
            )
            .unwrap();
        assert_eq!(
            manager
                .proxy_settings(root)
                .unwrap()
                .detection
                .unwrap()
                .source,
            "scan",
            "one source does not establish another source's reachability"
        );
        manager
            .effective_download_proxy(
                &installation,
                "https://first.test/redirect?secret=source-token",
                deadline(),
                &cancellation,
            )
            .unwrap();
        let redirect = manager.proxy_settings(root).unwrap().detection.unwrap();
        assert_eq!(
            redirect.target_hosts,
            ["https://first.test/", "https://redirect.test/"]
        );
        assert!(
            redirect
                .target_hosts
                .iter()
                .all(|host| !host.contains("secret") && !host.contains("token"))
        );
        for path in ["blocked", "downgrade", "credentials", "loop"] {
            assert!(
                manager
                    .effective_download_proxy(
                        &installation,
                        &format!("https://first.test/{path}"),
                        deadline(),
                        &cancellation
                    )
                    .is_err(),
                "redirect failure must not reuse stale success: {path}"
            );
            assert!(
                manager
                    .proxy_settings(root)
                    .unwrap()
                    .detection
                    .unwrap()
                    .proxy_url
                    .is_none()
            );
        }
        for path in ["auth", "rate"] {
            assert!(
                manager
                    .effective_download_proxy(
                        &installation,
                        &format!("https://first.test/{path}"),
                        deadline(),
                        &cancellation
                    )
                    .unwrap()
                    .is_some(),
                "HTTP policy response still proves HTTPS route: {path}"
            );
        }

        let other_target = PluginManager::open(&root.join("store-b")).unwrap();
        other_target
            .effective_download_proxy(&installation, source, deadline(), &cancellation)
            .unwrap();
        assert_eq!(
            other_target
                .proxy_settings(root)
                .unwrap()
                .detection
                .unwrap()
                .source,
            "scan"
        );
        let v6 = kcoder_config::PluginInstallationSettings {
            proxy_scan_ports: vec![ports[2]],
            ..installation.clone()
        };
        assert_eq!(
            manager
                .effective_download_proxy(&v6, source, deadline(), &cancellation)
                .unwrap()
                .unwrap(),
            format!("http://[::1]:{}", ports[2])
        );

        manager
            .effective_download_proxy(&installation, source, deadline(), &cancellation)
            .unwrap();
        std::fs::write(root.join("network-down"), []).unwrap();
        assert!(
            manager
                .effective_download_proxy(&installation, source, deadline(), &cancellation)
                .is_err()
        );
        let failed = manager.proxy_settings(root).unwrap().detection.unwrap();
        assert_eq!(failed.quick_checks, 1);
        assert!(failed.proxy_url.is_none());
        std::fs::remove_file(root.join("network-down")).unwrap();
        manager
            .effective_download_proxy(&installation, source, deadline(), &cancellation)
            .unwrap();
        assert_eq!(
            manager
                .proxy_settings(root)
                .unwrap()
                .detection
                .unwrap()
                .source,
            "scan"
        );

        std::fs::write(root.join("stall"), []).unwrap();
        let cancel = PluginCancellationToken::default();
        let signal = cancel.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            signal.cancel();
        });
        let started = Instant::now();
        let error = manager
            .effective_download_proxy(&installation, source, deadline(), &cancel)
            .unwrap_err();
        assert!(format!("{error:#}").contains("cancelled"));
        assert!(started.elapsed() < Duration::from_secs(1));
        worker.join().unwrap();
        let started = Instant::now();
        assert!(
            manager
                .effective_download_proxy(
                    &installation,
                    source,
                    started + Duration::from_millis(150),
                    &cancellation
                )
                .is_err()
        );
        assert!(started.elapsed() < Duration::from_millis(600));
        assert!(
            manager
                .proxy_settings(root)
                .unwrap()
                .detection
                .unwrap()
                .timed_out
        );
        std::fs::remove_file(root.join("stall")).unwrap();
        manager
            .effective_download_proxy(&installation, source, deadline(), &cancellation)
            .unwrap();

        std::fs::write(root.join("stop-good"), []).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        assert!(
            manager
                .effective_download_proxy(&installation, source, deadline(), &cancellation)
                .is_err(),
            "stopped cached listener must invalidate prior success"
        );
        let stopped = manager.proxy_settings(root).unwrap().detection.unwrap();
        assert_eq!(stopped.quick_checks, 1);
        assert!(stopped.proxy_url.is_none());
        let stale_manual = kcoder_config::PluginInstallationSettings {
            proxy_url: Some(first),
            ..installation
        };
        assert!(
            manager
                .effective_download_proxy(&stale_manual, source, deadline(), &cancellation)
                .is_err(),
            "automatic mode must not reuse a stopped manual endpoint"
        );
        assert!(
            manager
                .proxy_settings(root)
                .unwrap()
                .detection
                .unwrap()
                .proxy_url
                .is_none()
        );
    }
}
