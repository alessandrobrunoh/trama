//! Versioned demo fixture export of the NestJS seed. Not called from startup until its
//! database behavior has been verified against the migration baseline.

use chrono::{DateTime, Duration, Utc};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, DbErr, EntityTrait, PaginatorTrait,
    Statement, TransactionTrait,
};
use serde_json::{Map, Value, json};

const FIXTURE: &str = include_str!("../fixtures/demo-seed-v1.json");
const DEMO_PASSWORD: &str = "trama-demo";

/// Validated, credential-free canonical Nest seed.
pub fn fixture() -> Result<Value, serde_json::Error> {
    serde_json::from_str(FIXTURE)
}

/// Load the canonical demo fixture transactionally. The demo password is hashed at runtime;
/// no password or PHC hash is stored in the fixture.
///
/// # Errors
///
/// Returns a validation, hashing, or database error without leaving partial rows.
pub async fn load(
    db: &DatabaseConnection,
    mock_history: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let fixture = fixture()?;
    validate(&fixture)?;
    let password_hash = trama_auth::service::hash_password(DEMO_PASSWORD).await?;
    let now = Utc::now();
    let anchor = DateTime::parse_from_rfc3339(
        fixture["fixtureTime"].as_str().ok_or("fixtureTime is missing")?,
    )?
    .with_timezone(&Utc);
    let delta = now.signed_duration_since(anchor);
    let txn = db.begin().await?;

    let data_key = if mock_history { "data" } else { "withoutMockHistory" };
    let data = fixture[data_key].as_object().ok_or("fixture seed data must be an object")?;
    let workspace = rebase(data.get("workspace").ok_or("workspace is missing")?, delta);
    let mut users = data["users"].as_array().ok_or("users must be an array")?.clone();
    for row in &mut users {
        row.as_object_mut()
            .ok_or("user row must be an object")?
            .insert("passwordHash".into(), Value::String(password_hash.clone()));
    }
    for row in users {
        insert_row(&txn, "users", &rebase(&row, delta)).await?;
    }
    insert_row(&txn, "workspaces", &workspace).await?;

    for (group, table) in [
        ("memberships", "memberships"),
        ("agents", "agents"),
        ("projects", "projects"),
        ("milestones", "milestones"),
        ("issues", "issues"),
        ("artifacts", "artifacts"),
        ("threadRecords", "task_thread_records"),
        ("decisions", "task_decisions"),
        ("dependencies", "dependencies"),
        ("comments", "comments"),
    ] {
        for row in rows(data, group, mock_history)? {
            insert_row(&txn, table, &rebase(row, delta)).await?;
        }
    }
    for row in data["legacyWorkstreams"].as_array().ok_or("legacyWorkstreams must be an array")? {
        insert_row(&txn, "legacy_workstream_history", row).await?;
    }
    for row in rows(data, "events", mock_history)? {
        insert_row(&txn, "domain_events", &rebase(row, delta)).await?;
    }
    for row in rows(data, "views", mock_history)? {
        insert_row(&txn, "saved_views", &rebase(row, delta)).await?;
    }
    for row in rows(data, "integrations", mock_history)? {
        insert_row(&txn, "integration_connections", &rebase(row, delta)).await?;
    }
    let workspace_id = workspace["id"].as_str().ok_or("workspace id is missing")?;
    for (name, value) in data["counters"].as_object().ok_or("counters must be an object")? {
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"INSERT INTO "workspace_counters" ("workspaceId","name","value") VALUES ($1,$2,$3)"#,
            vec![
                workspace_id.into(),
                name.clone().into(),
                value.as_i64().ok_or("counter must be an integer")?.into(),
            ],
        ))
        .await?;
    }
    txn.commit().await?;
    Ok(())
}

/// Apply the startup guard without wiring it into the server yet.
///
/// Returns `true` only when the empty database was seeded. Production and explicitly disabled
/// seeding return `false`; a nonempty database is always left unchanged.
pub async fn seed_if_empty(
    db: &DatabaseConnection,
    enabled: bool,
    production: bool,
    mock_history: bool,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    if !enabled || production || trama_entities::users::Entity::find().count(db).await? != 0 {
        return Ok(false);
    }
    load(db, mock_history).await?;
    Ok(true)
}

fn rows<'a>(
    data: &'a Map<String, Value>,
    group: &str,
    mock_history: bool,
) -> Result<Vec<&'a Value>, &'static str> {
    let rows = data.get(group).and_then(Value::as_array).ok_or("seed group must be an array")?;
    Ok(rows
        .iter()
        .filter(|row| {
            mock_history
                || !row.get("id").and_then(Value::as_str).is_some_and(|id| {
                    id.starts_with("ev_mock_")
                        || id.starts_with("in_mock_")
                        || id.starts_with("ms_mock_")
                })
        })
        .collect())
}

