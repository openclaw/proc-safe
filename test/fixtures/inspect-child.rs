use std::process::Command;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(target_os = "macos")]
    if args.first().map(String::as_str) == Some("--suspended") {
        suspended(&args[1..]);
        return;
    }
    #[cfg(target_os = "macos")]
    if args.first().map(String::as_str) == Some("--large-argv") {
        use std::os::unix::process::CommandExt;
        let limit = unsafe { libc::sysconf(libc::_SC_ARG_MAX) };
        assert!(limit > 128);
        let code = Command::new(std::env::current_exe().unwrap())
            .arg0("x".repeat(limit as usize - 64))
            .env_clear()
            .status()
            .unwrap();
        std::process::exit(code.code().unwrap_or(1));
    }
    if args
        .first()
        .is_some_and(|mode| mode.starts_with("--launch"))
    {
        // Bun's child_process environment conversion drops __proto__; set it in
        // this single-threaded native launcher so the real target receives it.
        unsafe {
            std::env::set_var("__proto__", "literal");
        }
        let mut command = Command::new(&args[1]);
        command.args(&args[2..]);
        #[cfg(unix)]
        if args[0] == "--launch-empty-argv0" {
            use std::os::unix::process::CommandExt;
            command.arg0("");
        }
        let code = command.status().unwrap();
        std::process::exit(code.code().unwrap_or(1));
    }
    println!("{}", std::process::id());
    std::thread::sleep(std::time::Duration::from_secs(60));
}

#[cfg(target_os = "macos")]
fn suspended(args: &[String]) {
    use std::ffi::CString;
    let strings: Vec<CString> = args
        .iter()
        .map(|value| CString::new(value.as_str()).unwrap())
        .collect();
    let mut argv: Vec<*mut libc::c_char> = strings
        .iter()
        .map(|value| value.as_ptr().cast_mut())
        .collect();
    argv.push(std::ptr::null_mut());
    let environment = CString::new("PROBE=x").unwrap();
    let envp = [environment.as_ptr().cast_mut(), std::ptr::null_mut()];
    let mut attributes = std::ptr::null_mut();
    let mut pid = 0;
    unsafe {
        assert_eq!(libc::posix_spawnattr_init(&mut attributes), 0);
        assert_eq!(
            libc::posix_spawnattr_setflags(
                &mut attributes,
                libc::POSIX_SPAWN_START_SUSPENDED as i16
            ),
            0
        );
        let result = libc::posix_spawn(
            &mut pid,
            strings[0].as_ptr(),
            std::ptr::null(),
            &attributes,
            argv.as_ptr(),
            envp.as_ptr(),
        );
        libc::posix_spawnattr_destroy(&mut attributes);
        assert_eq!(result, 0);
    }
    println!("{pid}");
    let mut exit_status = 0;
    unsafe {
        assert_eq!(libc::waitpid(pid, &mut exit_status, 0), pid);
    }
}
