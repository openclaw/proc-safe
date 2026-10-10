use crate::error::failure;
use napi::Result;
use napi_derive::napi;

#[napi(object)]
pub struct EnvironmentEntry {
    pub key: String,
    pub value: String,
}

#[napi(object)]
pub struct ProcessCommand {
    pub executable: String,
    pub argv: Vec<String>,
    pub command_line: Option<String>,
    pub cwd: Option<String>,
    pub environment: Vec<EnvironmentEntry>,
}

#[napi]
pub fn inspect_supported() -> Result<bool> {
    #[cfg(target_os = "macos")]
    return macos::supported();
    #[cfg(windows)]
    Ok(true)
}

#[napi]
pub fn read_process_command(
    pid: u32,
    environment_keys: Vec<String>,
) -> Result<Option<ProcessCommand>> {
    if pid == 0 || (!cfg!(windows) && pid > i32::MAX as u32) {
        return Err(failure("invalid-argument", "invalid process ID"));
    }
    if environment_keys
        .iter()
        .any(|key| key.is_empty() || key.contains(['\0', '=']))
    {
        return Err(failure("invalid-argument", "invalid environment key"));
    }
    #[cfg(target_os = "macos")]
    return macos::read(pid, &environment_keys);
    #[cfg(windows)]
    return windows::read(pid, &environment_keys);
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use crate::error::io;
    use std::{ffi::c_void, mem::size_of};

    pub fn supported() -> Result<bool> {
        let mut translated: i32 = 0;
        let mut size = size_of::<i32>();
        let result = unsafe {
            libc::sysctlbyname(
                c"sysctl.proc_translated".as_ptr(),
                (&mut translated as *mut i32).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENOENT) {
                return Ok(true);
            }
            return Err(io(error));
        }
        if size != size_of::<i32>() || ![0, 1].contains(&translated) {
            return Err(failure("layout-mismatch", "invalid translation status"));
        }
        Ok(translated == 0)
    }

    fn sysctl(mib: &mut [i32], buffer: *mut c_void, size: &mut usize) -> Result<()> {
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as u32,
                buffer,
                size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(io(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    pub fn read(pid: u32, keys: &[String]) -> Result<Option<ProcessCommand>> {
        if !supported()? {
            return Err(failure(
                "unsupported-platform",
                "process command inspection under Rosetta is unsupported; use native arm64 Node.js or Bun",
            ));
        }
        let mut arg_max: i32 = 0;
        let mut size = size_of::<i32>();
        sysctl(
            &mut [libc::CTL_KERN, libc::KERN_ARGMAX],
            (&mut arg_max as *mut i32).cast(),
            &mut size,
        )?;
        if size != size_of::<i32>() || !(5..=16 * 1024 * 1024).contains(&arg_max) {
            return Err(failure("layout-mismatch", "invalid Darwin argument limit"));
        }
        let mut bytes = vec![0u8; arg_max as usize];
        size = bytes.len();
        if let Err(error) = sysctl(
            &mut [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as i32],
            bytes.as_mut_ptr().cast(),
            &mut size,
        ) {
            // ESRCH alone does not prove that a retained kernel object has disappeared.
            if crate::identity::read_process_identity(pid)?.is_none() {
                return Ok(None);
            }
            return Err(error);
        }
        if size < 5 || size > bytes.len() {
            return Err(failure("incomplete", "truncated Darwin process arguments"));
        }
        bytes.truncate(size);
        parse(&bytes, keys).map(Some)
    }

    fn string(bytes: &[u8]) -> Result<String> {
        String::from_utf8(bytes.to_vec())
            .map_err(|_| failure("layout-mismatch", "process arguments are not valid UTF-8"))
    }

    fn terminated<'a>(bytes: &'a [u8], offset: &mut usize) -> Result<&'a [u8]> {
        let tail = bytes
            .get(*offset..)
            .ok_or_else(|| failure("incomplete", "truncated process arguments"))?;
        let length = tail
            .iter()
            .position(|&byte| byte == 0)
            .ok_or_else(|| failure("incomplete", "unterminated process argument"))?;
        *offset += length + 1;
        Ok(&tail[..length])
    }

    fn parse(bytes: &[u8], keys: &[String]) -> Result<ProcessCommand> {
        let argc = i32::from_ne_bytes(bytes[..4].try_into().unwrap());
        if argc < 0 || argc as usize > bytes.len() - 4 {
            return Err(failure("layout-mismatch", "invalid Darwin argument count"));
        }
        let mut offset = 4;
        let executable = string(terminated(bytes, &mut offset)?)?;
        if executable.is_empty() {
            return Err(failure("layout-mismatch", "empty Darwin executable"));
        }
        // XNU aligns the original "executable_path=" string to target pointer size,
        // then strips that prefix from this sysctl response. Do not skip
        // arbitrary NULs: an empty argv[0] must not shift environment data into argv.
        let aligned = (offset - 4 + b"executable_path=".len()).next_multiple_of(8)
            - b"executable_path=".len()
            + 4;
        if aligned > bytes.len() || bytes[offset..aligned].iter().any(|&byte| byte != 0) {
            return Err(failure(
                "layout-mismatch",
                "invalid Darwin argument alignment",
            ));
        }
        offset = aligned;
        let mut argv = Vec::new();
        for _ in 0..argc {
            argv.push(string(terminated(bytes, &mut offset)?)?);
        }
        let mut environment = Vec::new();
        if !keys.is_empty() {
            while offset < bytes.len() && bytes[offset] != 0 {
                let entry_offset = offset;
                let entry = terminated(bytes, &mut offset)?;
                // XNU's Apple vector begins with pfz at an aligned boundary. With
                // zero padding it is indistinguishable from an envp entry: refuse
                // the whole observation instead of returning startup metadata.
                if (entry_offset - 4).is_multiple_of(8) && entry.starts_with(b"pfz=") {
                    return Err(failure(
                        "incomplete",
                        "ambiguous Darwin environment boundary",
                    ));
                }
                if let Some(separator) = entry.iter().position(|&byte| byte == b'=')
                    && let Some(key) = keys
                        .iter()
                        .find(|key| key.as_bytes() == &entry[..separator])
                {
                    environment.push(EnvironmentEntry {
                        key: key.clone(),
                        value: string(&entry[separator + 1..])?,
                    });
                }
            }
            if offset == bytes.len() {
                return Err(failure("incomplete", "unterminated Darwin environment"));
            }
        }
        Ok(ProcessCommand {
            executable,
            argv,
            command_line: None,
            cwd: None,
            environment,
        })
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        ffi::c_void,
        mem::{size_of, zeroed},
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, GetLastError, HANDLE,
            LocalFree,
        },
        System::{
            Diagnostics::Debug::ReadProcessMemory,
            Memory::{
                MEM_COMMIT, MEMORY_BASIC_INFORMATION, PAGE_GUARD, PAGE_NOACCESS, VirtualQueryEx,
            },
            Threading::{
                OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ, QueryFullProcessImageNameW,
            },
        },
        UI::Shell::CommandLineToArgvW,
    };

    // A foreign process controls these layouts. Every read is bounded and checked.
    const ENV_LIMIT: usize = 1024 * 1024;
    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtQueryInformationProcess(
            process: HANDLE,
            class: u32,
            info: *mut c_void,
            length: u32,
            actual: *mut u32,
        ) -> i32;
    }

    fn win_error(operation: &str) -> napi::Error {
        let code = unsafe { GetLastError() };
        failure(
            if code == ERROR_ACCESS_DENIED {
                "access-denied"
            } else {
                "operation-failed"
            },
            format!("{operation} failed ({code})"),
        )
    }

    fn query(handle: HANDLE, class: u32, bytes: &mut [u8]) -> Result<()> {
        let mut actual = 0;
        let status = unsafe {
            NtQueryInformationProcess(
                handle,
                class,
                bytes.as_mut_ptr().cast(),
                bytes.len() as u32,
                &mut actual,
            )
        };
        if status < 0 {
            return Err(failure(
                if status as u32 == 0xc0000022 {
                    "access-denied"
                } else {
                    "operation-failed"
                },
                format!("process query failed ({status:#x})"),
            ));
        }
        if actual as usize != bytes.len() {
            return Err(failure(
                "layout-mismatch",
                "invalid process information length",
            ));
        }
        Ok(())
    }

    fn memory(handle: HANDLE, address: usize, length: usize) -> Result<Vec<u8>> {
        if address == 0
            || length == 0
            || length > ENV_LIMIT
            || address.checked_add(length).is_none()
        {
            return Err(failure("layout-mismatch", "invalid foreign memory range"));
        }
        let mut bytes = vec![0u8; length];
        let mut actual = 0;
        if unsafe {
            ReadProcessMemory(
                handle,
                address as *const c_void,
                bytes.as_mut_ptr().cast(),
                length,
                &mut actual,
            )
        } == 0
        {
            return Err(win_error("ReadProcessMemory"));
        }
        if actual != length {
            return Err(failure("incomplete", "short foreign memory read"));
        }
        Ok(bytes)
    }

    fn pointer(bytes: &[u8], offset: usize, narrow: bool) -> usize {
        if narrow {
            u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize
        } else {
            u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap()) as usize
        }
    }

    fn wide(bytes: &[u8]) -> Result<String> {
        if !bytes.len().is_multiple_of(2) {
            return Err(failure("layout-mismatch", "odd UTF-16 byte length"));
        }
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units).map_err(|_| failure("layout-mismatch", "invalid process UTF-16"))
    }

    fn location(value: usize, base: usize, normalized: bool, narrow: bool) -> Result<usize> {
        let address = if normalized {
            Some(value)
        } else {
            base.checked_add(value)
        }
        .ok_or_else(|| failure("layout-mismatch", "foreign pointer overflow"))?;
        if address == 0 || address % 2 != 0 || narrow && address > u32::MAX as usize {
            return Err(failure("layout-mismatch", "invalid foreign pointer"));
        }
        Ok(address)
    }

    fn field(
        handle: HANDLE,
        header: &[u8],
        offset: usize,
        narrow: bool,
        base: usize,
        normalized: bool,
    ) -> Result<String> {
        let length = u16::from_le_bytes(header[offset..offset + 2].try_into().unwrap()) as usize;
        let maximum =
            u16::from_le_bytes(header[offset + 2..offset + 4].try_into().unwrap()) as usize;
        if length > maximum || !length.is_multiple_of(2) || !maximum.is_multiple_of(2) {
            return Err(failure("layout-mismatch", "invalid process UNICODE_STRING"));
        }
        if length == 0 {
            return Ok(String::new());
        }
        let address = location(
            pointer(header, offset + if narrow { 4 } else { 8 }, narrow),
            base,
            normalized,
            narrow,
        )?;
        let value = wide(&memory(handle, address, length)?)?;
        if value.contains('\0') {
            return Err(failure(
                "layout-mismatch",
                "embedded process string terminator",
            ));
        }
        Ok(value)
    }

    fn environment(
        handle: HANDLE,
        address: usize,
        keys: &[String],
    ) -> Result<Vec<EnvironmentEntry>> {
        let mut bytes = Vec::new();
        let mut cursor = address;
        loop {
            let mut region: MEMORY_BASIC_INFORMATION = unsafe { zeroed() };
            if unsafe {
                VirtualQueryEx(
                    handle,
                    cursor as *const c_void,
                    &mut region,
                    size_of::<MEMORY_BASIC_INFORMATION>(),
                )
            } != size_of::<MEMORY_BASIC_INFORMATION>()
            {
                return Err(win_error("VirtualQueryEx"));
            }
            let base = region.BaseAddress as usize;
            let end = base
                .checked_add(region.RegionSize)
                .ok_or_else(|| failure("layout-mismatch", "memory region overflow"))?;
            if region.State != MEM_COMMIT
                || region.Protect & (PAGE_NOACCESS | PAGE_GUARD) != 0
                || cursor < base
                || cursor >= end
            {
                return Err(failure("incomplete", "unreadable environment region"));
            }
            let length = (end - cursor).min(4096).min(ENV_LIMIT - bytes.len());
            if length == 0 || !length.is_multiple_of(2) {
                return Err(failure("incomplete", "environment exceeds bounded read"));
            }
            let start = bytes.len().saturating_sub(2);
            bytes.extend(memory(handle, cursor, length)?);
            if let Some(offset) = (start..bytes.len().saturating_sub(3))
                .step_by(2)
                .find(|&offset| bytes[offset..offset + 4] == [0, 0, 0, 0])
            {
                bytes.truncate(offset + 2);
                break;
            }
            cursor = cursor
                .checked_add(length)
                .ok_or_else(|| failure("layout-mismatch", "environment address overflow"))?;
        }
        let mut result = Vec::new();
        // Decode only requested values; unrelated environment data never crosses N-API.
        for entry in bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>()
            .split(|&unit| unit == 0)
        {
            if let Some(separator) = entry.iter().position(|&unit| unit == b'=' as u16) {
                for key in keys {
                    if key.encode_utf16().eq(entry[..separator].iter().copied()) {
                        let value = String::from_utf16(&entry[separator + 1..]).map_err(|_| {
                            failure("layout-mismatch", "invalid environment UTF-16")
                        })?;
                        result.push(EnvironmentEntry {
                            key: key.clone(),
                            value,
                        });
                        break;
                    }
                }
            }
        }
        Ok(result)
    }

    fn argv(line: &str) -> Result<Vec<String>> {
        let input: Vec<u16> = line.encode_utf16().chain(Some(0)).collect();
        let mut count = 0;
        let allocation = unsafe { CommandLineToArgvW(input.as_ptr(), &mut count) };
        if allocation.is_null() {
            return Err(win_error("CommandLineToArgvW"));
        }
        struct Args(*mut *mut u16);
        impl Drop for Args {
            fn drop(&mut self) {
                unsafe {
                    LocalFree(self.0.cast());
                }
            }
        }
        let owner = Args(allocation);
        if count <= 0 || count as usize > input.len() {
            return Err(failure("layout-mismatch", "invalid parsed argument count"));
        }
        let mut result = Vec::new();
        for &argument in unsafe { std::slice::from_raw_parts(owner.0, count as usize) } {
            let mut length = 0;
            while length < input.len() && unsafe { *argument.add(length) } != 0 {
                length += 1;
            }
            if length == input.len() {
                return Err(failure("layout-mismatch", "unterminated parsed argument"));
            }
            result.push(
                String::from_utf16(unsafe { std::slice::from_raw_parts(argument, length) })
                    .map_err(|_| failure("layout-mismatch", "invalid parsed argument UTF-16"))?,
            );
        }
        Ok(result)
    }

    pub fn read(pid: u32, keys: &[String]) -> Result<Option<ProcessCommand>> {
        let raw = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
        if raw.is_null() {
            if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
                return Ok(None);
            }
            return Err(win_error("OpenProcess"));
        }
        let handle = OwnedHandle(raw);
        let mut basic = [0u8; 48];
        query(handle.0, 0, &mut basic)?;
        if pointer(&basic, 32, false) != pid as usize {
            return Err(failure("layout-mismatch", "process PID does not match"));
        }
        let mut wow64 = [0u8; 8];
        query(handle.0, 26, &mut wow64)?;
        let wow64_peb = pointer(&wow64, 0, false);
        let narrow = wow64_peb != 0;
        let peb = if narrow {
            wow64_peb
        } else {
            pointer(&basic, 8, false)
        };
        let peb_bytes = memory(handle.0, peb, if narrow { 20 } else { 40 })?;
        let address = location(
            pointer(&peb_bytes, if narrow { 16 } else { 32 }, narrow),
            0,
            true,
            narrow,
        )?;
        let header = memory(handle.0, address, if narrow { 76 } else { 136 })?;
        let maximum = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
        let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        if length < header.len() || length > maximum || maximum > ENV_LIMIT {
            return Err(failure(
                "layout-mismatch",
                "invalid process parameters header",
            ));
        }
        let normalized = u32::from_le_bytes(header[8..12].try_into().unwrap()) & 1 != 0;
        let command_line = field(
            handle.0,
            &header,
            if narrow { 64 } else { 112 },
            narrow,
            address,
            normalized,
        )?;
        if command_line.is_empty() {
            return Err(failure("incomplete", "empty process command line"));
        }
        let cwd = field(
            handle.0,
            &header,
            if narrow { 36 } else { 56 },
            narrow,
            address,
            normalized,
        )?;
        let mut path = vec![0u16; 32768];
        let mut path_length = path.len() as u32;
        if unsafe { QueryFullProcessImageNameW(handle.0, 0, path.as_mut_ptr(), &mut path_length) }
            == 0
        {
            return Err(win_error("QueryFullProcessImageNameW"));
        }
        if path_length == 0 || path_length as usize >= path.len() {
            return Err(failure("layout-mismatch", "invalid process image length"));
        }
        let executable = String::from_utf16(&path[..path_length as usize])
            .map_err(|_| failure("layout-mismatch", "invalid process image UTF-16"))?;
        let environment = if keys.is_empty() {
            Vec::new()
        } else {
            let value = pointer(&header, if narrow { 72 } else { 128 }, narrow);
            environment(handle.0, location(value, address, true, narrow)?, keys)?
        };
        Ok(Some(ProcessCommand {
            executable,
            argv: argv(&command_line)?,
            command_line: Some(command_line),
            cwd: Some(cwd),
            environment,
        }))
    }
}