fn rebase(value: &Value, delta: Duration) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let shifted = if is_date_key(key) {
                        value
                            .as_str()
                            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                            .map(|d| Value::String((d + delta).to_rfc3339()))
                    } else {
                        None
                    };
                    (key.clone(), shifted.unwrap_or_else(|| rebase(value, delta)))
                })
                .collect(),
        ),
        Value::Array(values) => {
            Value::Array(values.iter().map(|value| rebase(value, delta)).collect())
        }
        _ => value.clone(),
    }
}

fn is_date_key(key: &str) -> bool {
    matches!(
        key,
        "at" | "createdAt"
            | "updatedAt"
            | "startDate"
            | "targetDate"
            | "completedAt"
            | "startedAt"
            | "dueDate"
            | "lastSyncAt"
    )
}

async fn insert_row<C: ConnectionTrait>(db: &C, table: &str, row: &Value) -> Result<(), DbErr> {
    let object =
        row.as_object().ok_or_else(|| DbErr::Custom("fixture row must be an object".into()))?;
    if object.is_empty() {
        return Err(DbErr::Custom("fixture row must not be empty".into()));
    }
    // These identifiers come from this versioned fixture; keep a strict identifier allowlist
    // anyway, so malformed fixture updates cannot become SQL.
    let mut columns: Vec<_> = object.keys().collect();
    columns.sort();
    if !identifier(table) || columns.iter().any(|column| !identifier(column)) {
        return Err(DbErr::Custom("invalid fixture table or column identifier".into()));
    }
    let columns_sql =
        columns.iter().map(|column| format!(r#""{column}""#)).collect::<Vec<_>>().join(",");
    let selected = columns
        .iter()
        .map(|column| format!(r#"(jsonb_populate_record(NULL::"{table}", $1::jsonb))."{column}""#))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(r#"INSERT INTO "{table}" ({columns_sql}) SELECT {selected}"#);
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        vec![sea_orm::Value::Json(Some(Box::new(row.clone())))],
    ))
    .await?;
    Ok(())
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn validate(fixture: &Value) -> Result<(), &'static str> {
    if fixture["version"] != json!(1) {
        return Err("unsupported fixture version");
    }
    if fixture.to_string().contains("passwordHash")
        || fixture.to_string().contains("RUNTIME_PASSWORD_HASH")
    {
        return Err("fixture must not contain credential material");
    }
    for key in ["data", "withoutMockHistory"] {
        let data = fixture[key].as_object().ok_or("fixture seed data must be an object")?;
        for required in [
            "users",
            "workspace",
            "memberships",
            "agents",
            "projects",
            "legacyWorkstreams",
            "milestones",
            "issues",
            "artifacts",
            "threadRecords",
            "decisions",
            "dependencies",
            "comments",
            "events",
            "views",
            "integrations",
            "counters",
        ] {
            if !data.contains_key(required) {
                return Err("fixture is missing a canonical seed group");
            }
        }
        validate_references(data)?;
    }
    Ok(())
}

fn validate_references(data: &Map<String, Value>) -> Result<(), &'static str> {
    let ids = |group: &str| -> Result<std::collections::HashSet<&str>, &'static str> {
        data[group]
            .as_array()
            .ok_or("canonical seed group must be an array")?
            .iter()
            .map(|row| row["id"].as_str().ok_or("seed row is missing its id"))
            .collect()
    };
    let workspace_id = data["workspace"]["id"].as_str().ok_or("workspace id is missing")?;
    let user_ids = ids("users")?;
    let agent_ids = ids("agents")?;
    let project_ids = ids("projects")?;
    let issue_ids = ids("issues")?;
    let milestone_ids = ids("milestones")?;
    if data["workspace"]["primaryOwnerId"].as_str().is_some_and(|id| !user_ids.contains(id)) {
        return Err("workspace owner refers to a missing user");
    }
    for group in [
        "memberships",
        "agents",
        "projects",
        "milestones",
        "issues",
        "artifacts",
        "threadRecords",
        "decisions",
        "comments",
        "events",
        "views",
    ] {
        for row in data[group].as_array().ok_or("canonical seed group must be an array")? {
            if row["workspaceId"].as_str().is_some_and(|id| id != workspace_id) {
                return Err("seed row references a different workspace");
            }
        }
    }
    for row in data["memberships"].as_array().ok_or("memberships must be an array")? {
        if !user_ids.contains(row["userId"].as_str().ok_or("membership userId missing")?) {
            return Err("membership refers to a missing user");
        }
    }
    for row in data["projects"].as_array().ok_or("projects must be an array")? {
        if row["leadId"].as_str().is_some_and(|id| !user_ids.contains(id)) {
            return Err("project lead refers to a missing user");
        }
    }
    for row in data["agents"].as_array().ok_or("agents must be an array")? {
        if row["ownerUserId"].as_str().is_some_and(|id| !user_ids.contains(id)) {
            return Err("agent owner refers to a missing user");
        }
    }
    for row in data["milestones"].as_array().ok_or("milestones must be an array")? {
        if !project_ids.contains(row["projectId"].as_str().ok_or("milestone projectId missing")?) {
            return Err("milestone refers to a missing project");
        }
    }
    for row in data["issues"].as_array().ok_or("issues must be an array")? {
        if row["projectId"].as_str().is_some_and(|id| !project_ids.contains(id)) {
            return Err("issue refers to a missing project");
        }
        for field in ["assigneeId", "reporterId"] {
            if row[field].as_str().is_some_and(|id| !user_ids.contains(id)) {
                return Err("issue user reference is missing");
            }
        }
        if row["parentId"].as_str().is_some_and(|id| !issue_ids.contains(id)) {
            return Err("issue parent refers to a missing issue");
        }
        if let Some(ids) = row["milestoneIds"].as_array() {
            if ids.iter().filter_map(Value::as_str).any(|id| !milestone_ids.contains(id)) {
                return Err("issue refers to a missing milestone");
            }
        }
    }
    for row in data["artifacts"].as_array().ok_or("artifacts must be an array")? {
        if row["issueId"].as_str().is_some_and(|id| !issue_ids.contains(id)) {
            return Err("artifact refers to a missing issue");
        }
        if row["authorRef"]["type"] == "user"
            && row["authorRef"]["id"].as_str().is_some_and(|id| !user_ids.contains(id))
        {
            return Err("artifact author refers to a missing user");
        }
        if row["authorRef"]["type"] == "agent"
            && row["authorRef"]["id"].as_str().is_some_and(|id| !agent_ids.contains(id))
        {
            return Err("artifact author refers to a missing agent");
        }
    }
    for group in ["threadRecords", "decisions"] {
        for row in data[group].as_array().ok_or("canonical seed group must be an array")? {
            if !issue_ids.contains(row["issueId"].as_str().ok_or("thread row issueId missing")?) {
                return Err("thread record or decision refers to a missing issue");
            }
            for actor in ["lastSyncBy", "createdBy"] {
                if row[actor]["type"] == "user"
                    && row[actor]["id"].as_str().is_some_and(|id| !user_ids.contains(id))
                {
                    return Err("thread row actor refers to a missing user");
                }
                if row[actor]["type"] == "agent"
                    && row[actor]["id"].as_str().is_some_and(|id| !agent_ids.contains(id))
                {
                    return Err("thread row actor refers to a missing agent");
                }
            }
        }
    }
    for row in data["comments"].as_array().ok_or("comments must be an array")? {
        if row["subject"]["type"] == "issue"
            && row["subject"]["id"].as_str().is_some_and(|id| !issue_ids.contains(id))
        {
            return Err("comment refers to a missing issue");
        }
        if row["author"]["type"] == "user"
            && row["author"]["id"].as_str().is_some_and(|id| !user_ids.contains(id))
        {
            return Err("comment author refers to a missing user");
        }
        if row["author"]["type"] == "agent"
            && row["author"]["id"].as_str().is_some_and(|id| !agent_ids.contains(id))
        {
            return Err("comment author refers to a missing agent");
        }
    }
    for row in data["events"].as_array().ok_or("events must be an array")? {
        for actor in ["actor"] {
            if row[actor]["type"] == "user"
                && row[actor]["id"].as_str().is_some_and(|id| !user_ids.contains(id))
            {
                return Err("event actor refers to a missing user");
            }
            if row[actor]["type"] == "agent"
                && row[actor]["id"].as_str().is_some_and(|id| !agent_ids.contains(id))
            {
                return Err("event actor refers to a missing agent");
            }
        }
    }
    for row in data["views"].as_array().ok_or("views must be an array")? {
        if row["ownerId"].as_str().is_some_and(|id| !user_ids.contains(id)) {
            return Err("saved view owner refers to a missing user");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::MigratorTrait;

    #[test]
    fn fixture_is_credential_free_and_has_full_seed_groups() {
        let fixture = fixture().expect("valid JSON");
        validate(&fixture).expect("canonical fixture");
        assert_eq!(fixture["data"]["users"].as_array().unwrap().len(), 6);
        assert!(fixture["data"]["issues"].as_array().unwrap().len() >= 40);
        assert!(fixture["data"]["events"].as_array().unwrap().len() >= 100);
        // the thread of AUTH-142 kept a record and two decisions
        for key in ["data", "withoutMockHistory"] {
            let records = fixture[key]["threadRecords"].as_array().unwrap();
            assert_eq!(records.len(), 1);
            assert_eq!(records[0]["syncCount"], 3);
            assert_eq!(fixture[key]["decisions"].as_array().unwrap().len(), 2);
        }
    }

    #[test]
    fn validation_refuses_thread_rows_of_a_missing_issue() {
        let mut orphan = super::fixture().expect("valid JSON");
        orphan["data"]["decisions"][0]["issueId"] = json!("in_missing");
        assert_eq!(validate(&orphan), Err("thread record or decision refers to a missing issue"));
        let mut stranger = super::fixture().expect("valid JSON");
        stranger["data"]["threadRecords"][0]["lastSyncBy"]["id"] = json!("ag_missing");
        assert_eq!(validate(&stranger), Err("thread row actor refers to a missing agent"));
    }

    #[test]
    fn timestamp_rebasing_preserves_age_and_does_not_change_other_fields() {
        let input = json!({"createdAt":"2026-01-01T00:00:00.000Z","name":"Acme"});
        let shifted = rebase(&input, Duration::days(4));
        assert_eq!(shifted["createdAt"], "2026-01-05T00:00:00+00:00");
        assert_eq!(shifted["name"], "Acme");
    }

    #[tokio::test]
    async fn postgres_load_and_startup_guards() {
        let Some(test_db) = trama_core::testkit::TestDb::create().await else {
            return;
        };
        trama_migration::Migrator::up(&test_db.db, None).await.expect("migrate throwaway db");
        assert!(!seed_if_empty(&test_db.db, false, false, true).await.unwrap());
        assert!(!seed_if_empty(&test_db.db, true, true, true).await.unwrap());
        assert!(seed_if_empty(&test_db.db, true, false, true).await.unwrap());
        assert!(!seed_if_empty(&test_db.db, true, false, true).await.unwrap());
        let fixture = fixture().unwrap();
        for (group, table) in [
            ("users", "users"),
            ("workspace", "workspaces"),
            ("memberships", "memberships"),
            ("agents", "agents"),
            ("projects", "projects"),
            ("legacyWorkstreams", "legacy_workstream_history"),
            ("milestones", "milestones"),
            ("issues", "issues"),
            ("artifacts", "artifacts"),
            ("threadRecords", "task_thread_records"),
            ("decisions", "task_decisions"),
            ("dependencies", "dependencies"),
            ("comments", "comments"),
            ("events", "domain_events"),
            ("views", "saved_views"),
            ("integrations", "integration_connections"),
            ("counters", "workspace_counters"),
        ] {
            let expected = if group == "workspace" {
                1
            } else {
                fixture["data"][group].as_object().map_or_else(
                    || fixture["data"][group].as_array().unwrap().len(),
                    serde_json::Map::len,
                )
            };
            let row = test_db
                .db
                .query_one_raw(Statement::from_string(
                    DatabaseBackend::Postgres,
                    format!(r#"SELECT COUNT(*)::bigint AS count FROM "{table}""#),
                ))
                .await
                .unwrap()
                .unwrap();
            let actual: i64 = row.try_get("", "count").unwrap();
            assert_eq!(actual as usize, expected, "unexpected row count in {table}");
        }
        let users = trama_entities::users::Entity::find().all(&test_db.db).await.unwrap();
        assert!(trama_auth::service::verify_password(&users[0].password_hash, DEMO_PASSWORD).await);
        test_db.drop().await;
    }

    #[tokio::test]
    async fn postgres_load_without_mock_history_uses_canonical_base_seed() {
        let Some(test_db) = trama_core::testkit::TestDb::create().await else {
            return;
        };
        trama_migration::Migrator::up(&test_db.db, None).await.expect("migrate throwaway db");
        assert!(seed_if_empty(&test_db.db, true, false, false).await.unwrap());
        let fixture = fixture().unwrap();
        for (group, table) in [
            ("issues", "issues"),
            ("events", "domain_events"),
            ("milestones", "milestones"),
            ("threadRecords", "task_thread_records"),
            ("decisions", "task_decisions"),
        ] {
            let expected = fixture["withoutMockHistory"][group].as_array().unwrap().len();
            let row = test_db
                .db
                .query_one_raw(Statement::from_string(
                    DatabaseBackend::Postgres,
                    format!(r#"SELECT COUNT(*)::bigint AS count FROM "{table}""#),
                ))
                .await
                .unwrap()
                .unwrap();
            let actual: i64 = row.try_get("", "count").unwrap();
            assert_eq!(actual as usize, expected, "unexpected row count in {table}");
        }
        test_db.drop().await;
    }
}
