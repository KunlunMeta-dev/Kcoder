#![cfg(windows)]
use anyhow::{Context, Result, ensure};
use kcoder_native_scope::service_identity::{
    windows_account::{CurrentWindowsPeerAccount, CurrentWindowsServiceAccount},
    windows_image::WindowsServiceImage,
    windows_pipe::{ServicePipe, asynchronous::CurrentUserPipeListener},
};
use std::{
    os::windows::io::BorrowedHandle,
    process::{Child, Command},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn image() -> Result<WindowsServiceImage> {
    let process = unsafe {
        BorrowedHandle::borrow_raw(
            windows_sys::Win32::System::Threading::GetCurrentProcess().cast(),
        )
    };
    WindowsServiceImage::capture(process, &CancellationToken::new())
}
fn elevated() -> Result<bool> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation},
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    let mut token = std::ptr::null_mut();
    ensure!(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } != 0,
        "test token query failed"
    );
    let mut data: TOKEN_ELEVATION = unsafe { std::mem::zeroed() };
    let mut length = 0;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            (&mut data as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of_val(&data) as u32,
            &mut length,
        )
    };
    unsafe { CloseHandle(token) };
    ensure!(ok != 0, "test elevation query failed");
    Ok(data.TokenIsElevated != 0)
}

#[test]
fn peer_source_constructor_keeps_personal_service_and_purpose_boundaries() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let _entered = runtime.enter();
    CurrentWindowsPeerAccount::capture()?.verify()?;
    let elevated = elevated()?;
    eprintln!("peer_source_actual_elevation={elevated}");
    if elevated {
        let error = CurrentWindowsServiceAccount::capture()
            .err()
            .context("an elevated personal service must remain denied")?;
        assert!(
            error
                .chain()
                .any(|c| c.to_string() == "SERVICE_WINDOWS_NONPRIVILEGED_TOKEN_REQUIRED")
        );
    } else {
        CurrentWindowsServiceAccount::capture()?.verify()?;
    }
    assert!(
        CurrentUserPipeListener::bind_peer_source(
            r"\\.\pipe\kcoder-service-v1-not-a-peer-source".into()
        )
        .is_err()
    );
    let name = format!(
        r"\\.\pipe\kcoder-service-v1-peer-source-{:064x}",
        uuid::Uuid::new_v4().as_u128()
    );
    drop(CurrentUserPipeListener::bind_peer_source(name)?);
    Ok(())
}

#[test]
fn peer_source_two_real_processes_exchange_full_public_text_bound() -> Result<()> {
    roundtrip(false)
}
#[test]
fn peer_source_frame_includes_lf_and_rejects_first_overflow_before_writing() -> Result<()> {
    roundtrip(true)
}
fn payload(key: &str, control: char, boundary: bool) -> serde_json::Value {
    let mut value = serde_json::json!({});
    value[key] = serde_json::json!("");
    let len = if boundary {
        128 * 1024 - 1 - serde_json::to_vec(&value).unwrap().len()
    } else {
        16 * 1024
    };
    value[key] = serde_json::json!(if boundary {
        "a".repeat(len)
    } else {
        control.to_string().repeat(len)
    });
    value
}
fn roundtrip(boundary: bool) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let name = format!(
            r"\\.\pipe\kcoder-service-v1-peer-source-{:064x}",
            uuid::Uuid::new_v4().as_u128()
        );
        let mut listener = CurrentUserPipeListener::bind_peer_source(name.clone())?;
        let original = image()?;
        let mut child = OwnedChild(
            Command::new(std::env::current_exe()?)
                .args([
                    "--ignored",
                    "--exact",
                    "owned_peer_source_client",
                    "--nocapture",
                ])
                .env("KCODER_OWNED_PEER_SOURCE_PIPE", &name)
                .env(
                    "KCODER_OWNED_PEER_BOUNDARY",
                    if boundary { "1" } else { "0" },
                )
                .spawn()?,
        );
        let cancel = CancellationToken::new();
        let accepted = tokio::time::timeout(
            Duration::from_secs(10),
            listener.accept_same_image(&original, &cancel),
        )
        .await??;
        accepted.peer.verify()?;
        let mut reader = tokio::io::BufReader::new(accepted.io);
        let mut bytes = Vec::new();
        (&mut reader)
            .take(128 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
            .await?;
        ensure!(
            bytes.len() <= 128 * 1024 && bytes.last() == Some(&b'\n'),
            "request frame bound"
        );
        let value: serde_json::Value = serde_json::from_slice(&bytes)?;
        assert_eq!(value, payload("text", '\u{1}', boundary));
        if boundary {
            assert_eq!(bytes.len(), 128 * 1024);
        }
        accepted.peer.verify()?;
        let mut response = serde_json::to_vec(&payload("reply", '\u{2}', boundary))?;
        response.push(b'\n');
        reader.get_mut().write_all(&response).await?;
        accepted.peer.verify()?;
        drop(reader);
        drop(listener);
        let exit = tokio::task::spawn_blocking(move || child.0.wait()).await??;
        ensure!(exit.success(), "owned client failed");
        Ok(())
    })
}

