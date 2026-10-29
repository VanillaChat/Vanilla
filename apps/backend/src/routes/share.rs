//! Shareable invite pages, `GET /i/{code}`.
//!
//! The client is a single-page app, which link crawlers cannot read. This page is plain
//! server-rendered HTML carrying a Discord component embed (with Open Graph tags as the
//! fallback), and sends real visitors on to `/invite/{code}` in the app.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Router, routing::get};
use serde_json::{Value, json};

use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/i/{code}", get(invite_page))
        .route("/i/{code}/icon.png", get(invite_icon))
}

const ACCENT: u32 = 0xF7E26C;
/// Discord rejects component embeds larger than this.
const MAX_EMBED_BYTES: usize = 3000;

struct Preview {
    name: String,
    brief: Option<String>,
    members: i64,
    /// Absolute URL.
    icon: Option<String>,
    /// Absolute URL of the invite page in the app.
    join_url: String,
}

fn clip(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        return one_line;
    }
    let mut cut: String = one_line.chars().take(max - 1).collect();
    cut.push('…');
    cut
}

/// Keeps user text from being read as Discord markdown.
fn plain_markdown(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if "\\*_~`|>#[]()-:@<".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn members_label(n: i64) -> String {
    if n == 1 {
        "1 member".to_string()
    } else {
        format!("{n} members")
    }
}

/// Discord sizes the card to its widest line. The join row is a section whose text is only
/// blank Braille characters (not trimmed like spaces), which stretches the card and leaves the
/// button on the right.
const CARD_PADDING: usize = 40;

/// One blank Braille character before the label widens the button to match the thumbnail above
/// it. Two (one on each side) came out too wide, and one is only half a character off centre.
fn join_label() -> String {
    "\u{2800}Join".to_string()
}

fn member_line(n: i64) -> String {
    format!("-# {}", members_label(n))
}

fn component_embed(p: &Preview, with_brief: bool) -> Value {
    let mut text = format!("# {}", plain_markdown(&p.name));
    if let Some(brief) = p.brief.as_ref().filter(|_| with_brief) {
        text.push('\n');
        text.push_str(&plain_markdown(brief));
    }
    let header = json!({ "type": 10, "content": text });
    let count = json!({ "type": 10, "content": member_line(p.members) });
    let top = match &p.icon {
        Some(icon) => json!({
            "type": 9,
            "components": [header, count],
            "accessory": { "type": 11, "media": { "url": icon } },
        }),
        None => {
            json!({ "type": 10, "content": format!("{}\n{}", text, member_line(p.members)) })
        }
    };
    json!({
        "component": {
            "type": 17,
            "accent_color": ACCENT,
            "components": [
                top,
                {
                    "type": 9,
                    "components": [{ "type": 10, "content": "\u{2800}".repeat(CARD_PADDING) }],
                    "accessory": {
                        "type": 2,
                        "style": 5,
                        "url": p.join_url,
                        "label": join_label(),
                    },
                },
            ],
        }
    })
}

/// The embed as it goes inside `<script>`: `<` is escaped so the text cannot close the tag.
fn embed_json(p: &Preview) -> String {
    for with_brief in [true, false] {
        let json = component_embed(p, with_brief)
            .to_string()
            .replace('<', "\\u003c");
        if json.len() <= MAX_EMBED_BYTES {
            return json;
        }
    }
    String::new()
}

fn render(p: &Preview) -> String {
    let title = format!("Join {} on Vanilla", p.name);
    let description = p.brief.clone().unwrap_or_else(|| members_label(p.members));
    let image = p
        .icon
        .as_ref()
        .map(|i| {
            format!(
                "<meta property=\"og:image\" content=\"{}\">",
                html_escape(i)
            )
        })
        .unwrap_or_default();
    let join = html_escape(&p.join_url);
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\
<title>{title}</title>\
<meta property=\"og:site_name\" content=\"Vanilla\">\
<meta property=\"og:type\" content=\"website\">\
<meta property=\"og:title\" content=\"{title}\">\
<meta property=\"og:description\" content=\"{description}\">\
<meta property=\"og:url\" content=\"{join}\">\
{image}\
<meta name=\"twitter:card\" content=\"summary\">\
<meta name=\"theme-color\" content=\"#f7e26c\">\
<meta http-equiv=\"refresh\" content=\"0;url={join}\">\
<script id=\"discord:component-embed\" type=\"application/json\">{embed}</script>\
</head><body><p><a href=\"{join}\">Open the invite to {name}</a></p>\
<script>location.replace({redirect})</script></body></html>",
        title = html_escape(&title),
        description = html_escape(&description),
        embed = embed_json(p),
        name = html_escape(&p.name),
        redirect = serde_json::to_string(&p.join_url)
            .unwrap_or_default()
            .replace('<', "\\u003c"),
    )
}

/// First value of a header that proxies may have appended to (`https,http`).
fn first(headers: &HeaderMap, name: &str) -> Option<String> {
    let value = headers.get(name)?.to_str().ok()?;
    let first = value.split(',').next()?.trim();
    (!first.is_empty()).then(|| first.to_string())
}

