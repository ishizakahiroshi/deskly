use super::*;
use serde_json::json;

pub const SOURCE: &str = "00000000-0000-0000-0000-000000000006";
pub const CONTACT: &str = "c-20261001-00000001";
pub const BODY: &str = "合成の非公開本文";
pub const PRIVATE: &str = "合成の機微な内容";

pub fn record() -> Value {
    let mut contact = serde_json::Map::new();
    let schema: Value =
        serde_json::from_str(include_str!("../../../../../schema/contact.schema.json")).unwrap();
    for key in schema["properties"].as_object().unwrap().keys() {
        contact.insert(key.clone(), json!(""));
    }
    contact.insert("id".into(), json!(CONTACT));
    contact.insert("state".into(), json!("下書き"));
    contact.insert("state_inferred".into(), json!(false));
    contact.insert("extra".into(), json!({"synthetic":PRIVATE}));
    for field in [
        "promise",
        "agreement",
        "sensitive",
        "basis",
        "note",
        "references",
        "shared_url",
        "source_path",
        "source_hash",
    ] {
        contact.insert(field.into(), json!(PRIVATE));
    }
    contact.insert("body".into(), json!(BODY));
    contact.insert("project".into(), json!("合成案件"));
    contact.insert("recipient".into(), json!("合成担当"));
    contact.insert("created_at".into(), json!("2026-10-01T00:00:00Z"));
    contact.insert("updated_at".into(), json!("2026-10-01T00:00:00Z"));
    json!({"workspace_id":WORKSPACE,"source_id":SOURCE,"version":1,"contact":contact})
}
pub fn waiting() -> Value {
    json!({"items":[{"project":"合成案件","turn":"こちら","due":null,"overdue":false,
        "states":["下書き"],"summaries":[BODY],"contact_ids":[CONTACT],"count":1,"ledger_names":[],"contact_refs":[CONTACT]}]})
}
pub fn history() -> Value {
    let mut after = record();
    after["version"] = json!(2);
    after["contact"]["state"] = json!("回答待ち");
    json!({"events":[{"operation_id":ITEM,"workspace_id":WORKSPACE,"source_id":SOURCE,"contact_id":CONTACT,
        "requester_member_id":MEMBER,"route":"shared-cli","reason":PRIVATE,"at_utc":"2026-10-01T00:00:01Z",
        "changes":[{"field":"body","before_present":true,"after_present":true,"before":BODY,"after":PRIVATE},
            {"field":"extra","before_present":true,"after_present":true,"before":{},"after":{"body":BODY}},
            {"field":"state","before_present":true,"after_present":true,"before":"下書き","after":"回答待ち"}],
        "before":record(),"after":after,"request_hash":"b".repeat(64)}]})
}
pub fn preview(request: &Value) -> Value {
    let mut request = request.clone();
    let mut after = record();
    let action = request["action"].as_str().unwrap().to_owned();
    let before = if action == "add_draft" {
        Value::Null
    } else {
        after.clone()
    };
    if request["contact_id"].is_null() {
        request["contact_id"] = json!(CONTACT);
    }
    after["contact"]["id"] = request["contact_id"].clone();
    if action == "add_draft" {
        for (key, value) in after["contact"].as_object_mut().unwrap() {
            if !["id", "state", "created_at", "updated_at"].contains(&key.as_str()) {
                *value = match value {
                    Value::Bool(_) => json!(false),
                    Value::Object(_) => json!({}),
                    _ => json!(""),
                };
            }
        }
        for (key, value) in request["data"].as_object().unwrap() {
            after["contact"][key] = value.clone();
        }
    } else if action == "set_state" {
        after["contact"]["state"] = request["data"]["state"].clone();
    } else {
        after["contact"]["state"] = json!("対応中");
        let note = after["contact"]["note"].as_str().unwrap();
        after["contact"]["note"] = json!(format!(
            "{note}\n返信要約: {}",
            request["data"]["summary"].as_str().unwrap()
        ));
    }
    if !before.is_null() && after["contact"] != before["contact"] {
        after["version"] = json!(2);
        after["contact"]["updated_at"] = json!("2026-10-01T00:00:01Z");
    }
    json!({"request":request,"before":before,"after":after,"preview_token":"a".repeat(64)})
}
pub fn response(request: &Request, saved: &mut Value) -> Response {
    assert_eq!(request.headers["authorization"], format!("Bearer {TOKEN}"));
    if request.path.ends_with("/commands/preview") {
        assert_eq!(request.method, "POST");
        assert_eq!(
            request.headers["origin"],
            format!("http://{}", request.headers["host"])
        );
        *saved = preview(request.body.as_ref().unwrap());
        let _: deskly_types::ContactActionPreview = serde_json::from_value(saved.clone()).unwrap();
        Response::json(200, saved.clone())
    } else if request.path.ends_with("/commands/apply") {
        assert_eq!(request.method, "POST");
        assert_eq!(
            request.body.as_ref().unwrap(),
            saved,
            "apply must send the exact unredacted preview"
        );
        Response::json(200, saved["after"].clone())
    } else {
        assert_eq!(request.method, "GET");
        let result = if request.path.contains("/waiting?") {
            assert!(request.path.contains("include_summaries=false"));
            waiting()
        } else if request.path.ends_with("/body") {
            json!({"body":BODY})
        } else if request.path.ends_with("/history") {
            history()
        } else if request.path.ends_with(CONTACT) {
            record()
        } else {
            json!({"items":[record()]})
        };
        Response::json(200, result)
    }
}
pub fn server() -> MockServer {
    let mut saved = Value::Null;
    MockServer::new(move |request| response(request, &mut saved))
}
pub fn assert_private_absent(value: &Value) {
    let text = value.to_string();
    assert!(!text.contains(BODY), "body leaked: {text}");
    assert!(!text.contains(PRIVATE), "private content leaked: {text}");
    assert!(!text.contains(TOKEN), "token leaked");
    assert!(!text.contains("\"body\""));
    assert!(!text.contains("\"sensitive\""));
    assert!(!text.contains("\"source_path\""));
}
