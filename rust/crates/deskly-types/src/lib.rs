//! Types generated exclusively from the repository's JSON Schema contract
//! and the schema components in its OpenAPI 3.1 contract.
//!
//! Run `cargo build --locked -p deskly-types` in `rust/` to generate them.
//! Generated files live in Cargo's OUT_DIR and must not be edited.

// typify's schema unions deliberately retain their generated public shape.
#[allow(clippy::large_enum_variant)]
mod generated {
    include!(concat!(env!("OUT_DIR"), "/types.rs"));
}

pub use generated::*;

fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
