//! Stable Node-API 8 functions resolved from the running host, without a host DLL search.
use anyhow::{Result, ensure};
use std::ffi::{CStr, c_char, c_void};

pub(super) type Env = *mut c_void;
pub(super) type Value = *mut c_void;
pub(super) type Info = *mut c_void;
pub(super) type Callback = unsafe extern "C" fn(Env, Info) -> Value;
type Finalizer = unsafe extern "C" fn(Env, *mut c_void, *mut c_void);
type Status = i32;

#[repr(C)]
pub(super) struct TypeTag {
    lower: u64,
    upper: u64,
}

static MODULE_BRAND: u8 = 0;

pub(super) fn lease_tag() -> TypeTag {
    // A second loaded copy must not reinterpret this image's private Rust Box
    // layout. The hidden static's address brands this image without a registry.
    TypeTag {
        lower: 0x8ecbce1844fb4982,
        upper: 0xa12474b8e091d632 ^ (&MODULE_BRAND as *const u8 as usize as u64),
    }
}

#[derive(Debug)]
pub(super) enum Fault {
    Argument,
    Handle,
    Closed,
    Changed,
}

impl Fault {
    pub(super) fn code(&self) -> &'static CStr {
        match self {
            Self::Argument => c"NATIVE_STORAGE_ARGUMENT_INVALID",
            Self::Handle => c"NATIVE_STORAGE_HANDLE_INVALID",
            Self::Closed => c"NATIVE_STORAGE_LEASE_CLOSED",
            Self::Changed => c"NATIVE_STORAGE_BINDING_CHANGED",
        }
    }
}
impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code().to_string_lossy())
    }
}
impl std::error::Error for Fault {}

pub(super) struct Api {
    pub(super) get_cb_info: unsafe extern "C" fn(
        Env,
        Info,
        *mut usize,
        *mut Value,
        *mut Value,
        *mut *mut c_void,
    ) -> Status,
    pub(super) get_value_string_utf16:
        unsafe extern "C" fn(Env, Value, *mut u16, usize, *mut usize) -> Status,
    pub(super) get_value_bool: unsafe extern "C" fn(Env, Value, *mut bool) -> Status,
    pub(super) create_function: unsafe extern "C" fn(
        Env,
        *const c_char,
        usize,
        Option<Callback>,
        *mut c_void,
        *mut Value,
    ) -> Status,
    pub(super) set_named_property: unsafe extern "C" fn(Env, Value, *const c_char, Value) -> Status,
    pub(super) create_object: unsafe extern "C" fn(Env, *mut Value) -> Status,
    pub(super) wrap: unsafe extern "C" fn(
        Env,
        Value,
        *mut c_void,
        Option<Finalizer>,
        *mut c_void,
        *mut *mut c_void,
    ) -> Status,
    pub(super) unwrap: unsafe extern "C" fn(Env, Value, *mut *mut c_void) -> Status,
    pub(super) type_of: unsafe extern "C" fn(Env, Value, *mut i32) -> Status,
    pub(super) type_tag_object: unsafe extern "C" fn(Env, Value, *const TypeTag) -> Status,
    pub(super) check_object_type_tag:
        unsafe extern "C" fn(Env, Value, *const TypeTag, *mut bool) -> Status,
    pub(super) get_boolean: unsafe extern "C" fn(Env, bool, *mut Value) -> Status,
    pub(super) get_null: unsafe extern "C" fn(Env, *mut Value) -> Status,
    pub(super) get_undefined: unsafe extern "C" fn(Env, *mut Value) -> Status,
    pub(super) create_uint32: unsafe extern "C" fn(Env, u32, *mut Value) -> Status,
    pub(super) create_string_utf8:
        unsafe extern "C" fn(Env, *const c_char, usize, *mut Value) -> Status,
    pub(super) throw_error: unsafe extern "C" fn(Env, *const c_char, *const c_char) -> Status,
}

