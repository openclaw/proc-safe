#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
fn main() {
    use std::{
        io::{self, BufRead, Read, Write},
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
        "competing-stdin" => {
            use std::{os::windows::ffi::OsStrExt, ptr::null_mut};
            use windows_sys::Win32::Storage::FileSystem::{
                CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, OPEN_EXISTING, ReadFile,
            };
            let name: Vec<u16> = std::ffi::OsStr::new(&args[2])
                .encode_wide()
                .chain(Some(0))
                .collect();
            let pipe = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    FILE_GENERIC_READ,
                    0,
                    null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    null_mut(),
                )
            };
            if pipe.is_null() || pipe == INVALID_HANDLE_VALUE {
                println!("connection-failed {}", unsafe { GetLastError() });
                io::stdout().flush().unwrap();
                std::process::exit(1);
            }
            println!("connected");
            io::stdout().flush().unwrap();
            let mut byte = 0u8;
            let mut count = 0u32;
            let ok = unsafe {
                ReadFile(
                    pipe,
                    (&mut byte as *mut u8).cast(),
                    1,
                    &mut count,
                    null_mut(),
                )
            };
            let error = if ok == 0 {
                unsafe { GetLastError() }
            } else {
                0
            };
            unsafe { CloseHandle(pipe) };
            let outcome = if count == 0
                && (ok != 0 || error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED)
            {
                "no-bytes"
            } else {
                "unexpected-read"
            };
            std::fs::write(&args[3], outcome).unwrap();
        }
        "mark-launch" => {
            std::fs::write(&args[2], "launched").unwrap();
        }
        "stdin" | "stdin-eof" => {
            let mut inside = 0;
            assert_ne!(
                unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut inside) },
                0
            );
            let mut available = 0;
            let input = unsafe {
                windows_sys::Win32::System::Console::GetStdHandle(
                    windows_sys::Win32::System::Console::STD_INPUT_HANDLE,
                )
            };
            if args[1] == "stdin" {
                assert_ne!(
                    unsafe {
                        windows_sys::Win32::System::Pipes::PeekNamedPipe(
                            input,
                            std::ptr::null_mut(),
                            0,
                            std::ptr::null_mut(),
                            &mut available,
                            std::ptr::null_mut(),
                        )
                    },
                    0
                );
                println!("ready {available} {inside}");
                io::stdout().flush().unwrap();
                while args[2] != "-" && !std::path::Path::new(&args[2]).exists() {
                    thread::sleep(Duration::from_millis(5));
                }
                // Force callers to drain both output channels while feeding input.
                io::stdout().write_all(&vec![b'x'; 180000]).unwrap();
                io::stderr().write_all(&vec![b'y'; 160000]).unwrap();
            }
            let mut count = 0u64;
            let mut hash = 2166136261u32;
            let mut buf = [0u8; 8192];
            loop {
                let read = io::stdin().read(&mut buf).unwrap();
                if read == 0 {
                    break;
                }
                count += read as u64;
                for &byte in &buf[..read] {
                    hash = hash.wrapping_mul(16777619) ^ byte as u32;
                }
            }
            if args[1] == "stdin-eof" {
                // Synthetic lifecycle evidence only, never input contents.
                std::fs::write(&args[2], count.to_string()).unwrap();
            } else {
                println!("\nend {count} {hash}");
            }
        }
        "stdin-closed" => {
            let input = unsafe {
                windows_sys::Win32::System::Console::GetStdHandle(
                    windows_sys::Win32::System::Console::STD_INPUT_HANDLE,
                )
            };
            assert_ne!(unsafe { CloseHandle(input) }, 0);
            println!("closed");
            io::stdout().flush().unwrap();
            loop {
                thread::sleep(Duration::from_millis(10));
            }
        }
        "stdin-tree" => {
            use std::os::windows::process::CommandExt;
            use std::process::{Command, Stdio};
            let child = Command::new(std::env::current_exe().unwrap())
                .args(["stdin", "-"])
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
                .spawn()
                .unwrap();
            println!("descendant {}", child.id());
            io::stdout().flush().unwrap();
            std::process::exit(259);
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
                                AddAccessAllowedAce(
                                    acl,
                                    ACL_REVISION,
                                    PROCESS_QUERY_LIMITED_INFORMATION,
                                    sid_ptr,
                                )
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
