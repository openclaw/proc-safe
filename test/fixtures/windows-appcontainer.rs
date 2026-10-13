#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{
        ffi::c_void,
        io,
        mem::{size_of, zeroed},
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::Path,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{
            ERROR_INSUFFICIENT_BUFFER, GetLastError, INVALID_HANDLE_VALUE, LocalFree, WAIT_OBJECT_0,
        },
        Security::{
            Authorization::*,
            DACL_SECURITY_INFORMATION, FreeSid, GetSecurityDescriptorSacl,
            Isolation::{CreateAppContainerProfile, DeleteAppContainerProfile},
            LABEL_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES,
            SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        },
        Storage::FileSystem::{
            CREATE_ALWAYS, CreateFileW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ,
            FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
        System::Threading::*,
    };
    struct LocalMemory(*mut c_void);
    impl Drop for LocalMemory {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    struct Sid(PSID);
    impl Drop for Sid {
        fn drop(&mut self) {
            unsafe {
                FreeSid(self.0);
            }
        }
    }
    struct Profile(Vec<u16>);
    impl Profile {
        fn delete(&mut self) -> io::Result<()> {
            if !self.0.is_empty() {
                let result = unsafe { DeleteAppContainerProfile(self.0.as_ptr()) };
                if result < 0 {
                    return Err(io::Error::from_raw_os_error(result));
                }
                self.0.clear();
            }
            Ok(())
        }
    }
    impl Drop for Profile {
        fn drop(&mut self) {
            let _ = self.delete();
        }
    }
    struct Attributes(Vec<usize>);
    impl Drop for Attributes {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast());
            }
        }
    }
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain([0]).collect()
    }
    fn quote(value: &str) -> String {
        let mut result = String::from("\"");
        let mut slashes = 0;
        for c in value.chars() {
            if c == '\\' {
                slashes += 1;
                continue;
            }
            result.extend(std::iter::repeat_n(
                '\\',
                if c == '"' { slashes * 2 + 1 } else { slashes },
            ));
            slashes = 0;
            result.push(c);
        }
        result.extend(std::iter::repeat_n('\\', slashes * 2));
        result.push('"');
        result
    }
    fn grant_tree(path: &Path, sid: PSID) -> io::Result<()> {
        let name = wide(path);
        let mut old_acl = null_mut();
        let mut descriptor = null_mut();
        let code = unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old_acl,
                null_mut(),
                &mut descriptor,
            )
        };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let _descriptor = LocalMemory(descriptor);
        let mut access: EXPLICIT_ACCESS_W = unsafe { zeroed() };
        access.grfAccessPermissions = FILE_ALL_ACCESS;
        access.grfAccessMode = GRANT_ACCESS;
        access.grfInheritance = if path.is_dir() {
            SUB_CONTAINERS_AND_OBJECTS_INHERIT
        } else {
            0
        };
        access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        access.Trustee.ptstrName = sid.cast();
        let mut acl = null_mut();
        let code = unsafe { SetEntriesInAclW(1, &access, old_acl, &mut acl) };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let _acl = LocalMemory(acl.cast());
        let code = unsafe {
            SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null(),
            )
        };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        if path.is_dir() {
            for entry in std::fs::read_dir(path)? {
                grant_tree(&entry?.path(), sid)?;
            }
        }
        Ok(())
    }
    fn allow_low_integrity_writes(path: &Path) -> io::Result<()> {
        let sddl: Vec<u16> = "S:(ML;OICI;NW;;;LW)".encode_utf16().chain([0]).collect();
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let _descriptor = LocalMemory(descriptor);
        let mut present = 0;
        let mut defaulted = 0;
        let mut sacl = null_mut();
        if unsafe { GetSecurityDescriptorSacl(descriptor, &mut present, &mut sacl, &mut defaulted) }
            == 0
            || present == 0
        {
            return Err(io::Error::last_os_error());
        }
        let code = unsafe {
            SetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null(),
                sacl,
            )
        };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        Ok(())
    }
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 || !["node", "bun"].contains(&args[3].as_str()) {
        return Err("expected isolated runtime, probe script, directory, and runtime kind".into());
    }
    let name: Vec<u16> = format!(
        "proc-safe-proof-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    )
    .encode_utf16()
    .chain([0])
    .collect();
    let mut sid = null_mut();
    let result = unsafe {
        CreateAppContainerProfile(
            name.as_ptr(),
            name.as_ptr(),
            name.as_ptr(),
            null(),
            0,
            &mut sid,
        )
    };
    if result < 0 {
        return Err(format!("CreateAppContainerProfile failed: {result:#x}").into());
    }
    let mut profile = Profile(name);
    let sid = Sid(sid);
    let proof = (|| -> Result<String, Box<dyn std::error::Error>> {
        grant_tree(Path::new(&args[2]), sid.0)?;
        allow_low_integrity_writes(Path::new(&args[2]))?;
        let mut text = null_mut();
        if unsafe { ConvertSidToStringSidW(sid.0, &mut text) } == 0 {
            return Err(io::Error::last_os_error().into());
        }
        let _text = LocalMemory(text.cast());
        let mut length = 0;
        while unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        let expected = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })?;
        let mut bytes = 0;
        if unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes) } != 0
            || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
        {
            return Err(io::Error::last_os_error().into());
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        if unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 2, 0, &mut bytes)
        } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let mut attributes = Attributes(storage);
        let mut capabilities: SECURITY_CAPABILITIES = unsafe { zeroed() };
        capabilities.AppContainerSid = sid.0;
        if unsafe {
            UpdateProcThreadAttribute(
                attributes.0.as_mut_ptr().cast(),
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                (&mut capabilities as *mut SECURITY_CAPABILITIES).cast(),
                size_of::<SECURITY_CAPABILITIES>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let log = unsafe {
            CreateFileW(
                wide(&Path::new(&args[2]).join("child.log")).as_ptr(),
                FILE_GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &security,
                CREATE_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        };
        if log == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error().into());
        }
        let log = unsafe { OwnedHandle::from_raw_handle(log) };
        let input = unsafe {
            CreateFileW(
                wide(Path::new("NUL")).as_ptr(),
                FILE_GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &security,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        };
        if input == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error().into());
        }
        let input = unsafe { OwnedHandle::from_raw_handle(input) };
        let mut inherited = [log.as_raw_handle(), input.as_raw_handle()];
        if unsafe {
            UpdateProcThreadAttribute(
                attributes.0.as_mut_ptr().cast(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherited.as_mut_ptr().cast(),
                size_of_val(&inherited),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let executable = wide(Path::new(&args[0]));
        let cwd = wide(Path::new(&args[2]));
        let mut launch = vec![args[0].as_str()];
        if args[3] == "node" {
            // The copied tree has no symlinks; avoid Node's JS realpath walk through denied ancestors.
            launch.extend(["--preserve-symlinks", "--preserve-symlinks-main"]);
        }
        launch.extend([args[1].as_str(), "--contained", expected.as_str()]);
        let mut command: Vec<u16> = launch
            .iter()
            .map(|arg| quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
            .encode_utf16()
            .chain([0])
            .collect();
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.lpAttributeList = attributes.0.as_mut_ptr().cast();
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = input.as_raw_handle();
        startup.StartupInfo.hStdOutput = log.as_raw_handle();
        startup.StartupInfo.hStdError = log.as_raw_handle();
        let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
        if unsafe {
            CreateProcessW(
                executable.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
                null(),
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut process,
            )
        } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let child = unsafe { OwnedHandle::from_raw_handle(process.hProcess) };
        let _thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
        if unsafe { WaitForSingleObject(child.as_raw_handle(), 30_000) } != WAIT_OBJECT_0 {
            unsafe {
                TerminateProcess(child.as_raw_handle(), 1);
                WaitForSingleObject(child.as_raw_handle(), 5_000);
            }
            return Err("AppContainer child did not complete within 30 seconds".into());
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(child.as_raw_handle(), &mut code) } == 0 {
            return Err(io::Error::last_os_error().into());
        }
        if code != 0 {
            return Err(format!("AppContainer child exited with {code}").into());
        }
        Ok(expected)
    })();
    let cleanup = profile.delete();
    let expected = proof?;
    cleanup?;
    println!("{expected}");
    Ok(())
}

#[cfg(not(windows))]
fn main() {}