impl Api {
    pub(super) fn load() -> Result<Self> {
        // SAFETY: each function pointer has the exact stable Node-API signature.
        // Resolution uses only the already running host's symbol scope.
        Ok(unsafe {
            Self {
                get_cb_info: symbol(c"napi_get_cb_info")?,
                get_value_string_utf16: symbol(c"napi_get_value_string_utf16")?,
                get_value_bool: symbol(c"napi_get_value_bool")?,
                create_function: symbol(c"napi_create_function")?,
                set_named_property: symbol(c"napi_set_named_property")?,
                create_object: symbol(c"napi_create_object")?,
                wrap: symbol(c"napi_wrap")?,
                unwrap: symbol(c"napi_unwrap")?,
                type_of: symbol(c"napi_typeof")?,
                type_tag_object: symbol(c"napi_type_tag_object")?,
                check_object_type_tag: symbol(c"napi_check_object_type_tag")?,
                get_boolean: symbol(c"napi_get_boolean")?,
                get_null: symbol(c"napi_get_null")?,
                get_undefined: symbol(c"napi_get_undefined")?,
                create_uint32: symbol(c"napi_create_uint32")?,
                create_string_utf8: symbol(c"napi_create_string_utf8")?,
                throw_error: symbol(c"napi_throw_error")?,
            }
        })
    }

    pub(super) fn check(&self, status: Status) -> Result<()> {
        ensure!(status == 0, Fault::Argument);
        Ok(())
    }

    pub(super) fn arguments(&self, env: Env, info: Info, expected: usize) -> Result<Vec<Value>> {
        let mut values = [std::ptr::null_mut(); 4];
        let mut count = values.len();
        // SAFETY: outputs have the declared capacity; env/info belong to this callback.
        self.check(unsafe {
            (self.get_cb_info)(
                env,
                info,
                &mut count,
                values.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        })?;
        ensure!(
            count == expected && expected <= values.len(),
            Fault::Argument
        );
        Ok(values[..expected].to_vec())
    }

    pub(super) fn string(&self, env: Env, value: Value, maximum: usize) -> Result<String> {
        let mut length = 0;
        // SAFETY: Node validates the string value and reports its UTF-16 length.
        self.check(unsafe {
            (self.get_value_string_utf16)(env, value, std::ptr::null_mut(), 0, &mut length)
        })?;
        ensure!(length > 0 && length <= maximum, Fault::Argument);
        let mut buffer = vec![0u16; length + 1];
        let mut copied = 0;
        // SAFETY: the owned allocation includes the required terminating null slot.
        self.check(unsafe {
            (self.get_value_string_utf16)(
                env,
                value,
                buffer.as_mut_ptr(),
                buffer.len(),
                &mut copied,
            )
        })?;
        ensure!(
            copied == length && !buffer[..length].contains(&0),
            Fault::Argument
        );
        String::from_utf16(&buffer[..length]).map_err(|_| Fault::Argument.into())
    }

    pub(super) fn bool_argument(&self, env: Env, value: Value) -> Result<bool> {
        let mut result = false;
        // SAFETY: the API checks the argument type and writes to this valid bool.
        self.check(unsafe { (self.get_value_bool)(env, value, &mut result) })?;
        Ok(result)
    }

    pub(super) fn boolean(&self, env: Env, value: bool) -> Result<Value> {
        let mut result = std::ptr::null_mut();
        // SAFETY: the output pointer belongs to this callback's live environment.
        self.check(unsafe { (self.get_boolean)(env, value, &mut result) })?;
        Ok(result)
    }

    pub(super) fn output_string(&self, env: Env, value: &str) -> Result<Value> {
        let mut result = std::ptr::null_mut();
        // SAFETY: the UTF-8 allocation remains alive through this synchronous copy.
        self.check(unsafe {
            (self.create_string_utf8)(env, value.as_ptr().cast(), value.len(), &mut result)
        })?;
        Ok(result)
    }
}

unsafe fn symbol<T: Copy>(name: &'static CStr) -> Result<T> {
    #[cfg(windows)]
    let pointer = {
        use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
        // SAFETY: null selects this process's actual executable, not a searched DLL.
        let module = unsafe { GetModuleHandleW(std::ptr::null()) };
        ensure!(!module.is_null(), "native storage host unavailable");
        // SAFETY: the static name is nul terminated and module is the live host image.
        unsafe { GetProcAddress(module, name.as_ptr().cast()) }
            .ok_or_else(|| anyhow::anyhow!("native storage host symbol unavailable"))?
            as *const c_void
    };
    #[cfg(unix)]
    // SAFETY: RTLD_DEFAULT searches the existing process scope without loading any library.
    let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) }.cast_const();
    #[cfg(not(any(unix, windows)))]
    anyhow::bail!("native storage host unsupported");
    #[cfg(any(unix, windows))]
    {
        ensure!(
            !pointer.is_null() && size_of::<T>() == size_of_val(&pointer),
            "native storage host symbol unavailable"
        );
        // SAFETY: the caller supplies the exact stable C ABI type for this named symbol.
        Ok(unsafe { std::mem::transmute_copy(&pointer) })
    }
}
