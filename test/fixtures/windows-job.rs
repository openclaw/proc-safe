#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
fn main() {
    use std::{
        io::{self, BufRead, Write},
        ptr::null,
        thread,
        time::Duration,
    };
    use windows_sys::Win32::{
        Foundation::*,
        System::{JobObjects::*, Threading::*},
    };
    let args: Vec<String> = std::env::args().collect();
    match args[1].as_str() {
        "token-info" => {
            use std::{
                mem::size_of,
                os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
            };
            use windows_sys::Win32::Security::*;
            // SID attribute bits from the Windows SDK (SystemServices in windows-sys).
            const SE_GROUP_ENABLED: u32 = 0x4;
            const SE_GROUP_USE_FOR_DENY_ONLY: u32 = 0x10;
            let raw = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    args[2].parse().unwrap(),
                )
            };
            assert!(!raw.is_null());
            let process = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut raw_token = std::ptr::null_mut();
            assert_ne!(
                unsafe { OpenProcessToken(process.as_raw_handle(), TOKEN_QUERY, &mut raw_token) },
                0
            );
            let token = unsafe { OwnedHandle::from_raw_handle(raw_token) };
            let information = |class| {
                let mut bytes = 0;
                unsafe {
                    GetTokenInformation(
                        token.as_raw_handle(),
                        class,
                        std::ptr::null_mut(),
                        0,
                        &mut bytes,
                    )
                };
                assert!(bytes > 0);
                let mut data = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
                assert_ne!(
                    unsafe {
                        GetTokenInformation(
                            token.as_raw_handle(),
                            class,
                            data.as_mut_ptr().cast(),
                            bytes,
                            &mut bytes,
                        )
                    },
                    0
                );
                data
            };
            let privileges = information(TokenPrivileges);
            let privileges = unsafe { &*privileges.as_ptr().cast::<TOKEN_PRIVILEGES>() };
            let entries = unsafe {
                std::slice::from_raw_parts(
                    privileges.Privileges.as_ptr(),
                    privileges.PrivilegeCount as usize,
                )
            };
            let privilege = |name: &str| {
                let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
                let mut luid = unsafe { std::mem::zeroed() };
                assert_ne!(
                    unsafe { LookupPrivilegeValueW(null(), wide.as_ptr(), &mut luid) },
                    0
                );
                let entry = entries.iter().find(|entry| {
                    entry.Luid.LowPart == luid.LowPart && entry.Luid.HighPart == luid.HighPart
                });
                format!(
                    "{{\"present\":{},\"enabled\":{}}}",
                    entry.is_some(),
                    entry.is_some_and(|e| e.Attributes & SE_PRIVILEGE_ENABLED != 0)
                )
            };
            let groups = information(TokenGroups);
            let groups = unsafe { &*groups.as_ptr().cast::<TOKEN_GROUPS>() };
            let groups = unsafe {
                std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize)
            };
            let mut sid = [0u32; 17];
            let mut sid_len = size_of::<[u32; 17]>() as u32;
            assert_ne!(
                unsafe {
                    CreateWellKnownSid(
                        WinBuiltinAdministratorsSid,
                        std::ptr::null_mut(),
                        sid.as_mut_ptr().cast(),
                        &mut sid_len,
                    )
                },
                0
            );
            let admin = groups
                .iter()
                .find(|g| unsafe { EqualSid(g.Sid, sid.as_mut_ptr().cast()) } != 0);
            let elevation = information(TokenElevation);
            let elevation = unsafe { &*elevation.as_ptr().cast::<TOKEN_ELEVATION>() };
            println!(
                "{{\"debug\":{},\"impersonate\":{},\"elevated\":{},\"admin\":{{\"present\":{},\"enabled\":{},\"denyOnly\":{}}}}}",
                privilege("SeDebugPrivilege"),
                privilege("SeImpersonatePrivilege"),
                elevation.TokenIsElevated != 0,
                admin.is_some(),
                admin.is_some_and(|g| g.Attributes & SE_GROUP_ENABLED != 0),
                admin.is_some_and(|g| g.Attributes & SE_GROUP_USE_FOR_DENY_ONLY != 0)
            );
        }
        "environment" => {
            fn json(value: &str) -> String {
                let mut out = String::from("\"");
                for c in value.chars() {
                    match c {
                        '\\' => out.push_str("\\\\"),
                        '"' => out.push_str("\\\""),
                        c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
                        c => out.push(c),
                    }
                }
                out.push('"');
                out
            }
            let keys = std::env::vars_os()
                .map(|(key, _)| json(&key.to_string_lossy()))
                .collect::<Vec<_>>()
                .join(",");
            // Only requested synthetic test values are printed, never inherited credentials.
            let requested = args[2..]
                .iter()
                .map(|key| {
                    let value = std::env::var(key)
                        .ok()
                        .map_or_else(|| "null".into(), |v| json(&v));
                    format!("{}:{value}", json(key))
                })
                .collect::<Vec<_>>()
                .join(",");
            println!("{{\"keys\":[{keys}],\"requested\":{{{requested}}}}}");
        }
        "handle-count" => {
            let process = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    args[2].parse().unwrap(),
                )
            };
            assert!(!process.is_null());
            let mut count = 0;
            assert_ne!(unsafe { GetProcessHandleCount(process, &mut count) }, 0);
            unsafe {
                CloseHandle(process);
            }
            println!("{count}");
        }
        "membership" => {
            let mut inside = 0;
            assert_ne!(
                unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut inside) },
                0
            );
            let console = unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() };
            println!("{inside} {}", console.is_null());
        }
        "owner" => {
            println!("ready");
            io::stdout().flush().unwrap();
            for line in io::stdin().lock().lines() {
                let mut count = 0;
                assert_ne!(
                    unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) },
                    0
                );
                match line.unwrap().as_str() {
                    "deny-duplicate" => {
                        use windows_sys::Win32::Security::*;
                        let mut sid = [0u32; 17];
                        let mut sid_len = std::mem::size_of_val(&sid) as u32;
                        let sid_ptr = sid.as_mut_ptr().cast();
                        assert_ne!(
                            unsafe {
                                CreateWellKnownSid(
                                    WinWorldSid,
                                    std::ptr::null_mut(),
                                    sid_ptr,
                                    &mut sid_len,
                                )
                            },
                            0
                        );
                        let mut storage = [0usize; 32];
                        let acl = storage.as_mut_ptr().cast::<ACL>();
                        let mut descriptor: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
                        let descriptor_ptr = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();
                        assert_ne!(
                            unsafe {
                                InitializeAcl(
                                    acl,
                                    std::mem::size_of_val(&storage) as u32,
                                    ACL_REVISION,
                                )
                            },
                            0
                        );
                        assert_ne!(
                            unsafe {
                                AddAccessDeniedAce(acl, ACL_REVISION, PROCESS_DUP_HANDLE, sid_ptr)
                            },
                            0
                        );
                        assert_ne!(
                            unsafe {
                                AddAccessAllowedAce(acl, ACL_REVISION, PROCESS_ALL_ACCESS, sid_ptr)
                            },
                            0
                        );
                        assert_ne!(
                            unsafe { InitializeSecurityDescriptor(descriptor_ptr, 1) },
                            0
                        );
                        assert_ne!(
                            unsafe { SetSecurityDescriptorDacl(descriptor_ptr, 1, acl, 0) },
                            0
                        );
                        assert_ne!(
                            unsafe {
                                SetKernelObjectSecurity(
                                    GetCurrentProcess(),
                                    DACL_SECURITY_INFORMATION,
                                    descriptor_ptr,
                                )
                            },
                            0
                        );
                        println!("denied");
                        io::stdout().flush().unwrap();
                    }
                    "count" => {
                        println!("{count}");
                        io::stdout().flush().unwrap();
                    }
                    "watch" => {
                        println!("watching");
                        io::stdout().flush().unwrap();
                        loop {
                            let mut now = 0;
                            assert_ne!(
                                unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut now) },
                                0
                            );
                            if now > count {
                                unsafe {
                                    ExitProcess(0);
                                }
                            }
                            thread::yield_now();
                        }
                    }
                    "exit" => break,
                    _ => panic!("unknown request"),
                }
            }
        }
        "tree" => {
            let executable = std::env::current_exe().unwrap();
            let image: Vec<u16> = executable
                .as_os_str()
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut command: Vec<u16> =
                format!("\"{}\" tick \"{}\"", executable.display(), args[2])
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
            let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
            startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
            // No inherited handles: output closes independently of descendant extinction.
            assert_ne!(
                unsafe {
                    CreateProcessW(
                        image.as_ptr(),
                        command.as_mut_ptr(),
                        null(),
                        null(),
                        0,
                        CREATE_NO_WINDOW,
                        null(),
                        null(),
                        &startup,
                        &mut info,
                    )
                },
                0
            );
            println!("{}", info.dwProcessId);
            unsafe {
                CloseHandle(info.hThread);
                CloseHandle(info.hProcess);
            }
            io::stdout().flush().unwrap();
            std::process::exit(259);
        }
        "tick" => {
            std::fs::write(&args[2], std::process::id().to_string()).unwrap();
            loop {
                thread::sleep(Duration::from_millis(10));
            }
        }
        "kill" => {
            let pid: u32 = args[2].parse().unwrap();
            let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
            assert!(!process.is_null());
            assert_ne!(unsafe { TerminateProcess(process, 81) }, 0);
            unsafe {
                CloseHandle(process);
            }
        }
        _ => panic!("unknown fixture mode"),
    }
}
