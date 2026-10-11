//! Explicitly authorized live test against only the supplied fixture window.
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows interactive desktop required");
    std::process::exit(2);
}

#[cfg(windows)]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use anyhow::{Context, ensure};
    use kcoder_computer_use::{client::ClientError, runtime::VerifiedRuntime};
    use kcoder_mcp::desktop_host::LocalDesktopHost;
    use kcoder_types::computer_use::{DesktopOwner, DesktopSessionState};
    use serde_json::{Value, json};
    use std::{
        path::PathBuf,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> *mut std::ffi::c_void;
        fn GetWindowThreadProcessId(window: *mut std::ffi::c_void, process: *mut u32) -> u32;
        fn GetAsyncKeyState(key: i32) -> i16;
        fn keybd_event(key: u8, scan: u8, flags: u32, extra: usize);
        fn mouse_event(flags: u32, x: u32, y: u32, data: u32, extra: usize);
    }
    struct Fixture {
        child: std::process::Child,
        directory: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::write(self.directory.join("close.fixture"), b"");
            for _ in 0..50 {
                if matches!(self.child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|arg| arg == "--verify-runtime") {
        ensure!(args.len() == 4, "runtime root and inventory pin required");
        VerifiedRuntime::verify(&PathBuf::from(&args[2]), &args[3].to_string_lossy())?;
        println!("{}", json!({"verified":true,"desktopInputSent":false}));
        return Ok(());
    }
    if args
        .get(1)
        .is_some_and(|arg| arg == "--internal-desktop-recovery")
    {
        ensure!(args.len() == 4, "invalid recovery probe invocation");
        return kcoder_mcp::desktop_recovery::run(
            std::path::Path::new(&args[2]),
            args[3].to_str().context("invalid recovery pipe")?,
        )
        .await;
    }
    ensure!(
        args.len() == 5
            || args.len() == 6
                && (args[5] == "--held-scroll"
                    || args[5] == "--held-drag"
                    || args[5] == "--text-input"),
        "usage: desktop_live_probe runtime inventory-sha fixture.ps1 output-directory [--held-scroll|--held-drag|--text-input]"
    );
    let output = PathBuf::from(&args[4]);
    ensure!(!output.exists(), "output directory must be new");
    std::fs::create_dir_all(&output)?;
    let result = async {
        let runtime=VerifiedRuntime::verify(&PathBuf::from(&args[1]), &args[2].to_string_lossy())?;
        let child=Command::new("powershell.exe").args(["-NoProfile","-STA","-ExecutionPolicy","Bypass","-File"])
            .arg(&args[3]).arg("-OutputDirectory").arg(&output).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
        let mut fixture=Fixture {child,directory:output.clone()};
        let deadline=Instant::now()+Duration::from_secs(20);
        let ready: Value=loop {
            if let Ok(bytes)=std::fs::read(output.join("fixture-ready.json")) {
                if let Ok(value)=serde_json::from_slice(&bytes) { break value; }
            }
            ensure!(fixture.child.try_wait()?.is_none(), "fixture exited");
            ensure!(Instant::now()<deadline, "fixture startup timeout");
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        let hwnd=ready["hwnd"].as_u64().context("fixture handle missing")? as usize;
        let assert_focus=|stage: &str|->anyhow::Result<()> {
            let foreground = unsafe {GetForegroundWindow()};
            let mut foreground_pid = 0;
            unsafe { GetWindowThreadProcessId(foreground, &mut foreground_pid); }
            ensure!(foreground as usize==hwnd,"fixture lost foreground before {stage}; foreground pid={foreground_pid}, fixture pid={}; refusing desktop operation", ready["pid"]); Ok(())
        };
        let temporary=kcoder_config::create_private_temp_dir("kcoder-live-worker")?;
        let host=LocalDesktopHost::start_authorized(&runtime,temporary.path(),DesktopOwner {
            client_instance:"live-probe".into(),thread_id:"owned-fixture".into(),turn_id:"native-host".into(),
        }).await?;
        let operations = async {
            assert_focus("first operation")?;
            if args.len() == 6 && args[5] != "--text-input" {
                let drag = args[5] == "--held-drag";
                let key = if drag { 1 } else { 16 };
                ensure!(unsafe { GetAsyncKeyState(key) } >= 0, "Input already held; refusing held-input test");
                let session = host.session.clone();
                let loc = ready["inputLoc"].clone();
                let (tool, arguments) = if drag {
                    let x=loc[0].as_i64().context("invalid fixture x")?;
                    let y=loc[1].as_i64().context("invalid fixture y")?;
                    ("Move",json!({"from_loc":loc,"loc":[x+80,y+40],"drag":true,"duration":10}))
                } else { ("Scroll",json!({"loc":loc,"type":"horizontal","direction":"left","wheel_times":1000})) };
                let call = tokio::spawn(async move {
                    session.call(tool, arguments, Duration::from_secs(60)).await
                });
                let until = Instant::now() + Duration::from_secs(5);
                while unsafe { GetAsyncKeyState(key) } >= 0 && Instant::now() < until {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                let observed_down = unsafe { GetAsyncKeyState(key) } < 0;
                let stop_started = Instant::now();
                let stopped = host.stop().await;
                let stop_elapsed = stop_started.elapsed();
                let residual = unsafe { GetAsyncKeyState(key) } < 0;
                // Test-only restoration: baseline control was up, the only input
                // producer was this owned operation, and the user authorized no
                // concurrent interaction. This is not production cleanup.
                if residual { unsafe { if drag { mouse_event(4,0,0,0,0); } else { keybd_event(16,0,3,0); } } }
                tokio::time::sleep(Duration::from_millis(50)).await;
                let restored = unsafe { GetAsyncKeyState(key) } >= 0;
                let interrupted = tokio::time::timeout(Duration::from_secs(3), call).await;
                let call_cancelled = matches!(interrupted, Ok(Ok(Err(_))));
                std::fs::write(output.join("held-input-result.json"), serde_json::to_vec_pretty(&json!({
                    "control":if drag {"left_mouse"} else {"shift"},"observedInputDown":observed_down,"stopSucceeded":stopped.is_ok(),
                    "inputHeldAfterStop":residual,"inputUpAfterCleanup":restored,"probeCleanupUsed":residual,"callCancelled":call_cancelled,"stopMillis":stop_elapsed.as_millis(),
                }))?)?;
                stopped?;
                ensure!(call_cancelled && stop_elapsed < Duration::from_secs(5), "stop did not interrupt the running call promptly");
                ensure!(observed_down && restored, "held-input test did not complete safely");
                ensure!(!residual, "worker stopped but input remained down; probe restored it");
                return Ok::<(),anyhow::Error>(());
            }
            let screenshot=host.session.call("Screenshot",json!({"region":ready["region"],"use_annotation":false}),Duration::from_secs(30)).await
                .map_err(|error|anyhow::anyhow!("screenshot failed: {error:?}"))?;
            ensure!(screenshot["content"].as_array().is_some_and(|items|items.iter().any(|item|item["type"]=="image")),"screenshot has no image");
            assert_focus("snapshot")?;
            let snapshot=host.session.call("Snapshot",json!({"region":ready["region"],"use_vision":true,"use_annotation":false}),Duration::from_secs(45)).await
                .map_err(|error|anyhow::anyhow!("UIA snapshot failed: {error:?}"))?;
            let snapshot_text=snapshot["content"].as_array().context("snapshot content missing")?.iter()
                .filter_map(|item|item["text"].as_str()).collect::<Vec<_>>().join("\n");
            ensure!(snapshot_text.contains("KCoderInput") || snapshot_text.contains("Verify test input"),"fixture controls missing from UIA snapshot");
            let samples = if args.get(5).is_some_and(|mode|mode == "--text-input") {
                vec!["KCoder 长文本与 emoji 😀 — English text 0123456789 repeated for clipboard testing.",
                     "中文 😀\nEnglish 123\n第二行"]
            } else { vec!["KCoder 中文输入 123"] };
            for expected in &samples {
                for (name,arguments) in [
                    ("Type",json!({"loc":ready["inputLoc"],"text":expected,"clear":true})),
                    ("Click",json!({"loc":ready["buttonLoc"]})),
                ] {
                    assert_focus(name)?;
                    let result=host.session.call(name,arguments,Duration::from_secs(30)).await.map_err(|error|anyhow::anyhow!("{name} failed: {error:?}"))?;
                    ensure!(result["isError"]!=true,"desktop operation returned an error");
                }
                let deadline=Instant::now()+Duration::from_secs(5);
                loop {
                    if let Ok(bytes)=std::fs::read(output.join("input-result.json")) {
                        if let Ok(value)=serde_json::from_slice::<Value>(&bytes) {
                            if value["clicked"]==true && value["text"].as_str().is_some_and(|text|text.replace("\r\n","\n")==*expected) {
                                break;
                            }
                        }
                    }
                    ensure!(Instant::now()<deadline,"fixture text did not match after input");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
            Ok::<(),anyhow::Error>(())
        }.await;
        // Cleanup is awaited even if the UI assertion fails.
        host.stop().await?;
        operations?;
        ensure!(*host.session.subscribe_state().borrow()==DesktopSessionState::Stopped,"stop was not confirmed");
        ensure!(host.session.call("Click",json!({"loc":ready["buttonLoc"]}),Duration::from_secs(1)).await==Err(ClientError::Disconnected),"stopped session accepted input");
        drop(host);
        drop(fixture);
        Ok::<_,anyhow::Error>(if args.len() == 6 && args[5] != "--text-input" { json!({"status":"passed","nativeHost":true,"heldInputStop":args[5].to_string_lossy(),"stopConfirmed":true,"postStopInputRejected":true}) } else { json!({"status":"passed","nativeHost":true,"croppedScreenshot":true,"uiaSnapshot":true,"chineseInput":true,"longAndMultilineUnicode":args.get(5).is_some_and(|mode|mode == "--text-input"),"stopConfirmed":true,"postStopInputRejected":true}) })
    }.await;
    let report = match &result {
        Ok(value) => value.clone(),
        Err(error) => json!({"status":"failed","error":format!("{error:#}")}),
    };
    std::fs::write(
        output.join("native-result.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{report}");
    result.map(|_| ())
}
