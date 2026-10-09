#[path = "../codegen.rs"]
mod codegen;

#[test]
fn generation_is_deterministic_and_matches_the_build() {
    let schema_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../schema");
    let first = codegen::generate(&schema_dir).unwrap();
    let second = codegen::generate(&schema_dir).unwrap();
    assert_eq!(first, second);
    assert_eq!(first, include_str!(concat!(env!("OUT_DIR"), "/types.rs")));
    assert!(!first.contains(env!("CARGO_MANIFEST_DIR")));
    assert!(!first.contains('\r'));
}

struct SchemaCopy(std::path::PathBuf);

impl SchemaCopy {
    fn new() -> Self {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "deskly-types-schema-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../schema");
        for entry in std::fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_file() {
                std::fs::copy(entry.path(), path.join(entry.file_name())).unwrap();
            }
        }
        Self(path)
    }
}

impl Drop for SchemaCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn openapi_components_are_inputs_not_handwritten_rust_types() {
    let schemas = SchemaCopy::new();
    let path = schemas.0.join("openapi.json");
    let mut document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    document["components"]["schemas"]["SyntheticOpenApiProbe"] = serde_json::json!({
        "type": "object", "additionalProperties": false,
        "properties": {"marker": {"type": "string", "enum": ["synthetic-probe"]}},
        "required": ["marker"]
    });
    std::fs::write(path, serde_json::to_vec(&document).unwrap()).unwrap();
    let generated = codegen::generate(&schemas.0).unwrap();
    assert!(generated.contains("pub struct SyntheticOpenApiProbe"));
    assert!(generated.contains("synthetic-probe"));
    assert_eq!(generated, codegen::generate(&schemas.0).unwrap());
}

#[test]
fn openapi_references_remain_local_only() {
    let schemas = SchemaCopy::new();
    let path = schemas.0.join("openapi.json");
    let mut document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    document["components"]["schemas"]["SyntheticOpenApiProbe"] = serde_json::json!({
        "$ref": "https://example.invalid/remote.schema.json"
    });
    std::fs::write(path, serde_json::to_vec(&document).unwrap()).unwrap();
    let error = codegen::generate(&schemas.0).unwrap_err().to_string();
    assert!(error.contains("Only local schema references are allowed"));
}
