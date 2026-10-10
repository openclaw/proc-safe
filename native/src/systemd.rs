//! sd-bus objects never leave their owner thread. Only owned data crosses N-API.
use crate::error::failure;
use napi::bindgen_prelude::{AsyncTask, BigInt, ToNapiValue, TypeName};
use napi::{Env, Result, Task, ValueType, sys};
use napi_derive::napi;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::ptr;
use std::sync::{
    OnceLock,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

type Bus = c_void;
type Message = c_void;
type Creds = c_void;
#[repr(C)]
struct BusError {
    name: *const c_char,
    message: *const c_char,
    need_free: c_int,
}
type MachineOpen = unsafe extern "C" fn(*mut *mut Bus, *const c_char) -> c_int;

macro_rules! api {
    ($($field:ident: $ty:ty => $symbol:literal),* $(,)?) => {
        struct Api { _library: usize, machine: Option<MachineOpen>, $($field: $ty,)* }
        impl Api {
            fn load() -> std::result::Result<Self, String> {
                // Keep the validated library loaded for the lifetime of all function pointers.
                let handle = unsafe { libc::dlopen(c"libsystemd.so.0".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
                if handle.is_null() { return Err("libsystemd.so.0 is unavailable".into()); }
                let result = (|| {
                    Ok(Self {
                        _library: handle as usize,
                        machine: {
                            let p = unsafe { libc::dlsym(handle, c"sd_bus_open_user_machine".as_ptr()) };
                            if p.is_null() { None } else { Some(unsafe { std::mem::transmute::<*mut c_void, MachineOpen>(p) }) }
                        },
                        $($field: {
                            let p = unsafe { libc::dlsym(handle, concat!($symbol, "\0").as_ptr().cast()) };
                            if p.is_null() { return Err(concat!("missing libsystemd symbol: ", $symbol).into()); }
                            unsafe { std::mem::transmute::<*mut c_void, $ty>(p) }
                        },)*
                    })
                })();
                if result.is_err() { unsafe { libc::dlclose(handle); } }
                result
            }
        }
    }
}
api! {
    new_bus: unsafe extern "C" fn(*mut *mut Bus) -> c_int => "sd_bus_new",
    address: unsafe extern "C" fn(*mut Bus, *const c_char) -> c_int => "sd_bus_set_address",
    client: unsafe extern "C" fn(*mut Bus, c_int) -> c_int => "sd_bus_set_bus_client",
    start: unsafe extern "C" fn(*mut Bus) -> c_int => "sd_bus_start",
    ready: unsafe extern "C" fn(*mut Bus) -> c_int => "sd_bus_is_ready",
    process: unsafe extern "C" fn(*mut Bus, *mut *mut Message) -> c_int => "sd_bus_process",
    wait: unsafe extern "C" fn(*mut Bus, u64) -> c_int => "sd_bus_wait",
    timeout: unsafe extern "C" fn(*mut Bus, u64) -> c_int => "sd_bus_set_method_call_timeout",
    creds: unsafe extern "C" fn(*mut Bus, u64, *mut *mut Creds) -> c_int => "sd_bus_get_owner_creds",
    pid: unsafe extern "C" fn(*mut Creds, *mut libc::pid_t) -> c_int => "sd_bus_creds_get_pid",
    uid: unsafe extern "C" fn(*mut Creds, *mut libc::uid_t) -> c_int => "sd_bus_creds_get_euid",
    creds_unref: unsafe extern "C" fn(*mut Creds) -> *mut Creds => "sd_bus_creds_unref",
    new_call: unsafe extern "C" fn(*mut Bus, *mut *mut Message, *const c_char, *const c_char, *const c_char, *const c_char) -> c_int => "sd_bus_message_new_method_call",
    append: unsafe extern "C" fn(*mut Message, c_char, *const c_void) -> c_int => "sd_bus_message_append_basic",
    auto_start: unsafe extern "C" fn(*mut Message, c_int) -> c_int => "sd_bus_message_set_auto_start",
    call: unsafe extern "C" fn(*mut Bus, *mut Message, u64, *mut BusError, *mut *mut Message) -> c_int => "sd_bus_call",
    basic: unsafe extern "C" fn(*mut Message, c_char, *mut c_void) -> c_int => "sd_bus_message_read_basic",
    enter: unsafe extern "C" fn(*mut Message, c_char, *const c_char) -> c_int => "sd_bus_message_enter_container",
    exit: unsafe extern "C" fn(*mut Message) -> c_int => "sd_bus_message_exit_container",
    end: unsafe extern "C" fn(*mut Message, c_int) -> c_int => "sd_bus_message_at_end",
    signature: unsafe extern "C" fn(*mut Message, c_int) -> *const c_char => "sd_bus_message_get_signature",
    message_unref: unsafe extern "C" fn(*mut Message) -> *mut Message => "sd_bus_message_unref",
    error_free: unsafe extern "C" fn(*mut BusError) -> *mut BusError => "sd_bus_error_free",
    close: unsafe extern "C" fn(*mut Bus) -> *mut Bus => "sd_bus_close_unref",
}
static API: OnceLock<std::result::Result<Api, String>> = OnceLock::new();
fn api() -> Result<&'static Api> {
    API.get_or_init(Api::load)
        .as_ref()
        .map_err(|s| failure("helper-unavailable", s))
}
#[napi]
pub fn systemd_supported() -> bool {
    api().is_ok()
}
fn checked(rc: c_int) -> Result<c_int> {
    if rc >= 0 {
        return Ok(rc);
    }
    let errno = rc.saturating_neg();
    let code = match errno {
        libc::EACCES | libc::EPERM => "access-denied",
        libc::ETIMEDOUT => "timeout",
        libc::EINVAL => "invalid-argument",
        libc::EBADMSG | libc::EPROTO => "layout-mismatch",
        _ => "operation-failed",
    };
    Err(failure(code, std::io::Error::from_raw_os_error(errno)))
}
fn cstring(s: &str) -> Result<CString> {
    CString::new(s).map_err(|_| failure("invalid-argument", "embedded NUL"))
}
#[derive(Clone, Copy)]
struct Deadline(Instant);
impl Deadline {
    fn new(ms: f64) -> Result<Self> {
        let duration = Duration::try_from_secs_f64(ms / 1000.0)
            .map_err(|_| failure("invalid-argument", "invalid timeoutMs"))?;
        if duration.is_zero() {
            return Err(failure("invalid-argument", "timeoutMs must be positive"));
        }
        Instant::now()
            .checked_add(duration)
            .map(Self)
            .ok_or_else(|| failure("invalid-argument", "timeoutMs is too large"))
    }
    fn remaining(self) -> Result<Duration> {
        self.0
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| failure("timeout", "systemd deadline exceeded"))
    }
    fn micros(self) -> Result<u64> {
        Ok(self
            .remaining()?
            .as_micros()
            .min(u64::MAX as u128 - 1)
            .max(1) as u64)
    }
}

pub enum Value {
    Text(String),
    U32(u32),
    I32(i32),
    U64(u64),
    Bool(bool),
    Array(Vec<Value>),
    Unit,
}
impl TypeName for Value {
    fn type_name() -> &'static str {
        "SystemdValue"
    }
    fn value_type() -> ValueType {
        ValueType::Unknown
    }
}
impl ToNapiValue for Value {
    unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        // Every branch uses napi-rs' owned conversion; no sd-bus memory reaches JS.
        unsafe {
            match value {
                Value::Text(v) => String::to_napi_value(env, v),
                Value::U32(v) => u32::to_napi_value(env, v),
                Value::I32(v) => i32::to_napi_value(env, v),
                Value::U64(v) => BigInt::to_napi_value(env, v.into()),
                Value::Bool(v) => bool::to_napi_value(env, v),
                Value::Array(v) => Vec::<Value>::to_napi_value(env, v),
                Value::Unit => <()>::to_napi_value(env, ()),
            }
        }
    }
}
#[napi(object)]
pub struct Argument {
    pub r#type: String,
    pub value: String,
}
struct Target {
    destination: Option<CString>,
    path: CString,
    interface: CString,
    member: CString,
}
impl Target {
    fn new(
        destination: Option<String>,
        path: String,
        interface: String,
        member: String,
    ) -> Result<Self> {
        Ok(Self {
            destination: destination.map(|s| cstring(&s)).transpose()?,
            path: cstring(&path)?,
            interface: cstring(&interface)?,
            member: cstring(&member)?,
        })
    }
}
enum Operation {
    Property(Target, String),
    Call(Target, Vec<Argument>),
    Close,
}
struct Request {
    operation: Operation,
    deadline: Option<Deadline>,
    budget: usize,
    reply: mpsc::Sender<Result<Value>>,
}