#[test]
#[ignore = "owned helper executed by its parent"]
fn owned_peer_source_client() -> Result<()> {
    let name = std::env::var("KCODER_OWNED_PEER_SOURCE_PIPE")?;
    let original = image()?;
    let mut pipe = ServicePipe::connect_peer_source_same_image(&name, &original)?
        .context("owned pipe missing")?;
    let boundary = std::env::var("KCODER_OWNED_PEER_BOUNDARY")?.as_str() == "1";
    let value = payload("text", '\u{1}', boundary);
    if boundary {
        let mut too_large = value.clone();
        too_large["text"] = serde_json::json!(format!("{}a", value["text"].as_str().unwrap()));
        assert_eq!(serde_json::to_vec(&too_large)?.len(), 128 * 1024);
        assert!(pipe.write(&too_large).is_err());
    }
    pipe.write(&value)?;
    let value = pipe.read(Duration::from_secs(10), 128 * 1024)?;
    assert_eq!(value, payload("reply", '\u{2}', boundary));
    pipe.verify()?;
    pipe.wait_peer_closed(Duration::from_secs(5))?;
    Ok(())
}

#[test]
fn peer_source_negative_impersonation_retires_no_primary_token() -> Result<()> {
    use windows_sys::Win32::Security::{ImpersonateSelf, RevertToSelf, SecurityImpersonation};
    let account = CurrentWindowsPeerAccount::capture()?;
    ensure!(
        unsafe { ImpersonateSelf(SecurityImpersonation) } != 0,
        "owned impersonation setup"
    );
    struct Revert;
    impl Drop for Revert {
        fn drop(&mut self) {
            unsafe { RevertToSelf() };
        }
    }
    let guard = Revert;
    assert!(CurrentWindowsPeerAccount::capture().is_err());
    assert!(account.verify().is_err());
    drop(guard);
    account.verify()?;
    Ok(())
}

#[test]
fn peer_source_negative_same_account_different_image_never_exposes_a_frame() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let name = format!(
            r"\\.\pipe\kcoder-service-v1-peer-source-{:064x}",
            uuid::Uuid::new_v4().as_u128()
        );
        let mut listener = CurrentUserPipeListener::bind_peer_source(name.clone())?;
        let original = image()?;
        let short = name.strip_prefix(r"\\.\pipe\").unwrap();
        let script = format!(
            "$s=[IO.Pipes.NamedPipeClientStream]::new('.','{short}',[IO.Pipes.PipeDirection]::InOut);try{{$s.Connect(5000);$b=[byte[]]::new(1);$null=$s.Read($b,0,1)}}catch{{}}finally{{$s.Dispose()}};exit 0"
        );
        let powershell = std::path::PathBuf::from(
            std::env::var_os("SystemRoot").context("SystemRoot")?,
        )
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut child = OwnedChild(
            Command::new(powershell)
                .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &script])
                .spawn()?,
        );
        let error = tokio::time::timeout(
            Duration::from_secs(10),
            listener.accept_same_image(&original, &CancellationToken::new()),
        )
        .await?
        .err()
        .context("different image cannot become an accepted peer")?;
        assert!(error.chain().any(|c| matches!(
            c.to_string().as_str(),
            "SERVICE_WINDOWS_PIPE_PEER_IMAGE_DENIED" | "SERVICE_WINDOWS_IMAGE_UNSAFE"
        )));
        drop(listener);
        let exit = tokio::task::spawn_blocking(move || child.0.wait()).await??;
        ensure!(exit.success(), "owned child cleanup");
        Ok(())
    })
}