/// The address the visitor used. `PUBLIC_URL` wins when set; otherwise it comes from the
/// forwarding headers of the proxy in front.
fn base_url(headers: &HeaderMap) -> String {
    if let Some(url) = std::env::var("PUBLIC_URL")
        .ok()
        .map(|u| u.trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
    {
        return url;
    }
    let host = first(headers, "x-forwarded-host")
        .or_else(|| first(headers, "host"))
        .unwrap_or_else(|| "localhost".to_string());
    let local = host.starts_with("localhost") || host.starts_with("127.");
    let scheme = first(headers, "x-forwarded-proto")
        .unwrap_or_else(|| if local { "http" } else { "https" }.to_string());
    format!("{scheme}://{host}")
}

fn absolute(base: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        path.to_string()
    } else {
        format!("{base}/{}", path.trim_start_matches('/'))
    }
}

fn html(status: StatusCode, body: String) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=60"),
        ],
        body,
    )
        .into_response()
}

pub(crate) async fn invite_page(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Response {
    let base = base_url(&headers);
    let missing = || {
        html(
            StatusCode::NOT_FOUND,
            "<!doctype html><title>Vanilla</title><p>This invite is invalid or has expired.</p>"
                .to_string(),
        )
    };
    let Ok(Some(invite)) = state
        .db
        .guild_invites
        .find_first(|q| q.where_code(code.clone()))
        .await
    else {
        return missing();
    };
    let Ok(Some(guild)) = state
        .db
        .guilds
        .find_first(|q| q.where_id(invite.guild_id.clone()))
        .await
    else {
        return missing();
    };
    let members = state
        .db
        .guild_members
        .count(|q| q.where_guild_id(guild.id.clone()))
        .await
        .unwrap_or(0);

    let preview = Preview {
        join_url: format!("{base}/invite/{}", invite.code),
        name: clip(&guild.name, 100),
        brief: guild
            .brief
            .as_deref()
            .map(|b| clip(b, 200))
            .filter(|b| !b.is_empty()),
        members,
        icon: Some(match guild.icon.as_deref() {
            Some(i) => absolute(&base, i),
            None => format!("{base}/i/{}/icon.png", invite.code),
        }),
    };
    html(StatusCode::OK, render(&preview))
}

/// The default picture of the invite's server, for servers without an icon of their own.
pub(crate) async fn invite_icon(
    State(state): State<SharedState>,
    Path(code): Path<String>,
) -> Response {
    let guild_id = match state
        .db
        .guild_invites
        .find_first(|q| q.where_code(code))
        .await
    {
        Ok(Some(invite)) => invite.guild_id,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let Ok(Some(bytes)) =
        tokio::task::spawn_blocking(move || crate::default_icon::png(&guild_id, 256)).await
    else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        bytes,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_prefers_the_forwarded_host_and_its_first_value() {
        let mut h = HeaderMap::new();
        h.insert("host", "localhost:3000".parse().unwrap());
        h.insert(
            "x-forwarded-host",
            "chat.example, localhost:5173".parse().unwrap(),
        );
        h.insert("x-forwarded-proto", "https,http".parse().unwrap());
        assert_eq!(base_url(&h), "https://chat.example");
    }

    fn preview() -> Preview {
        Preview {
            name: "Kawiarnia </script><b>".into(),
            brief: Some("Rozmowy o *kawie*".into()),
            members: 42,
            icon: Some("https://chat.example/cdn/icons/1.png".into()),
            join_url: "https://chat.example/invite/abc".into(),
        }
    }

    #[test]
    fn embed_fits_discords_limit_and_cannot_close_the_script() {
        let json = embed_json(&preview());
        assert!(!json.is_empty() && json.len() <= MAX_EMBED_BYTES);
        assert!(!json.contains("</script"));
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["component"]["type"], 17);
    }

    #[test]
    fn join_row_is_a_section_with_the_button_on_the_right() {
        let value = component_embed(&preview(), true);
        let row = &value["component"]["components"][1];
        assert_eq!(row["type"], 9);
        assert_eq!(row["accessory"]["type"], 2);
        assert_eq!(row["accessory"]["style"], 5);
        assert!(embed_json(&preview()).len() <= MAX_EMBED_BYTES);
    }

    #[test]
    fn long_text_is_dropped_before_the_limit_is_hit() {
        let mut p = preview();
        p.brief = Some("x".repeat(5000));
        let json = embed_json(&p);
        assert!(json.len() <= MAX_EMBED_BYTES);
    }

    #[test]
    fn page_escapes_names_and_uses_no_em_dash() {
        let page = render(&preview());
        assert!(!page.contains("<b>"));
        assert!(page.contains("discord:component-embed"));
        assert!(page.contains("og:title"));
        assert!(!page.contains('\u{2014}'));
    }

    #[test]
    fn markdown_in_names_is_neutralised() {
        assert_eq!(plain_markdown("a*b_c"), "a\\*b\\_c");
    }
}
