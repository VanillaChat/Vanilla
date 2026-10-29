//! Message search for servers and direct messages.
//!
//! A query is free text plus `key:value` filters, parsed here so every client gets the
//! same behaviour:
//!
//! ```text
//! from:name  in:channel  mentions:name  has:link  before:2026-01-31  after:...  during:...
//! ```
//!
//! Text goes through Postgres full-text search (`simple` config: no stemming, so Polish
//! and English chat are treated alike). [`ensure_indexes`] creates the GIN indexes at
//! startup; the expression there must match the one in the queries.

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    response::IntoResponse,
    routing::get,
};
use axum_extra::extract::CookieJar;
use byteorm_client::tokio_postgres::types::ToSql;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::json;

use super::dms::{current_user_id, db_err, to_message, user_by_id};
use crate::error::AppError;
use crate::models::{Message, User};
use crate::state::SharedState;

/// ByteORM cannot describe expression indexes, so they are created here, idempotently.
pub async fn ensure_indexes(state: &SharedState) {
    for table in ["messages", "dmmessages"] {
        let sql = format!(
            "CREATE INDEX IF NOT EXISTS {table}_content_fts \
             ON {table} USING GIN (to_tsvector('simple', content))"
        );
        if let Err(e) = state.db.execute_raw(&sql, &[]).await {
            tracing::warn!("search index setup failed for {table}: {e:?}");
        }
    }
}

const MAX_QUERY_LEN: usize = 300;
const MAX_VALUES_PER_FILTER: usize = 10;
const MAX_PAGE: i64 = 50;
const MAX_OFFSET: i64 = 5000;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/guilds/{guild_id}", get(search_guild))
        .route("/dms", get(search_dms))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct SearchQuery {
    q: String,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Default, PartialEq)]
struct Filters {
    text: Vec<String>,
    from: Vec<String>,
    channel: Vec<String>,
    mentions: Vec<String>,
    has_link: bool,
    before: Option<DateTime<Utc>>,
    after: Option<DateTime<Utc>>,
    during: Option<(DateTime<Utc>, DateTime<Utc>)>,
}

fn bad(code: &str) -> AppError {
    AppError::BadRequest(code.to_string())
}

fn split_tokens(q: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in q.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                cur.push(c);
            }
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn day_start(value: &str) -> Result<DateTime<Utc>, AppError> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc())
        .ok_or_else(|| bad("search.errors.badDate"))
}

fn parse(q: &str) -> Result<Filters, AppError> {
    if q.chars().count() > MAX_QUERY_LEN {
        return Err(bad("search.errors.tooLong"));
    }
    let mut f = Filters::default();
    for token in split_tokens(q) {
        let filter = token
            .split_once(':')
            .map(|(k, v)| (k.to_ascii_lowercase(), v.trim_matches('"').trim()))
            .filter(|(k, v)| {
                !v.is_empty()
                    && matches!(
                        k.as_str(),
                        "from" | "in" | "mentions" | "has" | "before" | "after" | "during"
                    )
            });
        let Some((key, value)) = filter else {
            f.text.push(token);
            continue;
        };
        let value = value.to_string();
        match key.as_str() {
            "from" => f.from.push(value.to_lowercase()),
            "in" => f.channel.push(value.trim_start_matches('#').to_lowercase()),
            "mentions" => f.mentions.push(value.trim_start_matches('@').to_string()),
            "has" if value.eq_ignore_ascii_case("link") => f.has_link = true,
            "has" => return Err(bad("search.errors.unsupportedHas")),
            "before" => f.before = Some(day_start(&value)?),
            // Strictly after that day, so `after:D` and `before:D` never overlap.
            "after" => f.after = Some(day_start(&value)? + Duration::days(1)),
            _ => {
                let start = day_start(&value)?;
                f.during = Some((start, start + Duration::days(1)));
            }
        }
    }
    if f.from.len().max(f.channel.len()).max(f.mentions.len()) > MAX_VALUES_PER_FILTER {
        return Err(bad("search.errors.tooManyFilters"));
    }
    let empty = f == Filters::default();
    if empty {
        return Err(bad("search.errors.empty"));
    }
    Ok(f)
}

fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A WHERE clause under construction; values are always bound, never spliced in.
#[derive(Default)]
struct Sql {
    clauses: Vec<String>,
    params: Vec<Box<dyn ToSql + Sync + Send>>,
}

impl Sql {
    fn bind(&mut self, value: impl ToSql + Sync + Send + 'static) -> String {
        self.params.push(Box::new(value));
        format!("${}", self.params.len())
    }

