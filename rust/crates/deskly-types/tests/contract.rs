use deskly_types::{Account, Contact, Event, Membership, Milestone, Project, WorkItem, Workspace};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};

fn round_trip<T: DeserializeOwned + Serialize>(original: Value) {
    let decoded: T =
        serde_json::from_value(original.clone()).expect("contract fixture must decode");
    assert_eq!(serde_json::to_value(decoded).unwrap(), original);
}

macro_rules! fixture_test {
    ($test:ident, $type:ty, $file:literal) => {
        #[test]
        fn $test() {
            round_trip::<$type>(serde_json::from_str(include_str!($file)).unwrap());
        }
    };
}
fixture_test!(workspace_round_trip, Workspace, "fixtures/workspace.json");
fixture_test!(project_round_trip, Project, "fixtures/project.json");
fixture_test!(milestone_round_trip, Milestone, "fixtures/milestone.json");
fixture_test!(work_item_round_trip, WorkItem, "fixtures/work_item.json");
fixture_test!(contact_round_trip, Contact, "fixtures/contact.json");
fixture_test!(event_round_trip, Event, "fixtures/event.json");
fixture_test!(account_round_trip, Account, "fixtures/account.json");
fixture_test!(
    membership_round_trip,
    Membership,
    "fixtures/membership.json"
);

fn check_vocabulary<T: DeserializeOwned + Serialize>(fixture: &str, key: &str, definition: &str) {
    let common: Value =
        serde_json::from_str(include_str!("../../../../schema/common.schema.json")).unwrap();
    let fixture: Value = serde_json::from_str(fixture).unwrap();
    let allowed = common["$defs"][definition]["enum"].as_array().unwrap();
    for value in allowed {
        let mut input = fixture.clone();
        input[key] = value.clone();
        round_trip::<T>(input);
    }
    for invalid in [
        json!("未着手"),
        json!("invalid"),
        json!(""),
        json!(null),
        json!(0),
        json!(true),
        json!([]),
    ] {
        let mut input = fixture.clone();
        input[key] = invalid.clone();
        assert!(
            serde_json::from_value::<T>(input).is_err(),
            "accepted {definition}: {invalid}"
        );
    }
    // Every valid word from another vocabulary is rejected when not in this one.
    for other in ["contact_state", "project_state", "item_state", "work_kind"] {
        for value in common["$defs"][other]["enum"].as_array().unwrap() {
            if !allowed.contains(value) {
                let mut input = fixture.clone();
                input[key] = value.clone();
                assert!(serde_json::from_value::<T>(input).is_err());
            }
        }
    }
}

#[test]
fn exact_japanese_vocabularies() {
    check_vocabulary::<Contact>(
        include_str!("fixtures/contact.json"),
        "state",
        "contact_state",
    );
    check_vocabulary::<Project>(
        include_str!("fixtures/project.json"),
        "state",
        "project_state",
    );
    check_vocabulary::<Milestone>(
        include_str!("fixtures/milestone.json"),
        "state",
        "item_state",
    );
    check_vocabulary::<WorkItem>(
        include_str!("fixtures/work_item.json"),
        "state",
        "item_state",
    );
    check_vocabulary::<WorkItem>(include_str!("fixtures/work_item.json"), "kind", "work_kind");
}

#[test]
fn preserve_revoked_grant_and_empty_relationships() {
    let mut grant: Value = serde_json::from_str(include_str!("fixtures/membership.json")).unwrap();
    grant["role"] = Value::Null;
    round_trip::<Membership>(grant);
    let mut work: Value = serde_json::from_str(include_str!("fixtures/work_item.json")).unwrap();
    work["check_date"] = "2026-01-02".into();
    round_trip::<WorkItem>(work);
}

#[test]
fn preserve_optional_projections_and_nested_history() {
    let mut project: Value = serde_json::from_str(include_str!("fixtures/project.json")).unwrap();
    project["next_action"] = "合成確認".into();
    project["unconfirmed_count"] = 2.into();
    round_trip::<Project>(project);
    let mut event: Value = serde_json::from_str(include_str!("fixtures/event.json")).unwrap();
    event["before"] = event["after"].clone();
    event["changes"] = json!([]);
    round_trip::<Event>(event);
}

#[test]
fn reject_unknown_fields() {
    let mut contact: Value = serde_json::from_str(include_str!("fixtures/contact.json")).unwrap();
    contact["unexpected"] = true.into();
    assert!(serde_json::from_value::<Contact>(contact).is_err());
}

