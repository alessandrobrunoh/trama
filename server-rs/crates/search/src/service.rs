//! Searching projects, issues, artifacts, task decisions and thread records (`search.service.ts`).
//!
//! Each type is one `ILIKE` query over its searchable columns (every word of the search must
//! match at least one of them); the rows are scored in memory, the caller's project access is
//! applied to them, and the best `limit` are returned.

use std::cmp::Ordering;

use sea_orm::{ConnectionTrait, DatabaseConnection, Statement, Value};
use trama_auth::member_access::{can_view, current_access, project_hidden};
use trama_contracts::access::MemberResource;
use trama_contracts::js;
use trama_core::AppError;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use crate::schemas::{SearchResponse, SearchResult, SearchType};

struct Spec {
    kind: SearchType,
    from: &'static str,
    /// Selects `id`, `key`, `title`, `subtitle`, `legacyWorkstreamKey`, `body`, `projectId` and,
    /// when `with_issue`, `issueId`.
    select: &'static str,
    /// Searchable columns.
    fields: &'static [&'static str],
    /// Tie-break order between types.
    rank: u8,
    resource: MemberResource,
    /// The rows name the task they belong to (`issueId`): decisions and records.
    with_issue: bool,
}

const SPECS: [Spec; 5] = [
    Spec {
        kind: SearchType::Project,
        from: r#""projects" x"#,
        select: r#"x."id", NULL AS key, x."name" AS title, x."status" AS subtitle, NULL AS "legacyWorkstreamKey", COALESCE(x."summary", x."description") AS body, x."id" AS "projectId""#,
        fields: &[r#"x."name""#, r#"x."summary""#, r#"x."description""#],
        rank: 1,
        resource: MemberResource::Projects,
        with_issue: false,
    },
    Spec {
        kind: SearchType::Issue,
        from: r#""issues" x"#,
        select: r#"x."id", x."key", x."title", x."kind" || ' · ' || x."status" AS subtitle, NULL AS "legacyWorkstreamKey", x."body" AS body, x."projectId" AS "projectId""#,
        fields: &[r#"x."key""#, r#"x."aliases"::text"#, r#"x."title""#, r#"x."body""#],
        rank: 3,
        resource: MemberResource::Issues,
        with_issue: false,
    },
    Spec {
        kind: SearchType::Artifact,
        from: r#""artifacts" x LEFT JOIN "issues" i ON i."id" = x."issueId""#,
        select: r#"x."id", x."externalId" AS key, x."title", x."kind" || ' · ' || x."state" AS subtitle, x."legacyWorkstreamKey" AS "legacyWorkstreamKey", COALESCE(x."url", x."description") AS body, i."projectId" AS "projectId""#,
        fields: &[r#"x."externalId""#, r#"x."title""#],
        rank: 4,
        resource: MemberResource::Artifacts,
        with_issue: false,
    },
    Spec {
        // title = the decision, subtitle = its task's title
        kind: SearchType::Decision,
        from: r#""task_decisions" x JOIN "issues" i ON i."id" = x."issueId""#,
        select: r#"x."id", i."key", x."text" AS title, i."title" AS subtitle, NULL AS "legacyWorkstreamKey", x."paths"::text AS body, i."projectId" AS "projectId", x."issueId" AS "issueId""#,
        fields: &[r#"i."key""#, r#"x."text""#, r#"x."paths"::text"#],
        rank: 5,
        resource: MemberResource::Issues,
        with_issue: true,
    },
    Spec {
        // title = the task's title, subtitle = the start of the summary; the hit id is the task id
        kind: SearchType::Record,
        from: r#""task_thread_records" x JOIN "issues" i ON i."id" = x."issueId""#,
        select: r#"x."issueId" AS id, i."key", i."title", left(COALESCE(x."summary", ''), 160) AS subtitle, NULL AS "legacyWorkstreamKey", x."summary" AS body, i."projectId" AS "projectId", x."issueId" AS "issueId""#,
        fields: &[r#"i."key""#, r#"i."title""#, r#"x."summary""#],
        rank: 6,
        resource: MemberResource::Issues,
        with_issue: true,
    },
];

/// Options of [`search`].
#[derive(Clone, Debug, Default)]
pub struct SearchOptions {
    /// Only these types; empty means all.
    pub types: Vec<SearchType>,
    /// 1..=100, 20 when absent.
    pub limit: Option<u32>,
}

/// A row as selected by a [`Spec`].
struct Row {
    id: String,
    key: Option<String>,
    title: String,
    subtitle: String,
    legacy_workstream_key: Option<String>,
    body: Option<String>,
    project_id: Option<String>,
    issue_id: Option<String>,
}

/// `escapeLike`: a search word as a literal inside `ILIKE '%…%'`.
fn escape_like(word: &str) -> String {
    let mut out = String::with_capacity(word.len());
    for c in word.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The query of one type and its parameters (`$1` is the workspace).
fn build_query(spec: &Spec, workspace_id: &str, terms: &[&str]) -> (String, Vec<Value>) {
    let mut params: Vec<Value> = vec![workspace_id.into()];
    let clauses: Vec<String> = terms
        .iter()
        .map(|term| {
            params.push(format!("%{}%", escape_like(term)).into());
            let at = params.len();
            let any: Vec<String> =
                spec.fields.iter().map(|column| format!("{column} ILIKE ${at}")).collect();
            format!("({})", any.join(" OR "))
        })
        .collect();
    let sql = format!(
        r#"SELECT {} FROM {} WHERE x."workspaceId" = $1 AND {} LIMIT 200"#,
        spec.select,
        spec.from,
        clauses.join(" AND ")
    );
    (sql, params)
}

/// `scoreRow`: exact key 100, key prefix 80, key contains 60, title exact 70, prefix 55,
/// contains 40, every word in the title 30, body contains 20, anything else 10.
#[must_use]
pub fn score_row(q: &str, key: Option<&str>, title: &str, body: Option<&str>) -> u32 {
    let n = q.to_lowercase();
    let key = key.map(str::to_lowercase);
    let title = title.to_lowercase();
    let mut score = 0;
    if let Some(key) = &key {
        if *key == n {
            score = 100;
        } else if key.starts_with(&n) {
            score = 80;
        } else if key.contains(&n) {
            score = 60;
        }
    }
    if title == n {
        score = score.max(70);
    } else if title.starts_with(&n) {
        score = score.max(55);
    } else if title.contains(&n) {
        score = score.max(40);
    } else if n.split(js::is_whitespace).filter(|t| !t.is_empty()).all(|t| title.contains(t)) {
        score = score.max(30);
    }
    if score == 0 {
        score = if body.is_some_and(|b| b.to_lowercase().contains(&n)) { 20 } else { 10 };
    }
    score
}

/// Searches the workspace (`SearchService.search`).
///
/// A type the caller may not view is skipped, and rows of projects outside the request's member
/// access are dropped (a project by its own id, an issue by its project, an artifact by its
/// issue's project).
///
/// # Errors
///
/// Database errors.
pub async fn search(
    db: &DatabaseConnection,
    workspace_id: &str,
    q: &str,
    options: &SearchOptions,
) -> Result<SearchResponse, AppError> {
    let query = js::trim(q);
    if query.is_empty() {
        return Ok(SearchResponse { results: Vec::new() });
    }
    let limit = options.limit.unwrap_or(20).clamp(1, 100) as usize;
    let terms: Vec<&str> =
        query.split(js::is_whitespace).filter(|t| !t.is_empty()).take(6).collect();
    let access = current_access();

    let mut hits: Vec<(SearchResult, u8)> = Vec::new();
    for spec in &SPECS {
        let wanted = options.types.is_empty() || options.types.contains(&spec.kind);
        if !wanted || !can_view(spec.resource, access.as_deref()) {
            continue;
        }
        for row in load(db, spec, workspace_id, &terms).await? {
            if project_hidden(access.as_deref(), row.project_id.as_deref()) {
                continue;
            }
            hits.push((to_result(spec.kind, query, row), spec.rank));
        }
    }
    hits.sort_by(|(a, rank_a), (b, rank_b)| {
        b.score
            .cmp(&a.score)
            .then_with(|| rank_a.cmp(rank_b))
            .then_with(|| locale_compare(&a.title, &b.title))
    });
    Ok(SearchResponse { results: hits.into_iter().take(limit).map(|(hit, _)| hit).collect() })
}

async fn load(
    db: &DatabaseConnection,
    spec: &Spec,
    workspace_id: &str,
    terms: &[&str],
) -> Result<Vec<Row>, AppError> {
    let (sql, params) = build_query(spec, workspace_id, terms);
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(db.get_database_backend(), sql, params))
        .await?;
    rows.iter()
        .map(|row| {
            Ok(Row {
                id: row.try_get("", "id")?,
                key: row.try_get("", "key")?,
                title: row.try_get("", "title")?,
                subtitle: row.try_get("", "subtitle")?,
                legacy_workstream_key: row.try_get("", "legacyWorkstreamKey")?,
                body: row.try_get("", "body")?,
                project_id: row.try_get("", "projectId")?,
                issue_id: if spec.with_issue { row.try_get("", "issueId")? } else { None },
            })
        })
        .collect()
}

fn to_result(kind: SearchType, query: &str, row: Row) -> SearchResult {
    let score = score_row(query, row.key.as_deref(), &row.title, row.body.as_deref());
    SearchResult {
        kind,
        id: row.id,
        key: row.key.filter(|k| !k.is_empty()),
        title: row.title,
        subtitle: row.subtitle,
        legacy_workstream_key: row.legacy_workstream_key.filter(|k| !k.is_empty()),
        issue_id: row.issue_id.filter(|id| !id.is_empty()),
        score,
    }
}

/// `a.localeCompare(b)`, approximated for Latin text: accents and case do not matter first
/// (whitespace, then punctuation, then digits and letters), then a lower case letter sorts
/// before the same upper case one.
fn locale_compare(a: &str, b: &str) -> Ordering {
    fn class(c: char) -> u8 {
        if c.is_whitespace() {
            0
        } else if c.is_alphanumeric() {
            2
        } else {
            1
        }
    }
    fn base(text: &str) -> Vec<char> {
        text.nfd().filter(|c| !is_combining_mark(*c)).flat_map(char::to_lowercase).collect()
    }
    let (ba, bb) = (base(a), base(b));
    let primary = ba
        .iter()
        .zip(&bb)
        .map(|(x, y)| class(*x).cmp(&class(*y)).then_with(|| x.cmp(y)))
        .find(|order| *order != Ordering::Equal)
        .unwrap_or_else(|| ba.len().cmp(&bb.len()));
    primary.then_with(|| {
        a.nfd()
            .zip(b.nfd())
            .map(|(x, y)| match (x.is_lowercase(), y.is_lowercase()) {
                (true, false) => Ordering::Less,
                (false, true) => Ordering::Greater,
                _ => x.cmp(&y),
            })
            .find(|order| *order != Ordering::Equal)
            .unwrap_or(Ordering::Equal)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sql_of(kind: SearchType) -> String {
        let spec = SPECS.iter().find(|s| s.kind == kind).unwrap();
        build_query(spec, "ws_1", &["login"]).0
    }

    /// `searches direct issue and project owners without querying workstreams`
    #[test]
    fn queries_only_direct_owners() {
        let all: String = SearchType::ALL.map(sql_of).join("\n");
        let forbidden = [
            "workstreams",
            "workstreamid",
            "originworkstreamid",
            "customers",
            "repositories",
            "teams",
            "originissueid",
        ];
        let lower = all.to_lowercase();
        for word in forbidden {
            assert!(!lower.contains(word), "{word} in {all}");
        }
        assert!(all.contains(r#"x."issueId""#));
    }

    #[test]
    fn binds_one_pattern_per_word() {
        let spec = &SPECS[1];
        let (sql, params) = build_query(spec, "ws_1", &["50%_off", "a\\b"]);
        assert!(sql.contains(r#"(x."key" ILIKE $2 OR x."aliases"::text ILIKE $2 OR x."title" ILIKE $2 OR x."body" ILIKE $2) AND (x."key" ILIKE $3"#));
        assert_eq!(params.len(), 3);
        assert_eq!(params[1], Value::from(r"%50\%\_off%".to_owned()));
        assert_eq!(params[2], Value::from(r"%a\\b%".to_owned()));
    }

    #[test]
    fn scores_like_score_row() {
        assert_eq!(score_row("bug-1", Some("BUG-1"), "x", None), 100);
        assert_eq!(score_row("bug", Some("BUG-1"), "x", None), 80);
        assert_eq!(score_row("ug-", Some("BUG-1"), "x", None), 60);
        assert_eq!(score_row("login", None, "Login", None), 70);
        assert_eq!(score_row("log", None, "Login page", None), 55);
        assert_eq!(score_row("page", None, "Login page", None), 40);
        assert_eq!(score_row("page login", None, "Login page", None), 30);
        assert_eq!(score_row("zebra", None, "Login page", Some("a ZEBRA")), 20);
        assert_eq!(score_row("zebra", None, "Login page", Some("nope")), 10);
        // the key wins over a weaker title match
        assert_eq!(score_row("bug-1", Some("BUG-1"), "bug-1 fix", None), 100);
    }

    #[test]
    fn orders_titles_like_locale_compare() {
        assert_eq!(locale_compare("apple", "Banana"), Ordering::Less);
        assert_eq!(locale_compare("a", "A"), Ordering::Less);
        assert_eq!(locale_compare("é", "f"), Ordering::Less);
    }
}
