#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
fn main() {
    use std::{
        io::{self, BufRead, Write},
        process::{Command, Stdio},
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
        "environment" => {
            println!(
                "{} {}",
                std::env::var("PROC_SAFE_JOB_INHERIT").unwrap_or_else(|_| "empty".into()),
                std::env::vars_os().count()
            );
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
        "restricted-run" => {
            // Raw creation escapes libuv's silent-breakaway job before installing UI limits.
            let result = Command::new(std::env::current_exe().unwrap())
                .arg("restricted-exec")
                .args(&args[2..])
                .status()
                .unwrap();
            std::process::exit(result.code().unwrap_or(1));
        }
        "restricted-exec" => {
            let job = unsafe { CreateJobObjectW(null(), null()) };
            assert!(!job.is_null());
            let limits = JOBOBJECT_BASIC_UI_RESTRICTIONS {
                UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES,
            };
            assert_ne!(
                unsafe {
                    SetInformationJobObject(
                        job,
                        JobObjectBasicUIRestrictions,
                        (&limits as *const JOBOBJECT_BASIC_UI_RESTRICTIONS).cast(),
                        std::mem::size_of_val(&limits) as u32,
                    )
                },
                0
            );
            assert_ne!(
                unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) },
                0
            );
            let result = Command::new(&args[2]).args(&args[3..]).status().unwrap();
            unsafe {
                CloseHandle(job);
            }
            std::process::exit(result.code().unwrap_or(1));
        }
        "tree" => {
            let child = Command::new(std::env::current_exe().unwrap())
                .args(["tick", &args[2]])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            println!("{}", child.id());
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
