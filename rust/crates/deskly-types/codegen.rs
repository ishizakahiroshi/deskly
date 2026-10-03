//! Deterministically bundle local schema references for typify. No domain types
//! or vocabularies are defined here: every definition comes from schema/.
use std::collections::BTreeMap;
use std::error::Error;
use std::path::Path;

use quote::ToTokens;
use serde_json::{Map, Value};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
type Documents = BTreeMap<String, Value>;
type Names = BTreeMap<(String, String), String>;

fn type_name(value: &str) -> String {
    value
        .split('_')
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect()
}

fn reference(reference: &str, current: &str) -> Result<(String, String)> {
    let (file, pointer) = reference.split_once('#').unwrap_or((reference, ""));
    let file = if file.is_empty() { current } else { file };
    let file = file.strip_prefix("./").unwrap_or(file);
    if file.contains('/')
        || file.contains('\\')
        || !(file.ends_with(".schema.json") || file == "openapi.json")
    {
        return Err(format!("Only local schema references are allowed: {reference}").into());
    }
    Ok((file.into(), pointer.into()))
}

fn located<'a>(
    value: &'a Value,
    file: &'a str,
    docs: &'a Documents,
) -> Result<(&'a Value, &'a str)> {
    if let Some(reference_value) = value.get("$ref").and_then(Value::as_str) {
        let target = reference(reference_value, file)?;
        let (filename, document) = docs.get_key_value(&target.0).ok_or("Unknown schema file")?;
        located(
            document
                .pointer(&target.1)
                .ok_or("Unknown schema pointer")?,
            filename,
            docs,
        )
    } else {
        Ok((value, file))
    }
}

// Prove disjointness before handing anyOf to typify as a Rust enum. Do not
// turn an overlapping JSON Schema union into an exclusive union by assumption.
fn disjoint(
    left: &Value,
    left_file: &str,
    right: &Value,
    right_file: &str,
    docs: &Documents,
) -> Result<bool> {
    let (left, left_file) = located(left, left_file, docs)?;
    let (right, right_file) = located(right, right_file, docs)?;
    for keyword in ["anyOf", "oneOf"] {
        if let Some(branches) = left.get(keyword).and_then(Value::as_array) {
            for branch in branches {
                if !disjoint(branch, left_file, right, right_file, docs)? {
                    return Ok(false);
                }
            }
            return Ok(true);
        }
        if let Some(branches) = right.get(keyword).and_then(Value::as_array) {
            for branch in branches {
                if !disjoint(left, left_file, branch, right_file, docs)? {
                    return Ok(false);
                }
            }
            return Ok(true);
        }
    }
    if let (Some(a), Some(b)) = (
        left.get("type").and_then(Value::as_str),
        right.get("type").and_then(Value::as_str),
    ) {
        if a != b && !matches!((a, b), ("integer", "number") | ("number", "integer")) {
            return Ok(true);
        }
    }
    for (a, b) in [(left, right), (right, left)] {
        if let (Some(constant), Some(pattern)) = (
            a.get("const").and_then(Value::as_str),
            b.get("pattern").and_then(Value::as_str),
        ) {
            if regress::Regex::new(pattern)?.find(constant).is_none() {
                return Ok(true);
            }
        }
        if let (Some(required), Some(properties)) = (
            a.get("required").and_then(Value::as_array),
            b.get("properties").and_then(Value::as_object),
        ) {
            if b.get("additionalProperties") == Some(&Value::Bool(false))
                && required
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|key| !properties.contains_key(key))
            {
                return Ok(true);
            }
            for key in required.iter().filter_map(Value::as_str) {
                if let (Some(a), Some(b)) = (
                    a.get("properties")
                        .and_then(|properties| properties.get(key))
                        .and_then(|value| value.get("const")),
                    properties.get(key).and_then(|value| value.get("const")),
                ) {
                    if a != b {
                        return Ok(true);
                    }
                }
            }
        }
    }
    Ok(false)
}

