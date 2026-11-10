// Windows executes PAC in its own service. Each URL owns one cancellable
// resolver; no application JS engine, Shell, or blocking worker is involved.
use super::{cancelled, system_proxy::AutomaticProxy};
use kcoder_tool_error::ToolError;
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::sync::oneshot;
use url::Url;
use windows_sys::Win32::{
    Foundation::{ERROR_INVALID_DATA, ERROR_IO_PENDING, ERROR_NOT_SUPPORTED, ERROR_SUCCESS},
    Networking::WinHttp::*,
};

const DEADLINE: Duration = Duration::from_secs(20);
const CALLBACK_FLAGS: u32 = WINHTTP_CALLBACK_FLAG_GETPROXYFORURL_COMPLETE
    | WINHTTP_CALLBACK_FLAG_REQUEST_ERROR
    | WINHTTP_CALLBACK_STATUS_HANDLE_CREATED
    | WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING;

struct Handle(usize);
impl Drop for Handle {
    fn drop(&mut self) {
        if self.0 != 0 {
            // SAFETY: this guard exclusively owns this live WinHTTP handle.
            // Closing a resolver cancels it; late callbacks use the registry.
            unsafe {
                WinHttpCloseHandle(self.0 as *mut c_void);
            }
        }
    }
}

struct NativeInputs {
    url: Vec<u16>,
    _pac: Vec<u16>,
    options: Box<WINHTTP_AUTOPROXY_OPTIONS>,
}
// SAFETY: the native pointers refer only to this object's immutable owned heap
// buffers, which never move or change and are retained until HANDLE_CLOSING.
// WinHTTP only reads them. No raw SDK pointer leaves this module.
unsafe impl Send for NativeInputs {}
unsafe impl Sync for NativeInputs {}
impl NativeInputs {
    fn new(url: &Url, pac: Option<&str>) -> Self {
        let pac = pac.map(wide).unwrap_or_default();
        let options = Box::new(WINHTTP_AUTOPROXY_OPTIONS {
            // Only the host-to-proxy result cache is bypassed. A PAC may route
            // two paths on the same host differently; keep system script cache.
            dwFlags: (if pac.is_empty() {
                WINHTTP_AUTOPROXY_AUTO_DETECT
            } else {
                WINHTTP_AUTOPROXY_CONFIG_URL
            }) | WINHTTP_AUTOPROXY_NO_CACHE_CLIENT
                | WINHTTP_AUTOPROXY_NO_CACHE_SVC,
            dwAutoDetectFlags: if pac.is_empty() {
                WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A
            } else {
                0
            },
            lpszAutoConfigUrl: if pac.is_empty() {
                std::ptr::null()
            } else {
                pac.as_ptr()
            },
            // Host credentials are never read or implicitly sent to PAC hosts.
            fAutoLogonIfChallenged: 0,
            ..WINHTTP_AUTOPROXY_OPTIONS::default()
        });
        Self {
            url: wide(url.as_str()),
            _pac: pac,
            options,
        }
    }
}

struct CallbackState {
    inputs: NativeInputs,
    handle: usize,
    sender: Mutex<Option<oneshot::Sender<u32>>>,
}
fn registry() -> &'static Mutex<HashMap<usize, Arc<CallbackState>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<usize, Arc<CallbackState>>>> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default)
}

unsafe extern "system" fn status_callback(
    handle: *mut c_void,
    context: usize,
    status: u32,
    information: *mut c_void,
    length: u32,
) {
    if context == 0 {
        return;
    }
    // Context is an opaque integer, never a pointer to application memory. A
    // concurrent or late callback therefore cannot dereference freed state.
    let state = {
        let mut entries = registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if entries
            .get(&context)
            .is_none_or(|state| state.handle != handle as usize)
        {
            return;
        }
        if status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING {
            entries.remove(&context)
        } else {
            entries.get(&context).cloned()
        }
    };
    let Some(state) = state else {
        return;
    };
    let result = match status {
        WINHTTP_CALLBACK_STATUS_GETPROXYFORURL_COMPLETE => ERROR_SUCCESS,
        WINHTTP_CALLBACK_STATUS_REQUEST_ERROR
            if !information.is_null()
                && length as usize >= std::mem::size_of::<WINHTTP_ASYNC_RESULT>() =>
        {
            // SAFETY: WinHTTP supplies the advertised callback buffer; copy it
            // during this callback and never retain the borrowed pointer.
            unsafe {
                information
                    .cast::<WINHTTP_ASYNC_RESULT>()
                    .read_unaligned()
                    .dwError
            }
        }
        WINHTTP_CALLBACK_STATUS_REQUEST_ERROR => ERROR_INVALID_DATA,
        WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING => ERROR_WINHTTP_OPERATION_CANCELLED,
        _ => return,
    };
    if let Some(sender) = state
        .sender
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
    {
        let _ = sender.send(result);
    }
}

