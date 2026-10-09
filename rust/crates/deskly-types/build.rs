#[path = "codegen.rs"]
mod codegen;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let schema_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../schema");
    println!("cargo:rerun-if-changed={}", schema_dir.display());
    println!("cargo:rerun-if-changed=codegen.rs");
    let output = std::path::PathBuf::from(std::env::var("OUT_DIR")?).join("types.rs");
    std::fs::write(output, codegen::generate(&schema_dir)?)?;
    Ok(())
}
