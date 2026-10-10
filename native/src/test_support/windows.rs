use crate::error::failure;
use napi::Result;
use napi_derive::napi;
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError},
    System::{
        Console::GetConsoleWindow,
        Threading::{CREATE_NO_WINDOW, CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW},
    },
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            result.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
        } else {
            result.extend(std::iter::repeat_n('\\', slashes));
        }
        slashes = 0;
        result.push(ch);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

fn error(operation: &str, code: u32) -> napi::Error {
    failure(
        if code == ERROR_ACCESS_DENIED {
            "access-denied"
        } else {
            "operation-failed"
        },
        format!("{operation} failed ({code})"),
    )
}

#[napi]
pub fn spawn_detached_raw(
    executable: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<u32> {
    if executable.is_empty()
        || executable.contains('\0')
        || args.iter().any(|a| a.contains('\0'))
        || cwd
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.contains('\0'))
    {
        return Err(failure("invalid-argument", "invalid fixture command"));
    }
    let command = std::iter::once(executable.as_str())
        .chain(args.iter().map(String::as_str))
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ");
    let mut command = wide(&command);
    if command.len() > 32767 {
        return Err(failure("invalid-argument", "fixture command is too long"));
    }
    let executable = wide(&executable);
    let cwd = cwd.as_deref().map(wide);
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_NO_WINDOW,
            std::ptr::null(),
            cwd.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()),
            &startup,
            &mut process,
        )
    } == 0
    {
        return Err(error("CreateProcessW", unsafe { GetLastError() }));
    }
    let thread_closed = unsafe { CloseHandle(process.hThread) };
    let thread_error = (thread_closed == 0).then(|| unsafe { GetLastError() });
    let process_closed = unsafe { CloseHandle(process.hProcess) };
    if let Some(code) = thread_error {
        return Err(error("CloseHandle(thread)", code));
    }
    if process_closed == 0 {
        return Err(error("CloseHandle(process)", unsafe { GetLastError() }));
    }
    Ok(process.dwProcessId)
}

#[napi]
pub fn has_console_window() -> bool {
    !unsafe { GetConsoleWindow() }.is_null()
}
