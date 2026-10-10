use crate::error::failure;

pub fn denied() -> napi::Error {
    failure("access-denied", "visibility-policy")
}