#[test]
fn preserve_large_integers_in_audit_values() {
    use deskly_types::JsonValue;
    round_trip::<JsonValue>(
        json!({"integer": 9_007_199_254_740_993_u64, "fraction": 1.25, "nested": [null, true, "合成"]}),
    );
}

#[test]
fn reject_wrong_discriminators_and_nested_status() {
    let mut project: Value = serde_json::from_str(include_str!("fixtures/project.json")).unwrap();
    project["type"] = "milestone".into();
    assert!(serde_json::from_value::<Project>(project).is_err());
    let mut event: Value = serde_json::from_str(include_str!("fixtures/event.json")).unwrap();
    event["after"]["state"] = "完了".into();
    assert!(serde_json::from_value::<Event>(event).is_err());
    let mut membership: Value =
        serde_json::from_str(include_str!("fixtures/membership.json")).unwrap();
    membership["scope"] = "workspace".into();
    assert!(serde_json::from_value::<Membership>(membership).is_err());
}

#[test]
fn reject_invalid_dates_and_relationship_ids() {
    let input: Value = serde_json::from_str(include_str!("fixtures/work_item.json")).unwrap();
    for (field, value) in [
        ("check_date", "2026-02-30"),
        ("check_date", "not-a-date"),
        ("milestone_id", "not-an-id"),
    ] {
        let mut work = input.clone();
        work[field] = value.into();
        assert!(serde_json::from_value::<WorkItem>(work).is_err());
    }
}

#[test]
fn preserve_access_history_null_versus_absent_role() {
    use deskly_types::AccessSnapshot;
    for snapshot in [
        json!({"role": null, "version": 2}),
        json!({"version": 2}),
        json!({"role": "viewer", "version": 1}),
    ] {
        round_trip::<AccessSnapshot>(snapshot.clone());
        let entity: Value = serde_json::from_str(include_str!("fixtures/event.json")).unwrap();
        let mut access = entity.clone();
        let object = access.as_object_mut().unwrap();
        object.remove("entity_id");
        object.remove("member_id");
        access["event_kind"] = "access".into();
        access["actor_member_id"] = entity["member_id"].clone();
        access["target_id"] = entity["entity_id"].clone();
        access["target_type"] = "project_role".into();
        access["before"] = json!({"role": "editor", "version": 1});
        access["after"] = snapshot;
        access["changes"] = json!([]);
        round_trip::<Event>(access);
    }
}

#[test]
fn preserve_optional_empty_arrays() {
    use deskly_types::EventAuditFields;
    round_trip::<EventAuditFields>(json!({"changes": []}));
    round_trip::<EventAuditFields>(json!({}));
}

#[test]
fn preserve_timestamp_spelling_and_precision() {
    use deskly_types::UtcTimestamp;
    for timestamp in [
        "2026-01-01T00:00:00.1000Z",
        "2026-01-01T00:00:00.1234567891Z",
    ] {
        round_trip::<UtcTimestamp>(json!(timestamp));
    }
}

#[test]
fn reject_noncanonical_wire_strings_and_optional_nulls() {
    use deskly_types::{StableId, UtcTimestamp};
    for id in [
        "00000000000000000000000000000001",
        "AAAAAAAA-0000-0000-0000-000000000001",
    ] {
        assert!(serde_json::from_value::<StableId>(json!(id)).is_err());
    }
    assert!(serde_json::from_value::<UtcTimestamp>(json!("2026-01-01T00:00:00+01:00")).is_err());
    let mut work: Value = serde_json::from_str(include_str!("fixtures/work_item.json")).unwrap();
    work["check_date"] = "2026-1-01".into();
    assert!(serde_json::from_value::<WorkItem>(work).is_err());
    let mut project: Value = serde_json::from_str(include_str!("fixtures/project.json")).unwrap();
    project["next_action"] = Value::Null;
    assert!(serde_json::from_value::<Project>(project).is_err());
}

#[test]
fn helper_snapshot_preserves_both_union_families() {
    use deskly_types::EventSnapshot;
    round_trip::<EventSnapshot>(
        serde_json::from_str(include_str!("fixtures/project.json")).unwrap(),
    );
    round_trip::<EventSnapshot>(json!({"role": null, "version": 2}));
}