fn normalize(value: &Value, file: &str, docs: &Documents, names: &Names) -> Result<Value> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| normalize(item, file, docs, names))
            .collect::<Result<Vec<_>>>()
            .map(Value::Array),
        Value::Object(object) => {
            let mut output = Map::new();
            for (key, item) in object {
                // This is a type projection, not a full JSON Schema validator.
                // Conditional constraints remain in the unmodified source schema.
                if matches!(
                    key.as_str(),
                    "$id" | "$schema" | "$defs" | "if" | "then" | "else"
                ) {
                    continue;
                }
                if key == "$ref" {
                    let target = reference(item.as_str().ok_or("$ref must be a string")?, file)?;
                    if let Some(name) = names.get(&target) {
                        output.insert(key.clone(), format!("#/definitions/{name}").into());
                    } else {
                        let source = docs.get(&target.0).ok_or("Unknown schema file")?;
                        let source = source.pointer(&target.1).ok_or("Unknown schema pointer")?;
                        let resolved = normalize(source, &target.0, docs, names)?;
                        let resolved = resolved
                            .as_object()
                            .ok_or("Reference must target a schema")?;
                        output.extend(resolved.clone());
                    }
                } else {
                    output.insert(key.clone(), normalize(item, file, docs, names)?);
                }
            }
            if let Some(branches) = object.get("anyOf").and_then(Value::as_array) {
                let mut exclusive = branches.len() > 1;
                for (index, left) in branches.iter().enumerate() {
                    for right in &branches[index + 1..] {
                        exclusive &= disjoint(left, file, right, file, docs)?;
                    }
                }
                if exclusive {
                    let union = output.remove("anyOf").ok_or("Missing union")?;
                    output.insert("oneOf".into(), union);
                }
            }
            // schemars/typify need an explicit enum for Draft 2020-12 const.
            if let Some(constant) = output.remove("const") {
                if constant.is_string() {
                    output.insert("type".into(), "string".into());
                }
                output.insert("enum".into(), Value::Array(vec![constant]));
            }
            Ok(Value::Object(output))
        }
        _ => Ok(value.clone()),
    }
}

