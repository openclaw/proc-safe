#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{
        io,
        mem::{size_of, zeroed},
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    };
    use windows_sys::Win32::{
        Foundation::{
            HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation, WAIT_OBJECT_0,
        },
        Security::{
            ACL, ACL_REVISION, CreateRestrictedToken, CreateWellKnownSid,
            DACL_SECURITY_INFORMATION, DISABLE_MAX_PRIVILEGE, InitializeAcl,
            InitializeSecurityDescriptor, SECURITY_DESCRIPTOR, SID_AND_ATTRIBUTES,
            SetKernelObjectSecurity, SetSecurityDescriptorDacl, TOKEN_ASSIGN_PRIMARY,
            TOKEN_DUPLICATE, TOKEN_QUERY, TOKEN_WRITE_DAC, WinBuiltinAdministratorsSid,
        },
        System::{
            Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
            Threading::{
                CREATE_NO_WINDOW, CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess,
                OpenProcessToken, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
                TerminateProcess, WaitForSingleObject,
            },
        },
    };

    fn deny_token(process: HANDLE) -> io::Result<()> {
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_WRITE_DAC, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut acl: ACL = unsafe { zeroed() };
        let mut descriptor: SECURITY_DESCRIPTOR = unsafe { zeroed() };
        let descriptor_ptr = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();
        if unsafe { InitializeAcl(&mut acl, size_of::<ACL>() as u32, ACL_REVISION) } == 0
            || unsafe { InitializeSecurityDescriptor(descriptor_ptr, 1) } == 0
            || unsafe { SetSecurityDescriptorDacl(descriptor_ptr, 1, &acl, 0) } == 0
            || unsafe {
                SetKernelObjectSecurity(
                    token.as_raw_handle(),
                    DACL_SECURITY_INFORMATION,
                    descriptor_ptr,
                )
            } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn quote(value: &str) -> String {
        let mut output = String::from("\"");
        let mut slashes = 0;
        for character in value.chars() {
            if character == '\\' {
                slashes += 1;
                continue;
            }
            if character == '"' {
                output.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
            } else {
                output.extend(std::iter::repeat_n('\\', slashes));
            }
            slashes = 0;
            output.push(character);
        }
        output.extend(std::iter::repeat_n('\\', slashes * 2));
        output.push('"');
        output
    }
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    let deny_caller_token = arguments.len() == 4 && arguments[3] == "--deny-token";
    let pin_access = arguments.len() == 4 && arguments[3] == "--pin-access";
    if arguments.len() != 3 && !deny_caller_token && !pin_access {
        return Err("expected runtime, probe script, and target PID".into());
    }
    let mut token: HANDLE = std::ptr::null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY,
            &mut token,
        )
    } == 0
    {
        return Err(io::Error::last_os_error().into());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut admin_sid = [0u32; 17];
    let mut admin_sid_len = size_of::<[u32; 17]>() as u32;
    if pin_access
        && unsafe {
            CreateWellKnownSid(
                WinBuiltinAdministratorsSid,
                std::ptr::null_mut(),
                admin_sid.as_mut_ptr().cast(),
                &mut admin_sid_len,
            )
        } == 0
    {
        return Err(io::Error::last_os_error().into());
    }
    let disabled_admin = SID_AND_ATTRIBUTES {
        Sid: admin_sid.as_mut_ptr().cast(),
        Attributes: 0,
    };
    let mut restricted: HANDLE = std::ptr::null_mut();
    if unsafe {
        CreateRestrictedToken(
            token.as_raw_handle(),
            DISABLE_MAX_PRIVILEGE,
            u32::from(pin_access),
            if pin_access {
                &disabled_admin
            } else {
                std::ptr::null()
            },
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            &mut restricted,
        )
    } == 0
    {
        return Err(io::Error::last_os_error().into());
    }
    let restricted = unsafe { OwnedHandle::from_raw_handle(restricted) };
    let executable: Vec<u16> = arguments[0].encode_utf16().chain([0]).collect();
    let mut command: Vec<u16> = arguments[..3]
        .iter()
        .map(|arg| quote(arg))
        .collect::<Vec<_>>()
        .join(" ")
        .encode_utf16()
        .chain([0])
        .collect();
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    startup.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    startup.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    for stdio in [startup.hStdInput, startup.hStdOutput, startup.hStdError] {
        if !stdio.is_null()
            && stdio != INVALID_HANDLE_VALUE
            && unsafe { SetHandleInformation(stdio, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
    }
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    if unsafe {
        CreateProcessAsUserW(
            restricted.as_raw_handle(),
            executable.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            CREATE_NO_WINDOW,
            std::ptr::null(),
            std::ptr::null(),
            &startup,
            &mut process,
        )
    } == 0
    {
        return Err(io::Error::last_os_error().into());
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(process.hProcess) };
    let _thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
    let started = std::time::Instant::now();
    if deny_caller_token {
        let directory = std::path::Path::new(&arguments[2]);
        while !directory.join("ready").exists() {
            if started.elapsed().as_millis() >= 30_000 {
                unsafe {
                    TerminateProcess(handle.as_raw_handle(), 1);
                }
                return Err("token denial probe did not initialize".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if let Err(error) = deny_token(handle.as_raw_handle()) {
            unsafe {
                TerminateProcess(handle.as_raw_handle(), 1);
            }
            return Err(error.into());
        }
        if let Err(error) = std::fs::write(directory.join("go"), b"go") {
            unsafe {
                TerminateProcess(handle.as_raw_handle(), 1);
            }
            return Err(error.into());
        }
    }
    let remaining_ms = 30_000u128.saturating_sub(started.elapsed().as_millis()) as u32;
    if unsafe { WaitForSingleObject(handle.as_raw_handle(), remaining_ms) } != WAIT_OBJECT_0 {
        unsafe {
            TerminateProcess(handle.as_raw_handle(), 1);
        }
        return Err("restricted probe did not finish".into());
    }
    let mut code = 0;
    if unsafe { GetExitCodeProcess(handle.as_raw_handle(), &mut code) } == 0 {
        return Err(io::Error::last_os_error().into());
    }
    if code != 0 {
        return Err(format!("restricted probe failed: {code}").into());
    }
    println!("restricted-token process query denial verified");
    Ok(())
}

#[cfg(not(windows))]
fn main() {}