pub struct ReceiveTask {
    reply: mpsc::Receiver<Result<Value>>,
    deadline: Option<Deadline>,
}
impl Task for ReceiveTask {
    type Output = Value;
    type JsValue = Value;
    fn compute(&mut self) -> Result<Value> {
        // A completed native operation remains successful if libuv delivers it later.
        if let Ok(result) = self.reply.try_recv() {
            return result;
        }
        match self.deadline {
            Some(d) => self
                .reply
                .recv_timeout(d.remaining()?)
                .map_err(|e| match e {
                    mpsc::RecvTimeoutError::Timeout => {
                        failure("timeout", "systemd deadline exceeded")
                    }
                    _ => failure("operation-failed", "systemd owner thread exited"),
                })?,
            None => self
                .reply
                .recv()
                .map_err(|_| failure("operation-failed", "systemd owner thread exited"))?,
        }
    }
    fn resolve(&mut self, _: Env, output: Value) -> Result<Value> {
        Ok(output)
    }
}
pub struct ConnectTask {
    ready: mpsc::Receiver<Result<Option<(u32, u32)>>>,
    sender: Option<mpsc::Sender<Request>>,
    deadline: Deadline,
}
impl Task for ConnectTask {
    type Output = NativeSystemdBus;
    type JsValue = NativeSystemdBus;
    fn compute(&mut self) -> Result<NativeSystemdBus> {
        let ready = match self.ready.try_recv() {
            Ok(result) => Ok(result),
            Err(_) => self.ready.recv_timeout(self.deadline.remaining()?),
        };
        let peer = ready.map_err(|e| match e {
            mpsc::RecvTimeoutError::Timeout => {
                failure("timeout", "systemd connection deadline exceeded")
            }
            _ => failure("operation-failed", "systemd owner thread exited"),
        })??;
        Ok(NativeSystemdBus {
            sender: self
                .sender
                .take()
                .ok_or_else(|| failure("operation-failed", "connection already resolved"))?,
            peer,
            closed: AtomicBool::new(false),
        })
    }
    fn resolve(&mut self, _: Env, output: NativeSystemdBus) -> Result<NativeSystemdBus> {
        Ok(output)
    }
}
#[napi]
pub struct NativeSystemdBus {
    sender: mpsc::Sender<Request>,
    peer: Option<(u32, u32)>,
    closed: AtomicBool,
}
#[napi]
impl NativeSystemdBus {
    #[napi(getter)]
    pub fn peer_pid(&self) -> Option<u32> {
        self.peer.map(|p| p.0)
    }
    #[napi(getter)]
    pub fn peer_uid(&self) -> Option<u32> {
        self.peer.map(|p| p.1)
    }
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn get_property(
        &self,
        destination: Option<String>,
        path: String,
        interface: String,
        member: String,
        signature: String,
        timeout_ms: f64,
        budget: f64,
    ) -> Result<AsyncTask<ReceiveTask>> {
        let deadline = Deadline::new(timeout_ms)?;
        if !valid_signature(&signature) {
            return Err(failure(
                "invalid-argument",
                "unsupported property signature",
            ));
        }
        self.submit(
            Operation::Property(
                Target::new(destination, path, interface, member)?,
                signature,
            ),
            deadline,
            budget,
        )
    }
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn call(
        &self,
        destination: Option<String>,
        path: String,
        interface: String,
        member: String,
        args: Vec<Argument>,
        timeout_ms: f64,
        budget: f64,
    ) -> Result<AsyncTask<ReceiveTask>> {
        let deadline = Deadline::new(timeout_ms)?;
        self.submit(
            Operation::Call(Target::new(destination, path, interface, member)?, args),
            deadline,
            budget,
        )
    }
    #[napi]
    pub fn close(&self) -> Result<AsyncTask<ReceiveTask>> {
        let (reply, receive) = mpsc::channel();
        if self.closed.swap(true, Ordering::AcqRel) {
            let _ = reply.send(Ok(Value::Unit));
        } else {
            self.sender
                .send(Request {
                    operation: Operation::Close,
                    deadline: None,
                    budget: 0,
                    reply,
                })
                .map_err(|_| failure("operation-failed", "systemd owner thread exited"))?;
        }
        Ok(AsyncTask::new(ReceiveTask {
            reply: receive,
            deadline: None,
        }))
    }
}
impl NativeSystemdBus {
    fn submit(
        &self,
        operation: Operation,
        deadline: Deadline,
        budget: f64,
    ) -> Result<AsyncTask<ReceiveTask>> {
        if self.closed.load(Ordering::Acquire) {
            return Err(failure("operation-failed", "systemd connection is closed"));
        }
        if !budget.is_finite()
            || budget < 1.0
            || budget.fract() != 0.0
            || budget > 9_007_199_254_740_991.0
            || budget > usize::MAX as f64
        {
            return Err(failure("invalid-argument", "invalid replyBudgetBytes"));
        }
        let (reply, receive) = mpsc::channel();
        self.sender
            .send(Request {
                operation,
                deadline: Some(deadline),
                budget: budget as usize,
                reply,
            })
            .map_err(|_| failure("operation-failed", "systemd owner thread exited"))?;
        Ok(AsyncTask::new(ReceiveTask {
            reply: receive,
            deadline: Some(deadline),
        }))
    }
}
#[napi]
pub fn connect_systemd(
    mode: String,
    address: String,
    timeout_ms: f64,
) -> Result<AsyncTask<ConnectTask>> {
    let deadline = Deadline::new(timeout_ms)?;
    if !matches!(mode.as_str(), "private" | "user" | "broker" | "machine") {
        return Err(failure("invalid-argument", "invalid connection kind"));
    }
    let address = cstring(&address)?;
    let (sender, requests) = mpsc::channel::<Request>();
    let (ready, receive) = mpsc::channel();
    std::thread::Builder::new()
        .name("proc-safe-systemd".into())
        .spawn(move || {
            let mut owner = match Owner::connect(&mode, &address, deadline) {
                Ok((owner, peer)) => {
                    if ready.send(Ok(peer)).is_err() {
                        return;
                    }
                    owner
                }
                Err(e) => {
                    let _ = ready.send(Err(e));
                    return;
                }
            };
            while let Ok(request) = requests.recv() {
                if matches!(request.operation, Operation::Close) {
                    drop(owner);
                    let _ = request.reply.send(Ok(Value::Unit));
                    return;
                }
                let result = match request.deadline {
                    Some(d) => d
                        .remaining()
                        .and_then(|_| owner.execute(request.operation, d, request.budget)),
                    None => Err(failure("invalid-argument", "missing deadline")),
                };
                let _ = request.reply.send(result);
            }
        })
        .map_err(|e| failure("helper-unavailable", e))?;
    Ok(AsyncTask::new(ConnectTask {
        ready: receive,
        sender: Some(sender),
        deadline,
    }))
}

