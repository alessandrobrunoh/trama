//! Cross-entity reference checks inside one workspace (400 on unknown ids), the port of
//! `server/src/common/refs.service.ts`.

use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter};
use trama_core::AppError;
use trama_entities::{artifacts, import_jobs, issues, memberships, milestones, projects};

use crate::util::unique;

/// Every id in `ids` is a project of `workspace_id`.
///
/// # Errors
///
/// 400 `Unknown project in: <ids>`, or the database error.
pub async fn projects<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<(), AppError> {
    let ids = unique(ids);
    if ids.is_empty() {
        return Ok(());
    }
    let found = projects::Entity::find()
        .filter(projects::Column::WorkspaceId.eq(workspace_id))
        .filter(projects::Column::Id.is_in(ids.clone()))
        .count(conn)
        .await?;
    check(found, &ids, "Unknown project in")
}

/// Every id in `ids` is an issue of `workspace_id`.
///
/// # Errors
///
/// 400 `Unknown issue in: <ids>`, or the database error.
pub async fn issues<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<(), AppError> {
    let ids = unique(ids);
    if ids.is_empty() {
        return Ok(());
    }
    let found = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Id.is_in(ids.clone()))
        .count(conn)
        .await?;
    check(found, &ids, "Unknown issue in")
}

/// Every user in `ids` (`None` entries are skipped) is a member of `workspace_id`.
///
/// # Errors
///
/// 400 `Not workspace members: <ids>`, or the database error.
pub async fn users<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    ids: &[Option<String>],
) -> Result<(), AppError> {
    let present: Vec<String> = ids.iter().flatten().filter(|id| !id.is_empty()).cloned().collect();
    let ids = unique(&present);
    if ids.is_empty() {
        return Ok(());
    }
    let found = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(workspace_id))
        .filter(memberships::Column::UserId.is_in(ids.clone()))
        .count(conn)
        .await?;
    check(found, &ids, "Not workspace members")
}

/// Whether the subject of type `subject_type` (`issue`, `project`, `milestone`, `artifact`,
/// `import`) with `id` exists in `workspace_id`. Other types never exist.
///
/// # Errors
///
/// The database error.
pub async fn subject_exists<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    subject_type: &str,
    id: &str,
) -> Result<bool, AppError> {
    let count = match subject_type {
        "artifact" => {
            artifacts::Entity::find()
                .filter(artifacts::Column::WorkspaceId.eq(workspace_id))
                .filter(artifacts::Column::Id.eq(id))
                .count(conn)
                .await?
        }
        "milestone" => {
            milestones::Entity::find()
                .filter(milestones::Column::WorkspaceId.eq(workspace_id))
                .filter(milestones::Column::Id.eq(id))
                .count(conn)
                .await?
        }
        "issue" => {
            issues::Entity::find()
                .filter(issues::Column::WorkspaceId.eq(workspace_id))
                .filter(issues::Column::Id.eq(id))
                .count(conn)
                .await?
        }
        "project" => {
            projects::Entity::find()
                .filter(projects::Column::WorkspaceId.eq(workspace_id))
                .filter(projects::Column::Id.eq(id))
                .count(conn)
                .await?
        }
        "import" => {
            import_jobs::Entity::find()
                .filter(import_jobs::Column::WorkspaceId.eq(workspace_id))
                .filter(import_jobs::Column::Id.eq(id))
                .count(conn)
                .await?
        }
        _ => 0,
    };
    Ok(count > 0)
}

fn check(found: u64, ids: &[String], label: &str) -> Result<(), AppError> {
    if usize::try_from(found).ok() == Some(ids.len()) {
        Ok(())
    } else {
        Err(AppError::bad_request(format!("{label}: {}", ids.join(", "))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use sea_orm_migration::MigratorTrait;
    use trama_core::testkit::TestDb;

    fn strings(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| (*s).to_owned()).collect()
    }

    #[tokio::test]
    async fn validates_references_inside_the_workspace() {
        let Some(test) = TestDb::create().await else { return };
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        test.db
            .execute_unprepared(
                r#"
                INSERT INTO "workspaces" ("id","slug","name") VALUES ('ws_a','a','A'), ('ws_b','b','B');
                INSERT INTO "users" ("id","name","email","passwordHash")
                  VALUES ('usr_1','One','one@x.dev','x'), ('usr_2','Two','two@x.dev','x');
                INSERT INTO "memberships" ("id","workspaceId","userId","role")
                  VALUES ('mem_1','ws_a','usr_1','member'), ('mem_2','ws_b','usr_2','member');
                INSERT INTO "projects" ("id","workspaceId","name","key")
                  VALUES ('prj_a','ws_a','Alpha','ALP'), ('prj_b','ws_b','Beta','BET');
                INSERT INTO "issues" ("id","workspaceId","key","number","kind","title")
                  VALUES ('iss_a','ws_a','UNPR-1',1,'bug','One');
                INSERT INTO "milestones" ("id","workspaceId","name","projectId")
                  VALUES ('mil_a','ws_a','M1','prj_a');
                INSERT INTO "artifacts" ("id","workspaceId","kind","title","issueId")
                  VALUES ('art_a','ws_a','note','Note','iss_a');
                "#,
            )
            .await
            .unwrap();
        let db = &test.db;

        projects(db, "ws_a", &strings(&["prj_a", "prj_a"])).await.unwrap();
        projects(db, "ws_a", &[]).await.unwrap();
        let err = projects(db, "ws_a", &strings(&["prj_a", "prj_b"])).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        assert_eq!(err.to_string(), "400 Bad Request: Unknown project in: prj_a, prj_b");

        issues(db, "ws_a", &strings(&["iss_a"])).await.unwrap();
        let err = issues(db, "ws_b", &strings(&["iss_a"])).await.unwrap_err();
        assert!(err.to_string().ends_with("Unknown issue in: iss_a"));

        users(db, "ws_a", &[Some("usr_1".into()), None, Some("usr_1".into())]).await.unwrap();
        users(db, "ws_a", &[None]).await.unwrap();
        let err =
            users(db, "ws_a", &[Some("usr_1".into()), Some("usr_2".into())]).await.unwrap_err();
        assert!(err.to_string().ends_with("Not workspace members: usr_1, usr_2"));

        for (kind, id) in [
            ("project", "prj_a"),
            ("issue", "iss_a"),
            ("milestone", "mil_a"),
            ("artifact", "art_a"),
        ] {
            assert!(subject_exists(db, "ws_a", kind, id).await.unwrap(), "{kind}");
            assert!(!subject_exists(db, "ws_b", kind, id).await.unwrap(), "{kind}");
        }
        assert!(!subject_exists(db, "ws_a", "import", "imp_x").await.unwrap());
        assert!(!subject_exists(db, "ws_a", "workspace", "ws_a").await.unwrap());

        test.drop().await;
    }
}
