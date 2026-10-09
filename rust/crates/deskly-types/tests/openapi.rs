use deskly_types::{
    CommandPreview, CommandRequest, CommandResult, Conflict, Error, EventCollection,
    MembershipCollection, MilestoneCollection, ProjectCollection, WorkItemCollection,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Map, Value};

fn round_trip<T: DeserializeOwned + Serialize>(original: Value) {
    let decoded: T = serde_json::from_value(original.clone()).expect("OpenAPI fixture must decode");
    assert_eq!(serde_json::to_value(decoded).unwrap(), original);
}

fn entities() -> [(&'static str, Value, Value); 3] {
    [
        (
            "project",
            serde_json::from_str(include_str!("fixtures/project.json")).unwrap(),
            serde_json::from_str(include_str!("../../../../schema/project.schema.json")).unwrap(),
        ),
        (
            "milestone",
            serde_json::from_str(include_str!("fixtures/milestone.json")).unwrap(),
            serde_json::from_str(include_str!("../../../../schema/milestone.schema.json")).unwrap(),
        ),
        (
            "work_item",
            serde_json::from_str(include_str!("fixtures/work_item.json")).unwrap(),
            serde_json::from_str(include_str!("../../../../schema/work_item.schema.json")).unwrap(),
        ),
    ]
}

#[test]
fn all_command_requests_and_previews_preserve_the_contract() {
    for (kind, original, schema) in entities() {
        for action in ["create", "update", "archive", "restore"] {
            let data = if matches!(action, "create" | "update") {
                Value::Object(
                    schema["$defs"]["data"]["properties"]
                        .as_object()
                        .unwrap()
                        .keys()
                        .map(|key| (key.clone(), original[key].clone()))
                        .collect::<Map<_, _>>(),
                )
            } else {
                Value::Null
            };
            let mut request = json!({
                "operation_id": "00000000-0000-0000-0000-000000000006",
                "action": action,
                "type": kind,
                "id": if action == "create" { Value::Null } else { original["id"].clone() },
                "project_id": original["project_id"],
                "expected_version": if action == "create" { Value::Null } else { json!(1) },
                "data": data,
                "reason": "合成の確認"
            });
            round_trip::<CommandRequest>(request.clone());
            request["id"] = original["id"].clone();
            round_trip::<CommandRequest>(request.clone());
            let before = if action == "create" {
                Value::Null
            } else {
                let mut before = original.clone();
                before["archived"] = json!(action == "restore");
                before
            };
            let mut after = original.clone();
            after["version"] = json!(if action == "create" { 1 } else { 2 });
            after["archived"] = json!(action == "archive");
            round_trip::<CommandPreview>(json!({
                "request": request,
                "before": before,
                "after": after,
                "preview_token": "0".repeat(64)
            }));
            round_trip::<CommandResult>(original.clone());
        }
    }
}

#[test]
fn collection_envelopes_preserve_empty_and_populated_arrays() {
    let project: Value = serde_json::from_str(include_str!("fixtures/project.json")).unwrap();
    let milestone: Value = serde_json::from_str(include_str!("fixtures/milestone.json")).unwrap();
    let work_item: Value = serde_json::from_str(include_str!("fixtures/work_item.json")).unwrap();
    let event: Value = serde_json::from_str(include_str!("fixtures/event.json")).unwrap();
    let membership: Value = serde_json::from_str(include_str!("fixtures/membership.json")).unwrap();
    for populated in [false, true] {
        let records = |value: &Value| if populated { json!([value]) } else { json!([]) };
        round_trip::<ProjectCollection>(
            json!({"projects": records(&project), "archived_projects": []}),
        );
        round_trip::<MilestoneCollection>(json!({"items": records(&milestone)}));
        round_trip::<WorkItemCollection>(json!({"items": records(&work_item)}));
        round_trip::<EventCollection>(json!({"events": records(&event)}));
        round_trip::<MembershipCollection>(json!({"memberships": records(&membership)}));
    }
}

#[test]
fn errors_are_generated_from_the_openapi_vocabulary() {
    round_trip::<Error>(json!({"error": "not_found"}));
    let schema: Value =
        serde_json::from_str(include_str!("../../../../schema/openapi.json")).unwrap();
    for code in schema["components"]["schemas"]["Conflict"]["properties"]["error"]["enum"]
        .as_array()
        .unwrap()
    {
        round_trip::<Conflict>(json!({"error": code}));
    }
    assert!(serde_json::from_value::<Conflict>(json!({"error": "unknown_conflict"})).is_err());
    assert!(serde_json::from_value::<Error>(json!({"error": ""})).is_err());
    assert!(
        serde_json::from_value::<Error>(json!({"error": "not_found", "extra": "hidden"})).is_err()
    );
}

#[test]
fn commands_reject_invalid_discriminators_and_versions() {
    let (kind, project, schema) = entities().into_iter().next().unwrap();
    let data: Map<_, _> = schema["$defs"]["data"]["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(|key| (key.clone(), project[key].clone()))
        .collect();
    let request = json!({
        "operation_id": "00000000-0000-0000-0000-000000000006", "action": "update", "type": kind,
        "id": project["id"], "project_id": null, "expected_version": 1, "data": data, "reason": "合成の確認"
    });
    for (field, bad) in [
        ("action", json!("send")),
        ("type", json!("contact")),
        ("expected_version", json!(0)),
        ("expected_version", Value::Null),
    ] {
        let mut invalid = request.clone();
        invalid[field] = bad;
        assert!(serde_json::from_value::<CommandRequest>(invalid).is_err());
    }
}
