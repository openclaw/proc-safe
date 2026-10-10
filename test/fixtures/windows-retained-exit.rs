#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{
        io::{self, BufRead, Write},
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::{Command, Stdio},
    };
    use windows_sys::Win32::{
        Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle},
        System::Threading::GetCurrentProcess,
    };

    let runtime = std::env::args().nth(1).ok_or("missing Node executable")?;
    let mut child = Command::new(runtime)
        .args(["-e", "process.stdin.once('data',()=>process.exit(259));process.stdin.once('end',()=>process.exit(1))"])
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn()?;
    let mut duplicate = std::ptr::null_mut();
    let current = unsafe { GetCurrentProcess() };
    if unsafe {
        DuplicateHandle(
            current,
            child.as_raw_handle(),
            current,
            &mut duplicate,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(io::Error::last_os_error().into());
    }
    // This separate owner remains open even if std changes how Child::wait owns its handle.
    let retained = unsafe { OwnedHandle::from_raw_handle(duplicate) };
    let mut input = io::stdin().lock();
    let mut line = String::new();
    println!("{}", child.id());
    io::stdout().flush()?;
    input.read_line(&mut line)?;
    if line.trim() != "exit" {
        return Err("expected exit command".into());
    }
    child
        .stdin
        .take()
        .ok_or("missing child stdin")?
        .write_all(b"exit\n")?;
    let result = child.wait()?;
    if result.code() != Some(259) {
        return Err("expected retained exit code 259".into());
    }
    println!("retained");
    io::stdout().flush()?;
    line.clear();
    input.read_line(&mut line)?;
    if line.trim() != "release" {
        return Err("expected release command".into());
    }
    drop(retained);
    Ok(())
}

#[cfg(not(windows))]
fn main() {}