struct Operation {
    // Explicit drop order: cancel resolver first, then release its session.
    resolver: Handle,
    _session: Handle,
    receiver: oneshot::Receiver<u32>,
}
impl Operation {
    fn start(url: &Url, pac: Option<&str>) -> Result<Self, u32> {
        let agent = wide("KCoder automatic proxy");
        // SAFETY: all pointers refer to valid NUL-terminated UTF16 buffers.
        let session = Handle(unsafe {
            WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_NO_PROXY,
                std::ptr::null(),
                std::ptr::null(),
                WINHTTP_FLAG_ASYNC,
            )
        } as usize);
        if session.0 == 0 {
            return Err(last_error());
        }
        // Set the callback before creating the resolver, as required by the API.
        let previous = unsafe {
            WinHttpSetStatusCallback(
                session.0 as *mut c_void,
                Some(status_callback),
                CALLBACK_FLAGS,
                0,
            )
        };
        if previous.is_some_and(|callback| callback as usize == usize::MAX) {
            return Err(last_error());
        }
        // Native deadlines complement the owner-bound async overall deadline.
        if unsafe { WinHttpSetTimeouts(session.0 as *mut c_void, 10000, 10000, 10000, 10000) } == 0
        {
            return Err(last_error());
        }
        let mut handle = std::ptr::null_mut();
        let code = unsafe { WinHttpCreateProxyResolver(session.0 as *const c_void, &mut handle) };
        if code != ERROR_SUCCESS {
            return Err(code);
        }
        let resolver = Handle(handle as usize);
        static NEXT: AtomicUsize = AtomicUsize::new(1);
        let context = NEXT
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| ERROR_INVALID_DATA)?;
        let (sender, receiver) = oneshot::channel();
        let state = Arc::new(CallbackState {
            inputs: NativeInputs::new(url, pac),
            handle: resolver.0,
            sender: Mutex::new(Some(sender)),
        });
        registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(context, state.clone());
        // Bind context to the handle itself so HANDLE_CLOSING keeps its token
        // even if the asynchronous GetProxyForUrlEx call fails synchronously.
        if unsafe {
            WinHttpSetOption(
                handle,
                WINHTTP_OPTION_CONTEXT_VALUE,
                (&context as *const usize).cast(),
                std::mem::size_of::<usize>() as u32,
            )
        } == 0
        {
            let error = last_error();
            registry()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&context);
            return Err(error);
        }
        let operation = Self {
            resolver,
            _session: session,
            receiver,
        };
        let code = unsafe {
            WinHttpGetProxyForUrlEx(
                handle,
                state.inputs.url.as_ptr(),
                state.inputs.options.as_ref(),
                context,
            )
        };
        if code != ERROR_IO_PENDING {
            return Err(if code == ERROR_SUCCESS {
                ERROR_INVALID_DATA
            } else {
                code
            });
        }
        Ok(operation)
    }

    fn result(&self) -> Result<Option<Url>, u32> {
        struct ResultGuard(WINHTTP_PROXY_RESULT);
        impl Drop for ResultGuard {
            fn drop(&mut self) {
                // SAFETY: this result is initialized and freed exactly once.
                unsafe {
                    WinHttpFreeProxyResult(&mut self.0);
                }
            }
        }
        let mut result = ResultGuard(WINHTTP_PROXY_RESULT::default());
        // The callback never touches a handle. Only this live owner calls the
        // API, with no await between reading the result and dropping the owner.
        let code =
            unsafe { WinHttpGetProxyResult(self.resolver.0 as *const c_void, &mut result.0) };
        if code != ERROR_SUCCESS {
            return Err(code);
        }
        if result.0.cEntries == 0 || result.0.cEntries > 256 || result.0.pEntries.is_null() {
            return Err(ERROR_INVALID_DATA);
        }
        // Preserve the system's first choice. Never skip an unsupported or
        // failed proxy in order to invent a DIRECT fallback or replay a POST.
        let first = unsafe { *result.0.pEntries };
        if first.fProxy == 0 {
            return Ok(None);
        }
        let host = unsafe { read_wide(first.pwszProxy) }?.ok_or(ERROR_INVALID_DATA)?;
        proxy_url(first.ProxyScheme, &host, first.ProxyPort).map(Some)
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn last_error() -> u32 {
    // SAFETY: callers invoke this immediately after a failed Win32 API.
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}

/// Read only a Windows-owned, valid NUL-terminated UTF16 allocation.
pub(super) unsafe fn read_wide(pointer: *const u16) -> Result<Option<String>, u32> {
    if pointer.is_null() {
        return Ok(None);
    }
    let mut units = Vec::new();
    for index in 0..8192 {
        // SAFETY: caller supplies a valid terminated Windows allocation; the
        // bounded loop stops before reading past its terminating NUL.
        let unit = unsafe { *pointer.add(index) };
        if unit == 0 {
            let value = String::from_utf16(&units).map_err(|_| ERROR_INVALID_DATA)?;
            if value.chars().any(char::is_control) {
                return Err(ERROR_INVALID_DATA);
            }
            return Ok((!value.is_empty()).then_some(value));
        }
        units.push(unit);
    }
    Err(ERROR_INVALID_DATA)
}

fn proxy_url(scheme: i32, host: &str, port: u16) -> Result<Url, u32> {
    let scheme = match scheme {
        WINHTTP_INTERNET_SCHEME_HTTP => "http",
        WINHTTP_INTERNET_SCHEME_SOCKS => "socks4",
        _ => return Err(ERROR_NOT_SUPPORTED),
    };
    if port == 0
        || host.is_empty()
        || host
            .chars()
            .any(|value| value.is_control() || matches!(value, '/' | '\\' | '@' | '?' | '#'))
    {
        return Err(ERROR_INVALID_DATA);
    }
    let host = match host.parse::<std::net::Ipv6Addr>() {
        Ok(ip) => format!("[{ip}]"),
        Err(_) => host.to_owned(),
    };
    let parsed =
        Url::parse(&format!("{scheme}://{host}:{port}")).map_err(|_| ERROR_INVALID_DATA)?;
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ERROR_INVALID_DATA);
    }
    Ok(parsed)
}