    fn common(&mut self, f: &Filters) {
        if !f.text.is_empty() {
            let p = self.bind(f.text.join(" "));
            self.clauses.push(format!(
                "to_tsvector('simple', m.content) @@ websearch_to_tsquery('simple', {p})"
            ));
        }
        if !f.from.is_empty() {
            let p = self.bind(f.from.clone());
            self.clauses.push(format!(
                "(lower(u.username) = ANY({p}) OR lower(u.username || '/' || u.tag) = ANY({p}))"
            ));
        }
        for name in &f.mentions {
            let p = self.bind(format!(
                "(^|[^[:alnum:]_])@{}([^[:alnum:]_]|$)",
                regex_escape(name)
            ));
            self.clauses.push(format!("m.content ~* {p}"));
        }
        if f.has_link {
            self.clauses.push("m.content ~* 'https?://'".to_string());
        }
        if let Some(before) = f.before {
            let p = self.bind(before);
            self.clauses.push(format!("m.created_at < {p}"));
        }
        if let Some(after) = f.after {
            let p = self.bind(after);
            self.clauses.push(format!("m.created_at >= {p}"));
        }
        if let Some((start, end)) = f.during {
            let (a, b) = (self.bind(start), self.bind(end));
            self.clauses
                .push(format!("(m.created_at >= {a} AND m.created_at < {b})"));
        }
    }

    async fn page(
        mut self,
        state: &SharedState,
        select: &str,
        limit: i64,
        offset: i64,
    ) -> Result<(i64, Vec<String>), AppError> {
        let (l, o) = (self.bind(limit), self.bind(offset));
        let sql = format!(
            "{select} WHERE {} ORDER BY m.created_at DESC, m.id DESC LIMIT {l} OFFSET {o}",
            self.clauses.join(" AND ")
        );
        let params: Vec<&(dyn ToSql + Sync)> = self
            .params
            .iter()
            .map(|p| p.as_ref() as &(dyn ToSql + Sync))
            .collect();
        let rows = state.db.query_raw(&sql, &params).await.map_err(db_err)?;
        let total = rows.first().map_or(0, |r| r.get::<_, i64>("total"));
        Ok((
            total,
            rows.iter().map(|r| r.get::<_, String>("id")).collect(),
        ))
    }
}

fn paging(q: &SearchQuery) -> (i64, i64) {
    (
        q.limit.unwrap_or(25).clamp(1, MAX_PAGE),
        q.offset.unwrap_or(0).clamp(0, MAX_OFFSET),
    )
}

fn in_order<T>(ids: &[String], mut items: Vec<T>, id_of: impl Fn(&T) -> &str) -> Vec<T> {
    items.sort_by_key(|item| ids.iter().position(|id| id == id_of(item)));
    items
}