struct Owner {
    api: &'static Api,
    bus: *mut Bus,
}
impl Drop for Owner {
    fn drop(&mut self) {
        unsafe {
            (self.api.close)(self.bus);
        }
    }
}
struct OwnedMessage {
    api: &'static Api,
    message: *mut Message,
}
impl Drop for OwnedMessage {
    fn drop(&mut self) {
        unsafe {
            (self.api.message_unref)(self.message);
        }
    }
}
struct OwnedError {
    api: &'static Api,
    error: BusError,
}
impl Drop for OwnedError {
    fn drop(&mut self) {
        unsafe {
            (self.api.error_free)(&mut self.error);
        }
    }
}
struct OwnedCreds {
    api: &'static Api,
    creds: *mut Creds,
}
impl Drop for OwnedCreds {
    fn drop(&mut self) {
        unsafe {
            (self.api.creds_unref)(self.creds);
        }
    }
}
impl Owner {
    fn connect(
        mode: &str,
        address: &CStr,
        deadline: Deadline,
    ) -> Result<(Self, Option<(u32, u32)>)> {
        let api = api()?;
        let mut owner = Owner {
            api,
            bus: ptr::null_mut(),
        };
        deadline.remaining()?;
        if mode == "machine" {
            let open = api.machine.ok_or_else(|| {
                failure(
                    "helper-unavailable",
                    "sd_bus_open_user_machine is unavailable",
                )
            })?;
            checked(unsafe { open(&mut owner.bus, address.as_ptr()) })?;
        } else {
            if matches!(mode, "private" | "user") {
                let address = address
                    .to_str()
                    .map_err(|_| failure("invalid-argument", "invalid address"))?;
                // Only a direct Unix transport can make the authenticated destination claim.
                if !address.starts_with("unix:") || address.contains(';') {
                    return Err(failure(
                        "invalid-argument",
                        "authenticated peers require one direct Unix address",
                    ));
                }
            }
            checked(unsafe { (api.new_bus)(&mut owner.bus) })?;
            checked(unsafe { (api.address)(owner.bus, address.as_ptr()) })?;
            checked(unsafe { (api.client)(owner.bus, i32::from(mode == "broker")) })?;
            checked(unsafe { (api.timeout)(owner.bus, deadline.micros()?) })?;
            checked(unsafe { (api.start)(owner.bus) })?;
        }
        while checked(unsafe { (api.ready)(owner.bus) })? == 0 {
            deadline.remaining()?;
            if checked(unsafe { (api.process)(owner.bus, ptr::null_mut()) })? == 0 {
                checked(unsafe { (api.wait)(owner.bus, deadline.micros()?) })?;
            }
        }
        deadline.remaining()?;
        let peer = if matches!(mode, "private" | "user") {
            let mut creds = OwnedCreds {
                api,
                creds: ptr::null_mut(),
            };
            // SD_BUS_CREDS_PID | SD_BUS_CREDS_EUID, without procfs augmentation.
            checked(unsafe { (api.creds)(owner.bus, 17, &mut creds.creds) })?;
            let mut pid = 0;
            let mut uid = u32::MAX;
            checked(unsafe { (api.pid)(creds.creds, &mut pid) })?;
            checked(unsafe { (api.uid)(creds.creds, &mut uid) })?;
            if pid <= 0 || uid == u32::MAX {
                return Err(failure("layout-mismatch", "invalid peer credentials"));
            }
            let expected_uid = unsafe { libc::geteuid() };
            if mode == "user" && uid != expected_uid {
                return Err(failure(
                    "access-denied",
                    format!("peer-uid-mismatch[{expected_uid},{uid}]"),
                ));
            }
            Some((pid as u32, uid))
        } else {
            None
        };
        deadline.remaining()?;
        Ok((owner, peer))
    }
    fn new_call(&self, target: &Target) -> Result<OwnedMessage> {
        let mut message = OwnedMessage {
            api: self.api,
            message: ptr::null_mut(),
        };
        checked(unsafe {
            (self.api.new_call)(
                self.bus,
                &mut message.message,
                target
                    .destination
                    .as_ref()
                    .map_or(ptr::null(), |s| s.as_ptr()),
                target.path.as_ptr(),
                target.interface.as_ptr(),
                target.member.as_ptr(),
            )
        })?;
        checked(unsafe { (self.api.auto_start)(message.message, 0) })?;
        Ok(message)
    }
    fn append(&self, message: &OwnedMessage, arg: &Argument) -> Result<()> {
        let bad = || failure("invalid-argument", "invalid typed systemd argument");
        let rc = unsafe {
            match arg.r#type.as_str() {
                "s" | "o" => (self.api.append)(
                    message.message,
                    arg.r#type.as_bytes()[0] as c_char,
                    cstring(&arg.value)?.as_ptr().cast(),
                ),
                "u" => (self.api.append)(
                    message.message,
                    b'u' as c_char,
                    (&arg.value.parse::<u32>().map_err(|_| bad())? as *const u32).cast(),
                ),
                "i" => (self.api.append)(
                    message.message,
                    b'i' as c_char,
                    (&arg.value.parse::<i32>().map_err(|_| bad())? as *const i32).cast(),
                ),
                "t" => (self.api.append)(
                    message.message,
                    b't' as c_char,
                    (&arg.value.parse::<u64>().map_err(|_| bad())? as *const u64).cast(),
                ),
                "b" => (self.api.append)(
                    message.message,
                    b'b' as c_char,
                    (&i32::from(arg.value.parse::<bool>().map_err(|_| bad())?) as *const i32)
                        .cast(),
                ),
                _ => return Err(bad()),
            }
        };
        checked(rc)?;
        Ok(())
    }
    fn discard_pending(&self, deadline: Deadline) -> Result<()> {
        // sd_bus_call retains unmatched traffic, including replies to timed-out calls.
        loop {
            deadline.remaining()?;
            let mut message = OwnedMessage {
                api: self.api,
                message: ptr::null_mut(),
            };
            if checked(unsafe { (self.api.process)(self.bus, &mut message.message) })? == 0 {
                return Ok(());
            }
        }
    }
    fn execute(&mut self, operation: Operation, deadline: Deadline, bytes: usize) -> Result<Value> {
        self.discard_pending(deadline)?;
        let (target, signature, args) = match operation {
            Operation::Property(at, signature) => {
                let args = vec![
                    Argument {
                        r#type: "s".into(),
                        value: at.interface.to_string_lossy().into_owned(),
                    },
                    Argument {
                        r#type: "s".into(),
                        value: at.member.to_string_lossy().into_owned(),
                    },
                ];
                let target = Target {
                    destination: at.destination,
                    path: at.path,
                    interface: cstring("org.freedesktop.DBus.Properties")?,
                    member: cstring("Get")?,
                };
                (target, Some(signature), args)
            }
            Operation::Call(at, args) => (at, None, args),
            Operation::Close => return Err(failure("operation-failed", "connection closed")),
        };
        let message = self.new_call(&target)?;
        for arg in &args {
            deadline.remaining()?;
            self.append(&message, arg)?;
        }
        let mut reply = OwnedMessage {
            api: self.api,
            message: ptr::null_mut(),
        };
        let mut error = OwnedError {
            api: self.api,
            error: BusError {
                name: ptr::null(),
                message: ptr::null(),
                need_free: 0,
            },
        };
        let rc = unsafe {
            (self.api.call)(
                self.bus,
                message.message,
                deadline.micros()?,
                &mut error.error,
                &mut reply.message,
            )
        };
        deadline.remaining()?;
        if rc < 0 {
            if !error.error.name.is_null() {
                let name = unsafe { CStr::from_ptr(error.error.name) }.to_string_lossy();
                let code = if name.ends_with(".AccessDenied") || name.ends_with(".AuthFailed") {
                    "access-denied"
                } else if name.ends_with(".NoReply") || name.ends_with(".Timeout") {
                    "timeout"
                } else {
                    "operation-failed"
                };
                // Preserve the machine-readable D-Bus error name without echoing remote text.
                return Err(failure(code, format!("dbus-error[{name}]")));
            }
            checked(rc)?;
        }
        if reply.message.is_null() {
            return Err(failure("layout-mismatch", "missing method reply"));
        }
        let mut budget = Budget { bytes, deadline };
        let result = if let Some(signature) = signature {
            let sig = cstring(&signature)?;
            require_one(unsafe { (self.api.enter)(reply.message, b'v' as c_char, sig.as_ptr()) })?;
            let value = self.read(reply.message, &signature, &mut budget)?;
            require_one(unsafe { (self.api.end)(reply.message, 0) })?;
            checked(unsafe { (self.api.exit)(reply.message) })?;
            value
        } else {
            let raw = unsafe { (self.api.signature)(reply.message, 1) };
            if raw.is_null() {
                return Err(failure("layout-mismatch", "missing reply signature"));
            }
            let sig = unsafe { CStr::from_ptr(raw) }
                .to_str()
                .map_err(|_| failure("layout-mismatch", "invalid reply signature"))?;
            if sig.is_empty() {
                Value::Array(vec![])
            } else {
                if !valid_signature(sig) {
                    return Err(failure("layout-mismatch", "unsupported reply signature"));
                }
                Value::Array(vec![self.read(reply.message, sig, &mut budget)?])
            }
        };
        require_one(unsafe { (self.api.end)(reply.message, 1) })?;
        deadline.remaining()?;
        Ok(result)
    }
    fn read(&self, message: *mut Message, signature: &str, budget: &mut Budget) -> Result<Value> {
        budget.take(8)?; // Bounds container count as well as scalar storage, including empty values.
        if let Some(inner) = signature.strip_prefix('a') {
            require_one(unsafe {
                (self.api.enter)(message, b'a' as c_char, cstring(inner)?.as_ptr())
            })?;
            let mut values = Vec::new();
            while checked(unsafe { (self.api.end)(message, 0) })? == 0 {
                values.push(self.read(message, inner, budget)?);
            }
            checked(unsafe { (self.api.exit)(message) })?;
            return Ok(Value::Array(values));
        }
        let fields: &[&str] = match signature {
            "(sb)" => &["s", "b"],
            "(sus)" => &["s", "u", "s"],
            "(sasbttttuii)" => &["s", "as", "b", "t", "t", "t", "t", "u", "i", "i"],
            _ => &[],
        };
        if !fields.is_empty() {
            require_one(unsafe {
                (self.api.enter)(
                    message,
                    b'r' as c_char,
                    cstring(&signature[1..signature.len() - 1])?.as_ptr(),
                )
            })?;
            let values = fields
                .iter()
                .map(|s| self.read(message, s, budget))
                .collect::<Result<Vec<_>>>()?;
            require_one(unsafe { (self.api.end)(message, 0) })?;
            checked(unsafe { (self.api.exit)(message) })?;
            return Ok(Value::Array(values));
        }
        macro_rules! basic {
            ($ty:ty, $kind:expr) => {{
                let mut value: $ty = 0;
                require_one(unsafe {
                    (self.api.basic)(
                        message,
                        signature.as_bytes()[0] as c_char,
                        (&mut value as *mut $ty).cast(),
                    )
                })?;
                $kind(value)
            }};
        }
        Ok(match signature {
            "s" | "o" => {
                let mut value: *const c_char = ptr::null();
                require_one(unsafe {
                    (self.api.basic)(
                        message,
                        signature.as_bytes()[0] as c_char,
                        (&mut value as *mut *const c_char).cast(),
                    )
                })?;
                if value.is_null() {
                    return Err(failure("layout-mismatch", "null string reply"));
                }
                // sd-bus owns the terminated string. Limit scanning and copying to the budget.
                let length = unsafe { libc::strnlen(value, budget.bytes.saturating_add(1)) };
                budget.take(length)?;
                let bytes = unsafe { std::slice::from_raw_parts(value.cast::<u8>(), length) };
                let value = std::str::from_utf8(bytes)
                    .map_err(|_| failure("layout-mismatch", "invalid UTF-8 reply"))?;
                Value::Text(value.into())
            }
            "u" => basic!(u32, Value::U32),
            "i" => basic!(i32, Value::I32),
            "t" => basic!(u64, Value::U64),
            "b" => {
                let value = basic!(i32, Value::I32);
                match value {
                    Value::I32(0) => Value::Bool(false),
                    Value::I32(1) => Value::Bool(true),
                    _ => return Err(failure("layout-mismatch", "invalid boolean reply")),
                }
            }
            _ => return Err(failure("layout-mismatch", "unsupported reply value")),
        })
    }
}
struct Budget {
    bytes: usize,
    deadline: Deadline,
}
impl Budget {
    fn take(&mut self, bytes: usize) -> Result<()> {
        self.deadline.remaining()?;
        self.bytes = self
            .bytes
            .checked_sub(bytes)
            .ok_or_else(|| failure("incomplete", "systemd reply exceeds replyBudgetBytes"))?;
        Ok(())
    }
}
fn require_one(rc: c_int) -> Result<()> {
    if rc != 1 {
        return Err(failure("layout-mismatch", "incomplete or unexpected reply"));
    }
    Ok(())
}
fn valid_signature(signature: &str) -> bool {
    let inner = signature.strip_prefix('a').unwrap_or(signature);
    matches!(
        inner,
        "s" | "o" | "u" | "i" | "t" | "b" | "(sb)" | "(sus)" | "(sasbttttuii)"
    )
}