fn hoist_nullable_enums(
    value: &mut Value,
    path: &str,
    definitions: &mut BTreeMap<String, schemars::schema::Schema>,
) -> Result<()> {
    if let Some(values) = value.get("enum").and_then(Value::as_array) {
        if values.iter().any(Value::is_null)
            && values
                .iter()
                .all(|value| value.is_null() || value.is_string())
        {
            let inner_name = format!("{path}Value");
            let values: Vec<_> = values
                .iter()
                .filter(|value| !value.is_null())
                .cloned()
                .collect();
            let inner = serde_json::json!({"title": inner_name, "type": "string", "enum": values});
            let wrapper = serde_json::json!({"anyOf": [{"$ref": format!("#/definitions/{inner_name}")}, {"type": "null"}]});
            for (name, schema) in [(inner_name, inner), (path.into(), wrapper)] {
                if definitions
                    .insert(name.clone(), serde_json::from_value(schema)?)
                    .is_some()
                {
                    return Err(format!("Duplicate generated type name: {name}").into());
                }
            }
            // A named wrapper distinguishes an absent property from a present
            // JSON null, which Option<Enum> plus skip_serializing_if cannot do.
            *value = serde_json::json!({"$ref": format!("#/definitions/{path}")});
            return Ok(());
        }
    }
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                hoist_nullable_enums(value, &format!("{path}{}", type_name(key)), definitions)?;
            }
        }
        Value::Array(array) => {
            for (index, value) in array.iter_mut().enumerate() {
                hoist_nullable_enums(value, &format!("{path}{index}"), definitions)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn preserve_formats(
    value: &mut Value,
    path: &str,
    formats: &mut BTreeMap<String, String>,
) -> Result<()> {
    if let Some(format) = value.get("format").and_then(Value::as_str) {
        if matches!(format, "uuid" | "date" | "date-time") {
            let format = format.to_string();
            let name = value
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or(path)
                .to_string();
            let object = value
                .as_object_mut()
                .ok_or("Format schema must be an object")?;
            object.remove("format");
            object.insert("title".into(), name.clone().into());
            formats.insert(name, format);
        }
    }
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                preserve_formats(value, &format!("{path}{}", type_name(key)), formats)?;
            }
        }
        Value::Array(array) => {
            for (index, value) in array.iter_mut().enumerate() {
                preserve_formats(value, &format!("{path}{index}"), formats)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn generate(directory: &Path) -> Result<String> {
    let mut docs = Documents::new();
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        let filename = path
            .file_name()
            .ok_or("Missing schema filename")?
            .to_str()
            .ok_or("Non-UTF-8 schema filename")?;
        if filename.ends_with(".schema.json") || filename == "openapi.json" {
            docs.insert(
                filename.into(),
                serde_json::from_slice(&std::fs::read(&path)?)?,
            );
        }
    }
    let mut names = Names::new();
    for (file, schema) in &docs {
        if file == "openapi.json" {
            continue;
        }
        let title = schema["title"].as_str().ok_or("Schema title is required")?;
        if schema.get("type").is_some() || schema.get("oneOf").is_some() {
            names.insert((file.clone(), String::new()), title.into());
        }
        if let Some(defs) = schema["$defs"].as_object() {
            for (key, definition) in defs {
                let name = definition["title"]
                    .as_str()
                    .map(String::from)
                    .unwrap_or_else(|| {
                        if file == "common.schema.json" {
                            type_name(key)
                        } else {
                            format!("{title}{}", type_name(key))
                        }
                    });
                names.insert((file.clone(), format!("/$defs/{key}")), name);
            }
        }
    }
    // OpenAPI 3.1 components use the same local JSON Schema definitions.
    // Register component aliases against their existing canonical type instead
    // of creating a second Project/Workspace/etc. definition.
    let mut aliases = BTreeMap::new();
    if let Some(openapi) = docs.get("openapi.json") {
        let components = openapi
            .pointer("/components/schemas")
            .and_then(Value::as_object)
            .ok_or("OpenAPI components/schemas must be an object")?;
        for (name, schema) in components {
            let pointer = format!("/components/schemas/{name}");
            if let Some(target) = schema.get("$ref").and_then(Value::as_str) {
                let target = reference(target, "openapi.json")?;
                let canonical = names
                    .get(&target)
                    .ok_or("OpenAPI alias must refer to a named local schema")?
                    .clone();
                names.insert(("openapi.json".into(), pointer), canonical.clone());
                if name != &canonical {
                    aliases.insert(name.clone(), canonical);
                }
            } else {
                names.insert(("openapi.json".into(), pointer), name.clone());
            }
        }
    }
    let mut definitions = BTreeMap::new();
    let mut formats = BTreeMap::new();
    for ((file, pointer), name) in &names {
        let source = docs[file]
            .pointer(pointer)
            .ok_or("Missing named definition")?;
        if file == "openapi.json" && source.get("$ref").is_some() {
            continue;
        }
        let mut schema = normalize(source, file, &docs, &names)?;
        // Keep the nullable wrapper and its string enum distinct; typify 0.8.0
        // otherwise gives both the schema title and creates recursive types.
        if let Some(values) = source.get("enum").and_then(Value::as_array) {
            if values.iter().any(Value::is_null)
                && values
                    .iter()
                    .all(|value| value.is_null() || value.is_string())
            {
                let inner_name = format!("{name}Value");
                let values: Vec<_> = values
                    .iter()
                    .filter(|value| !value.is_null())
                    .cloned()
                    .collect();
                let inner =
                    serde_json::json!({"title": inner_name, "type": "string", "enum": values});
                definitions.insert(inner_name.clone(), serde_json::from_value(inner)?);
                schema = serde_json::json!({"anyOf": [{"$ref": format!("#/definitions/{inner_name}")}, {"type": "null"}]});
            }
        }
        // Hoist nested nullable enums too, preserving null versus absence in
        // optional access-history fields as well as required grants.
        if let Some(object) = schema.as_object_mut() {
            for (key, value) in object {
                hoist_nullable_enums(
                    value,
                    &format!("{name}{}", type_name(key)),
                    &mut definitions,
                )?;
            }
        }
        preserve_formats(&mut schema, name, &mut formats)?;
        if definitions
            .insert(
                name.clone(),
                serde_json::from_value::<schemars::schema::Schema>(schema)?,
            )
            .is_some()
        {
            return Err(format!("Duplicate generated type name: {name}").into());
        }
    }
    let mut settings = typify::TypeSpaceSettings::default();
    // Preserve integer JSON numbers in audit field values (f64 would turn 1
    // into 1.0 and lose integers above 2^53). This maps a primitive, not a
    // handwritten domain model or vocabulary.
    settings.with_conversion(
        serde_json::from_value(serde_json::json!({"type": "number"}))?,
        "::serde_json::Number",
        std::iter::empty(),
    );
    settings.with_map_type("::std::collections::BTreeMap");
    let mut types = typify::TypeSpace::new(&settings);
    types.add_ref_types(definitions)?;
    let mut syntax: syn::File = syn::parse2(types.to_stream())?;
    for (alias, canonical) in aliases {
        let alias = syn::parse_str::<syn::Ident>(&alias)?;
        let canonical = syn::parse_str::<syn::Ident>(&canonical)?;
        syntax
            .items
            .push(syn::parse_quote!(pub type #alias = #canonical;));
    }
    for item in &mut syntax.items {
        if let syn::Item::Struct(item) = item {
            for field in &mut item.fields {
                // Serde Option normally conflates a missing property and null.
                // For optional schema properties, deserialize present values into
                // the inner type first; its schema decides whether null is valid.
                let optional = field.attrs.iter().any(|attribute| {
                    attribute
                        .meta
                        .to_token_stream()
                        .to_string()
                        .contains("Option::is_none")
                });
                let optional_collection = field.attrs.iter().any(|attribute| {
                    attribute
                        .meta
                        .to_token_stream()
                        .to_string()
                        .contains("is_empty")
                });
                if optional || optional_collection {
                    if optional_collection {
                        let original = &field.ty;
                        field.ty = syn::parse_quote!(::std::option::Option<#original>);
                    }
                    // Preserve other serde metadata (e.g. wire names) while
                    // replacing only presence/default behavior.
                    for attribute in &mut field.attrs {
                        if attribute.path().is_ident("serde") {
                            let entries = attribute.parse_args_with(syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated)?;
                            let kept: syn::punctuated::Punctuated<syn::Meta, syn::Token![,]> =
                                entries
                                    .into_iter()
                                    .filter(|entry| {
                                        !entry.path().is_ident("default")
                                            && !entry.path().is_ident("skip_serializing_if")
                                    })
                                    .collect();
                            if let syn::Meta::List(list) = &mut attribute.meta {
                                list.tokens = quote::quote!(#kept);
                            }
                        }
                    }
                    field.attrs.retain(|attribute| !matches!(&attribute.meta, syn::Meta::List(list) if list.path.is_ident("serde") && list.tokens.is_empty()));
                    field.attrs.push(syn::parse_quote!(#[serde(default, skip_serializing_if = "::std::option::Option::is_none", deserialize_with = "crate::deserialize_present")]));
                }
            }
        }
        if let syn::Item::Enum(item) = item {
            for variant in &mut item.variants {
                let wire_name = variant.ident.to_string();
                // Rust permits Japanese identifiers; make their wire spelling
                // explicit without maintaining an English translation table.
                if !wire_name.is_ascii() {
                    variant
                        .attrs
                        .push(syn::parse_quote!(#[serde(rename = #wire_name)]));
                }
            }
        }
    }
    let mut guarded = std::collections::BTreeSet::new();
    for item in &mut syntax.items {
        if let syn::Item::Impl(item) = item {
            let from_str = item.trait_.as_ref().is_some_and(|(_, path, _)| {
                path.segments
                    .last()
                    .is_some_and(|segment| segment.ident == "FromStr")
            });
            if !from_str {
                continue;
            }
            let syn::Type::Path(path) = item.self_ty.as_ref() else {
                continue;
            };
            let Some(name) = path
                .path
                .segments
                .last()
                .map(|segment| segment.ident.to_string())
            else {
                continue;
            };
            let Some(format) = formats.get(&name) else {
                continue;
            };
            for method in &mut item.items {
                if let syn::ImplItem::Fn(method) = method {
                    if method.sig.ident == "from_str" {
                        let guard = match format.as_str() {
                            "uuid" => {
                                syn::parse_quote! { ::uuid::Uuid::parse_str(value).map_err(|_| "invalid UUID")?; }
                            }
                            "date" => {
                                syn::parse_quote! { ::chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| "invalid calendar date")?; }
                            }
                            "date-time" => {
                                syn::parse_quote! { ::chrono::DateTime::parse_from_rfc3339(value).map_err(|_| "invalid RFC 3339 timestamp")?; }
                            }
                            _ => unreachable!(),
                        };
                        method.block.stmts.insert(0, guard);
                        guarded.insert(name.clone());
                    }
                }
            }
        }
    }
    if formats.keys().any(|name| !guarded.contains(name)) {
        return Err(format!(
            "Format validation missing for {:?}",
            formats
                .keys()
                .filter(|name| !guarded.contains(*name))
                .collect::<Vec<_>>()
        )
        .into());
    }
    Ok(format!(
        "// Generated from schema/*.schema.json and schema/openapi.json by typify 0.8.0. Do not edit.\n{}\n",
        prettyplease::unparse(&syntax)
    ))
}