#[utoipa::path(
    get,
    path = "/search/guilds/{guild_id}",
    tag = "Search",
    summary = "Search a server's messages",
    description = "Postgres full-text search. Filters: `from:` `in:` `mentions:` `has:link` `before:` `after:` `during:` (dates are YYYY-MM-DD). `limit` is at most 50, `offset` at most 5000.",
    params(("guild_id" = String, Path, description = "Guild id"), SearchQuery),
    responses(
    (status = 200, description = "Matches", body = crate::openapi::SearchResponse),
    (status = 400, description = "Bad query (search.errors.*)", body = crate::openapi::ErrorBody),
    (status = 403, description = "Not a member", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn search_guild(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(guild_id): Path<String>,
    Query(query): Query<SearchQuery>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    state
        .db
        .guild_members
        .find_first(|q| q.where_user_id(me.clone()).where_guild_id(guild_id.clone()))
        .await?
        .ok_or_else(|| AppError::Forbidden("search.errors.notMember".to_string()))?;

    let filters = parse(&query.q)?;
    let (limit, offset) = paging(&query);

    let mut sql = Sql::default();
    let guild = sql.bind(guild_id);
    sql.clauses.push(format!("m.guild_id = {guild}"));
    sql.clauses
        .push("m.message_type IN ('DEFAULT', 'REPLY') AND m.content IS NOT NULL".to_string());
    if !filters.channel.is_empty() {
        let names = sql.bind(filters.channel.clone());
        sql.clauses.push(format!(
            "m.channel_id IN (SELECT c.id FROM channels c WHERE c.guild_id = {guild} AND lower(c.name) = ANY({names}))"
        ));
    }
    sql.common(&filters);

    let (total, ids) = sql
        .page(
            &state,
            "SELECT m.id, COUNT(*) OVER() AS total FROM messages m JOIN users u ON u.id = m.author_id",
            limit,
            offset,
        )
        .await?;

    let rows = state
        .db
        .messages
        .query()
        .where_id_in(ids.clone())
        .include_users()
        .find_many_json()
        .await
        .map_err(db_err)?;
    let mut messages = Vec::with_capacity(rows.len());
    for value in rows {
        let message: byteorm_client::Messages =
            serde_json::from_value(value.clone()).map_err(db_err)?;
        let author: byteorm_client::Users = serde_json::from_value(
            value
                .get("users")
                .cloned()
                .ok_or_else(|| db_err("missing author join"))?,
        )
        .map_err(db_err)?;
        let mut message: Message = message.into();
        message.author = Some(author.into());
        messages.push(message);
    }
    let mut messages = in_order(&ids, messages, |m| m.id.as_str());
    crate::attachments::fill(&state, &mut messages).await?;
    Ok(Json(json!({ "total": total, "messages": messages })))
}

#[utoipa::path(
    get,
    path = "/search/dms",
    tag = "Search",
    summary = "Search your DMs",
    description = "Postgres full-text search. Filters: `from:` `in:` `mentions:` `has:link` `before:` `after:` `during:` (dates are YYYY-MM-DD). `limit` is at most 50, `offset` at most 5000.",
    params(SearchQuery),
    responses(
    (status = 200, description = "Matches", body = crate::openapi::SearchResponse),
    (status = 400, description = "Bad query (search.errors.*)", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn search_dms(
    State(state): State<SharedState>,
    jar: CookieJar,
    Query(query): Query<SearchQuery>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    let filters = parse(&query.q)?;
    let (limit, offset) = paging(&query);

    let mut sql = Sql::default();
    let mine = sql.bind(me);
    if !filters.channel.is_empty() {
        let names = sql.bind(filters.channel.clone());
        sql.clauses.push(format!(
            "m.channel_id IN (\
                SELECT ch.id FROM dmchannels ch WHERE lower(ch.name) = ANY({names}) \
                UNION \
                SELECT pp.channel_id FROM dmparticipants pp \
                JOIN users pu ON pu.id = pp.user_id \
                WHERE pp.user_id <> {mine} AND lower(pu.username) = ANY({names}))"
        ));
    }
    sql.common(&filters);

    let select = format!(
        "SELECT m.id, COUNT(*) OVER() AS total FROM dmmessages m \
         JOIN dmparticipants p ON p.channel_id = m.channel_id AND p.user_id = {mine} \
         JOIN users u ON u.id = m.author_id"
    );
    let (total, ids) = sql.page(&state, &select, limit, offset).await?;

    let rows: Vec<byteorm_client::DmMessages> = state
        .db
        .dm_messages
        .query()
        .where_id_in(ids.clone())
        .find_many_json()
        .await
        .map_err(db_err)?
        .into_iter()
        .map(serde_json::from_value)
        .collect::<Result<_, _>>()
        .map_err(db_err)?;

    let mut authors: Vec<User> = Vec::new();
    for id in rows.iter().map(|m| m.author_id.clone()) {
        if !authors.iter().any(|u| u.id == id) {
            if let Some(u) = user_by_id(&state, &id).await? {
                authors.push(u);
            }
        }
    }
    let rows = in_order(&ids, rows, |m| m.id.as_str());
    let mut messages: Vec<Message> = rows
        .into_iter()
        .map(|m| {
            let author = authors.iter().find(|u| u.id == m.author_id).cloned();
            to_message(m, author)
        })
        .collect();
    crate::attachments::fill(&state, &mut messages).await?;
    Ok(Json(json!({ "total": total, "messages": messages })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_filters_from_text() {
        let f = parse(r#"hello from:Alice in:#general "exact phrase" has:link"#).unwrap();
        assert_eq!(f.text, vec!["hello", "\"exact phrase\""]);
        assert_eq!(f.from, vec!["alice"]);
        assert_eq!(f.channel, vec!["general"]);
        assert!(f.has_link);
    }

    #[test]
    fn quoted_filter_value_keeps_spaces() {
        let f = parse(r#"from:"john doe""#).unwrap();
        assert_eq!(f.from, vec!["john doe"]);
    }

    #[test]
    fn urls_and_unknown_keys_stay_text() {
        let f = parse("see https://example.com note:this").unwrap();
        assert_eq!(f.text, vec!["see", "https://example.com", "note:this"]);
    }

    #[test]
    fn dates_do_not_overlap() {
        let f = parse("before:2026-01-10 after:2026-01-10").unwrap();
        assert!(f.before.unwrap() < f.after.unwrap());
        let (start, end) = parse("during:2026-01-10").unwrap().during.unwrap();
        assert_eq!(end - start, Duration::days(1));
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse("").is_err());
        assert!(parse("   ").is_err());
        assert!(parse("before:yesterday").is_err());
        assert!(parse("has:image").is_err());
        assert!(parse(&"a".repeat(MAX_QUERY_LEN + 1)).is_err());
    }

    #[test]
    fn escapes_regex_in_mentions() {
        assert_eq!(regex_escape("a.b+c"), "a\\.b\\+c");
    }
}