#[test]
#[ignore = "requires an owned Windows token-creation privilege fixture"]
fn peer_source_negative_new_low_integrity_primary_process_is_denied() -> Result<()> {
    use std::os::windows::{
        ffi::OsStrExt,
        io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree},
        Security::{
            Authorization::ConvertStringSidToSidW, CreateRestrictedToken, DISABLE_MAX_PRIVILEGE,
            GetLengthSid, SID_AND_ATTRIBUTES, SetTokenInformation, TOKEN_ADJUST_DEFAULT,
            TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
            TokenIntegrityLevel,
        },
        System::Threading::{
            CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessWithTokenW, GetCurrentProcess,
            OpenProcessToken, PROCESS_INFORMATION, STARTUPINFOW, TerminateProcess,
            WaitForSingleObject,
        },
    };
    // SE_GROUP_INTEGRITY from winnt.h; keep this test independent of SystemServices.
    const SE_GROUP_INTEGRITY: u32 = 0x20;
    let account = CurrentWindowsPeerAccount::capture()?;
    let mut original = std::ptr::null_mut();
    ensure!(
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
                &mut original,
            )
        } != 0,
        "owned token query"
    );
    let original = unsafe { OwnedHandle::from_raw_handle(original.cast()) };
    let mut restricted = std::ptr::null_mut();
    ensure!(
        unsafe {
            CreateRestrictedToken(
                original.as_raw_handle().cast(),
                DISABLE_MAX_PRIVILEGE,
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                &mut restricted,
            )
        } != 0,
        "owned restricted token"
    );
    let restricted = unsafe { OwnedHandle::from_raw_handle(restricted.cast()) };
    let low: Vec<u16> = "S-1-16-4096\0".encode_utf16().collect();
    let mut sid = std::ptr::null_mut();
    ensure!(
        unsafe { ConvertStringSidToSidW(low.as_ptr(), &mut sid) } != 0,
        "owned integrity SID"
    );
    let sid_len = unsafe { GetLengthSid(sid) } as usize;
    let total = std::mem::size_of::<TOKEN_MANDATORY_LABEL>() + sid_len;
    let mut storage = vec![0usize; total.div_ceil(std::mem::size_of::<usize>())];
    let base = storage.as_mut_ptr().cast::<u8>();
    unsafe {
        std::ptr::copy_nonoverlapping(
            sid.cast::<u8>(),
            base.add(std::mem::size_of::<TOKEN_MANDATORY_LABEL>()),
            sid_len,
        );
        LocalFree(sid);
    }
    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: unsafe { base.add(std::mem::size_of::<TOKEN_MANDATORY_LABEL>()) }.cast(),
            Attributes: SE_GROUP_INTEGRITY,
        },
    };
    unsafe {
        base.cast::<TOKEN_MANDATORY_LABEL>().write(label);
    }
    ensure!(
        unsafe {
            SetTokenInformation(
                restricted.as_raw_handle().cast(),
                TokenIntegrityLevel,
                base.cast(),
                total as u32,
            )
        } != 0,
        "owned integrity lowering"
    );
    let program = std::env::current_exe()?;
    let mut command: Vec<u16> = program.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of_val(&startup) as u32;
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    ensure!(
        unsafe {
            CreateProcessWithTokenW(
                restricted.as_raw_handle().cast(),
                0,
                std::ptr::null(),
                command.as_mut_ptr(),
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                std::ptr::null(),
                std::ptr::null(),
                &startup,
                &mut info,
            )
        } != 0,
        "owned suspended process creation: win32={:?}",
        std::io::Error::last_os_error().raw_os_error()
    );
    unsafe { CloseHandle(info.hThread) };
    struct Suspended(OwnedHandle);
    impl Drop for Suspended {
        fn drop(&mut self) {
            unsafe {
                TerminateProcess(self.0.as_raw_handle().cast(), 0);
                WaitForSingleObject(self.0.as_raw_handle().cast(), 5000);
            }
        }
    }
    let process = Suspended(unsafe { OwnedHandle::from_raw_handle(info.hProcess.cast()) });
    assert!(account.capture_process(process.0.as_handle()).is_err());
    drop(process);
    account.verify()?;
    Ok(())
}
