//! Files and images attached to messages.
//!
//! Upload is a separate step: `POST /attachments` stores the bytes and returns an id, and the
//! message that carries that id later claims it. Unclaimed uploads are swept after an hour.
//! Files live under `./cdn/attachments/<id>`; the original name is kept only in the database.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;
use std::time::Duration;

use byteorm_client::Attachments;
use image::ImageFormat;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::error::AppError;
use crate::models::Message;
use crate::state::SharedState;

pub const MAX_PER_MESSAGE: usize = 10;
pub const MAX_PENDING_PER_USER: usize = 20;
const MAX_FILENAME_CHARS: usize = 100;
const PENDING_TTL: Duration = Duration::from_secs(60 * 60);
const SWEEP_EVERY: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    /// Pixel size, set for images only.
    pub width: Option<i32>,
    pub height: Option<i32>,
    /// Public path of the file, e.g. `/cdn/attachments/<id>/<filename>`.
    pub url: String,
}

impl From<Attachments> for Attachment {
    fn from(a: Attachments) -> Self {
        let url = format!(
            "/cdn/attachments/{}/{}",
            a.id,
            urlencoding::encode(&a.filename)
        );
        Self {
            id: a.id,
            filename: a.filename,
            content_type: a.content_type,
            size: a.size as i64,
            width: a.width,
            height: a.height,
            url,
        }
    }
}

pub fn file_path(id: &str) -> PathBuf {
    PathBuf::from("./cdn/attachments").join(id)
}

pub fn sanitize_filename(raw: &str) -> String {
    let name = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_FILENAME_CHARS)
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

/// The only types the CDN will render inline; everything else is a download.
pub struct Sniffed {
    pub content_type: &'static str,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

pub fn sniff(bytes: &[u8]) -> Sniffed {
    let format = image::guess_format(bytes).ok().and_then(|f| match f {
        ImageFormat::Png => Some("image/png"),
        ImageFormat::Jpeg => Some("image/jpeg"),
        ImageFormat::Gif => Some("image/gif"),
        ImageFormat::WebP => Some("image/webp"),
        _ => None,
    });
    let Some(content_type) = format else {
        return Sniffed {
            content_type: "application/octet-stream",
            width: None,
            height: None,
        };
    };
    let dims = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok());
    match dims {
        Some((w, h)) => Sniffed {
            content_type,
            width: i32::try_from(w).ok(),
            height: i32::try_from(h).ok(),
        },
        // Claims to be an image but is not decodable: treat it as an opaque file.
        None => Sniffed {
            content_type: "application/octet-stream",
            width: None,
            height: None,
        },
    }
}

fn bad(code: &str) -> AppError {
    AppError::BadRequest(code.to_string())
}

pub async fn claim(
    state: &SharedState,
    user_id: &str,
    ids: &[String],
) -> Result<Vec<Attachments>, AppError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut unique = ids.to_vec();
    unique.sort();
    unique.dedup();
    if unique.len() != ids.len() || unique.len() > MAX_PER_MESSAGE {
        return Err(bad("attachments.errors.tooMany"));
    }
    let rows = state
        .db
        .attachments
        .find_many(|q| q.where_id_in(unique.clone()))
        .await?;
    let ok = rows.len() == unique.len()
        && rows
            .iter()
            .all(|r| r.uploader_id == user_id && r.message_id.is_none());
    if !ok {
        return Err(bad("attachments.errors.invalid"));
    }
    let mut ordered = Vec::with_capacity(rows.len());
    for id in ids {
        if let Some(r) = rows.iter().find(|r| &r.id == id) {
            ordered.push(r.clone());
        }
    }
    Ok(ordered)
}

pub async fn bind(
    state: &SharedState,
    rows: Vec<Attachments>,
    message_id: &str,
) -> Result<Vec<Attachment>, AppError> {
    for r in &rows {
        state
            .db
            .attachments
            .update(|u| {
                u.where_id(r.id.clone())
                    .set_message_id(Some(message_id.to_string()))
            })
            .await?;
    }
    Ok(rows.into_iter().map(Attachment::from).collect())
}

pub async fn fill(state: &SharedState, messages: &mut [Message]) -> Result<(), AppError> {
    let ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let mut rows = state
        .db
        .attachments
        .find_many(|q| q.where_message_id_in(ids.into_iter().map(Some).collect()))
        .await?;
    rows.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    let mut by_message: HashMap<String, Vec<Attachment>> = HashMap::new();
    for r in rows {
        if let Some(mid) = r.message_id.clone() {
            by_message.entry(mid).or_default().push(r.into());
        }
    }
    for m in messages.iter_mut() {
        if let Some(list) = by_message.remove(&m.id) {
            m.attachments = list;
        }
    }
    Ok(())
}

pub async fn remove_for_messages(state: &SharedState, message_ids: Vec<String>) {
    let rows = state
        .db
        .attachments
        .find_many(|q| q.where_message_id_in(message_ids.into_iter().map(Some).collect()))
        .await
        .unwrap_or_default();
    for r in rows {
        remove(state, &r.id).await;
    }
}

async fn remove(state: &SharedState, id: &str) {
    let _ = state
        .db
        .attachments
        .delete(|d| d.where_id(id.to_string()))
        .await;
    let _ = tokio::fs::remove_file(file_path(id)).await;
}

pub fn spawn_sweeper(state: SharedState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SWEEP_EVERY);
        loop {
            tick.tick().await;
            let Ok(pending) = state
                .db
                .attachments
                .find_many(|q| q.where_message_id_is_null())
                .await
            else {
                continue;
            };
            let cutoff =
                chrono::Utc::now() - chrono::Duration::from_std(PENDING_TTL).unwrap_or_default();
            for r in pending.into_iter().filter(|r| r.created_at < cutoff) {
                remove(&state, &r.id).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames_lose_paths_and_control_characters() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("C:\\dir\\cat.png"), "cat.png");
        assert_eq!(sanitize_filename("a\u{0}b\n.txt"), "ab.txt");
        assert_eq!(sanitize_filename(".hidden"), "hidden");
        assert_eq!(sanitize_filename("///"), "file");
        assert_eq!(
            sanitize_filename(&"x".repeat(300)).chars().count(),
            MAX_FILENAME_CHARS
        );
    }

    #[test]
    fn only_decodable_images_are_inline() {
        let mut png = Vec::new();
        image::RgbaImage::new(2, 3)
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        let s = sniff(&png);
        assert_eq!(
            (s.content_type, s.width, s.height),
            ("image/png", Some(2), Some(3))
        );
        assert_eq!(
            sniff(b"<svg xmlns='http://www.w3.org/2000/svg'/>").content_type,
            "application/octet-stream"
        );
        assert_eq!(
            sniff(b"plain text").content_type,
            "application/octet-stream"
        );
    }
}
