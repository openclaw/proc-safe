#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{
        io,
        mem::{size_of, zeroed},
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    };
    use windows_sys::Win32::{
        Foundation::{HANDLE, WAIT_OBJECT_0},
        Security::{
            ACL, ACL_REVISION, CreateRestrictedToken, DACL_SECURITY_INFORMATION,
            DISABLE_MAX_PRIVILEGE, InitializeAcl, InitializeSecurityDescriptor,
            SECURITY_DESCRIPTOR, SetKernelObjectSecurity, SetSecurityDescriptorDacl,
            TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY, TOKEN_WRITE_DAC,
        },
        System::Threading::{
            CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessAsUserW, GetCurrentProcess,
            GetExitCodeProcess, OpenProcessToken, PROCESS_INFORMATION, ResumeThread, STARTUPINFOW,
            TerminateProcess, WaitForSingleObject,
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
    if arguments.len() != 3 && !deny_caller_token {
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
    let mut restricted: HANDLE = std::ptr::null_mut();
    if unsafe {
        CreateRestrictedToken(
            token.as_raw_handle(),
            DISABLE_MAX_PRIVILEGE,
            0,
            std::ptr::null(),
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
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    if unsafe {
        CreateProcessAsUserW(
            restricted.as_raw_handle(),
            executable.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_NO_WINDOW
                | if deny_caller_token {
                    CREATE_SUSPENDED
                } else {
                    0
                },
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
    let thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
    if deny_caller_token {
        if let Err(error) = deny_token(handle.as_raw_handle()) {
            unsafe {
                TerminateProcess(handle.as_raw_handle(), 1);
            }
            return Err(error.into());
        }
        if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
            let error = io::Error::last_os_error();
            unsafe {
                TerminateProcess(handle.as_raw_handle(), 1);
            }
            return Err(error.into());
        }
    }
    if unsafe { WaitForSingleObject(handle.as_raw_handle(), 30_000) } != WAIT_OBJECT_0 {
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
