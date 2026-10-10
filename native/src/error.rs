use napi::{Error, Status};

pub fn failure(code: &str, message: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{code}: {message}"))
}

#[cfg(unix)]
pub fn io(error: std::io::Error) -> Error {
    let code = match error.kind() {
        std::io::ErrorKind::PermissionDenied => "access-denied",
        _ => "operation-failed",
    };
    failure(code, error)
}