#[derive(Debug)]
enum ResolutionError {
    Native(u32),
    Host(ToolError),
}
impl ResolutionError {
    fn into_tool(self) -> ToolError {
        match self {
            Self::Native(code) => failed(code),
            Self::Host(error) => error,
        }
    }
}

async fn once(
    url: &Url,
    pac: Option<&str>,
    cancel: &tokio_util::sync::CancellationToken,
    check: &(dyn Fn() -> Result<(), ToolError> + Send + Sync),
    deadline: tokio::time::Instant,
) -> Result<Option<Url>, ResolutionError> {
    check().map_err(ResolutionError::Host)?;
    let mut operation = Operation::start(url, pac).map_err(ResolutionError::Native)?;
    let mut revocation = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! { biased;
            _ = cancel.cancelled() => return Err(ResolutionError::Host(cancelled())),
            _ = tokio::time::sleep_until(deadline) => return Err(ResolutionError::Native(ERROR_WINHTTP_TIMEOUT)),
            completed = &mut operation.receiver => {
                let code = completed.map_err(|_| ResolutionError::Native(ERROR_WINHTTP_OPERATION_CANCELLED))?;
                check().map_err(ResolutionError::Host)?;
                return if code == ERROR_SUCCESS { operation.result().map_err(ResolutionError::Native) } else { Err(ResolutionError::Native(code)) };
            }
            _ = revocation.tick() => check().map_err(ResolutionError::Host)?,
        }
    }
}

fn failed(code: u32) -> ToolError {
    ToolError::Execution(format!(
        "The target Windows automatic proxy resolution failed (WinHTTP {code}); no destination request was sent"
    ))
}

pub(super) async fn resolve(
    config: &AutomaticProxy,
    url: &Url,
    cancel: &tokio_util::sync::CancellationToken,
    check: &(dyn Fn() -> Result<(), ToolError> + Send + Sync),
) -> Result<Option<Url>, ToolError> {
    let deadline = tokio::time::Instant::now() + DEADLINE;
    if config.auto_detect {
        // Only absence of a discovered PAC permits the next configured method.
        // Explicit PAC download/parse/authentication errors never become DIRECT.
        match once(url, None, cancel, check, deadline).await {
            Ok(choice) => return Ok(choice),
            Err(ResolutionError::Native(ERROR_WINHTTP_AUTODETECTION_FAILED)) => {}
            Err(error) => return Err(error.into_tool()),
        }
    }
    if let Some(pac) = &config.config_url {
        return once(url, Some(pac), cancel, check, deadline)
            .await
            .map_err(ResolutionError::into_tool);
    }
    check()?;
    config.fallback(url)
}
