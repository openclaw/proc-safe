use crate::error::failure;
use napi::Result;
use napi_derive::napi;
use std::{
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::null_mut,
};
use windows_sys::Win32::{
    Foundation::{ERROR_ACCESS_DENIED, ERROR_INSUFFICIENT_BUFFER, GetLastError, LocalFree},
    Security::{
        Authorization::ConvertSidToStringSidW, GetTokenInformation, IsValidSid,
        TOKEN_APPCONTAINER_INFORMATION, TOKEN_QUERY, TokenAppContainerSid, TokenIsAppContainer,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

fn win_error(operation: &str) -> napi::Error {
    let code = unsafe { GetLastError() };
    failure(
        if code == ERROR_ACCESS_DENIED {
            "access-denied"
        } else {
            "operation-failed"
        },
        format!("{operation} failed (Win32 {code})"),
    )
}

#[napi]
pub fn read_current_app_container_sid() -> Result<Option<String>> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(win_error("OpenProcessToken"));
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut contained = 0u32;
    let mut returned = 0;
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenIsAppContainer,
            (&mut contained as *mut u32).cast(),
            size_of::<u32>() as u32,
            &mut returned,
        )
    } == 0
    {
        return Err(win_error("GetTokenInformation(TokenIsAppContainer)"));
    }
    if returned != size_of::<u32>() as u32 || contained > 1 {
        return Err(failure("layout-mismatch", "invalid AppContainer flag"));
    }
    if contained == 0 {
        return Ok(None);
    }

    let mut length = 0;
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenAppContainerSid,
            null_mut(),
            0,
            &mut length,
        )
    } != 0
        || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
    {
        return Err(win_error("GetTokenInformation(TokenAppContainerSid) size"));
    }
    if (length as usize) < size_of::<TOKEN_APPCONTAINER_INFORMATION>() || length > 65536 {
        return Err(failure(
            "layout-mismatch",
            "invalid AppContainer token size",
        ));
    }
    // Word alignment covers the pointer in TOKEN_APPCONTAINER_INFORMATION.
    let mut storage = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    let capacity = length;
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenAppContainerSid,
            storage.as_mut_ptr().cast(),
            capacity,
            &mut length,
        )
    } == 0
    {
        return Err(win_error("GetTokenInformation(TokenAppContainerSid)"));
    }
    if (length as usize) < size_of::<TOKEN_APPCONTAINER_INFORMATION>() || length > capacity {
        return Err(failure(
            "layout-mismatch",
            "invalid returned AppContainer token size",
        ));
    }
    let information = unsafe { &*storage.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>() };
    let bytes =
        unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), length as usize) };
    let offset = (information.TokenAppContainer as usize)
        .checked_sub(bytes.as_ptr() as usize)
        .ok_or_else(|| failure("layout-mismatch", "AppContainer SID outside token buffer"))?;
    if offset < size_of::<TOKEN_APPCONTAINER_INFORMATION>() || offset % 4 != 0 {
        return Err(failure("layout-mismatch", "misplaced AppContainer SID"));
    }
    let header = bytes
        .get(offset..offset.saturating_add(8))
        .ok_or_else(|| failure("layout-mismatch", "truncated AppContainer SID"))?;
    let sid_length = 8 + usize::from(header[1]) * 4;
    if header[0] != 1
        || header[1] > 15
        || offset.saturating_add(sid_length) > bytes.len()
        || unsafe { IsValidSid(information.TokenAppContainer) } == 0
    {
        return Err(failure("layout-mismatch", "invalid AppContainer SID"));
    }
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(information.TokenAppContainer, &mut text) } == 0 {
        return Err(win_error("ConvertSidToStringSidW"));
    }
    // Windows SID strings are bounded by the 15-subauthority binary format.
    let mut chars = 0;
    while chars < 192 && unsafe { *text.add(chars) } != 0 {
        chars += 1;
    }
    let result = if chars == 192 {
        Err(failure(
            "layout-mismatch",
            "unterminated AppContainer SID string",
        ))
    } else {
        String::from_utf16(unsafe { std::slice::from_raw_parts(text, chars) })
            .map_err(|_| failure("layout-mismatch", "invalid AppContainer SID string"))
    };
    unsafe {
        LocalFree(text.cast());
    }
    result.map(Some)
}
