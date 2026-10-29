//! Fetches link previews on behalf of users.
//!
//! The server makes requests to URLs chosen by users, so every hop is checked:
//! only http(s) on the standard ports, no credentials in the URL, and the host
//! must resolve to public addresses only. The connection is pinned to the address
//! that was checked (no second DNS lookup), and redirects are followed by hand so
//! each target goes through the same checks.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{ACCEPT, CONTENT_TYPE, LOCATION};
use serde::Serialize;
use tokio::sync::Semaphore;
use url::{Host, Url};

const MAX_HOPS: usize = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_HTML_BYTES: usize = 512 * 1024;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const CACHE_MAX: usize = 500;
const MAX_CONCURRENT: usize = 8;

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    /// Absolute URL of the image on the original site; clients load it through our proxy.
    pub image: Option<String>,
}

#[derive(Debug)]
pub struct Fetched {
    pub final_url: Url,
    pub content_type: String,
    pub body: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum UnfurlError {
    #[error("blocked or invalid url")]
    Blocked,
    #[error("unsupported content")]
    Unsupported,
    #[error("request failed")]
    Failed,
}

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        // 100.64.0.0/10 carrier-grade NAT
        || (o[0] == 100 && (o[1] & 0xC0) == 64)
        // 192.0.0.0/24 IETF protocol assignments
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        // 198.18.0.0/15 benchmarking
        || (o[0] == 198 && (o[1] & 0xFE) == 18)
        // 240.0.0.0/4 reserved
        || o[0] >= 240
        // 0.0.0.0/8
        || o[0] == 0)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let s = ip.segments();
    // 64:ff9b::/96 NAT64 embeds an IPv4 address in the tail.
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|x| *x == 0) {
        let v4 = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
        return is_public_v4(v4);
    }
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        // fc00::/7 unique local
        || (s[0] & 0xFE00) == 0xFC00
        // fe80::/10 link local
        || (s[0] & 0xFFC0) == 0xFE80
        // 2001:db8::/32 documentation
        || (s[0] == 0x2001 && s[1] == 0x0DB8)
        // 100::/64 discard-only
        || (s[0] == 0x0100 && s[1] == 0 && s[2] == 0 && s[3] == 0))
}

async fn vet(url: &Url) -> Result<SocketAddr, UnfurlError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(UnfurlError::Blocked);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(UnfurlError::Blocked);
    }
    let port = url.port_or_known_default().ok_or(UnfurlError::Blocked)?;
    if port != 80 && port != 443 {
        return Err(UnfurlError::Blocked);
    }

    match url.host().ok_or(UnfurlError::Blocked)? {
        Host::Ipv4(ip) => public_addr(IpAddr::V4(ip), port),
        Host::Ipv6(ip) => public_addr(IpAddr::V6(ip), port),
        Host::Domain(domain) => {
            let lookup = tokio::time::timeout(
                Duration::from_secs(3),
                tokio::net::lookup_host((domain, port)),
            )
            .await
            .map_err(|_| UnfurlError::Failed)?
            .map_err(|_| UnfurlError::Failed)?;
            let addrs: Vec<SocketAddr> = lookup.collect();
            // One private answer is enough to refuse: it may be what a rebinding trick wants.
            if addrs.is_empty() || addrs.iter().any(|a| !is_public_ip(a.ip())) {
                return Err(UnfurlError::Blocked);
            }
            Ok(addrs[0])
        }
    }
}

fn public_addr(ip: IpAddr, port: u16) -> Result<SocketAddr, UnfurlError> {
    if is_public_ip(ip) {
        Ok(SocketAddr::new(ip, port))
    } else {
        Err(UnfurlError::Blocked)
    }
}

fn permits() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(MAX_CONCURRENT))
}

pub async fn fetch_limited(
    start: Url,
    accept_header: &str,
    max_bytes: usize,
    accept: fn(&str) -> bool,
) -> Result<Fetched, UnfurlError> {
    let _permit = permits().try_acquire().map_err(|_| UnfurlError::Failed)?;

    let mut url = start;
    for _ in 0..=MAX_HOPS {
        let addr = vet(&url).await?;

        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .user_agent("VanillaBot/1.0 (link preview)");
        if let Some(Host::Domain(domain)) = url.host() {
            // Connect to the address that was checked, not to a fresh DNS answer.
            builder = builder.resolve(domain, addr);
        }
        let client = builder.build().map_err(|_| UnfurlError::Failed)?;

        let response = client
            .get(url.clone())
            .header(ACCEPT, accept_header)
            .send()
            .await
            .map_err(|_| UnfurlError::Failed)?;

        let status = response.status();
        if status.is_redirection() {
            let next = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|loc| url.join(loc).ok())
                .ok_or(UnfurlError::Failed)?;
            url = next;
            continue;
        }
        if !status.is_success() {
            return Err(UnfurlError::Failed);
        }

        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !accept(&content_type) {
            return Err(UnfurlError::Unsupported);
        }

        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| UnfurlError::Failed)?;
            body.extend_from_slice(&chunk);
            if body.len() >= max_bytes {
                body.truncate(max_bytes);
                break;
            }
        }
        return Ok(Fetched {
            final_url: url,
            content_type,
            body,
        });
    }
    Err(UnfurlError::Failed)
}

fn is_html(ct: &str) -> bool {
    ct == "text/html" || ct == "application/xhtml+xml"
}

/// Raster images only: SVG can carry script.
pub fn is_safe_image(ct: &str) -> bool {
    matches!(ct, "image/png" | "image/jpeg" | "image/gif" | "image/webp")
}

pub async fn fetch_image(url: Url) -> Result<Fetched, UnfurlError> {
    fetch_limited(url, "image/*", MAX_IMAGE_BYTES, is_safe_image).await
}

type Cache = Mutex<HashMap<String, (Instant, Option<Preview>)>>;

fn cache() -> &'static Cache {
    static C: OnceLock<Cache> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn preview(url: Url) -> Result<Option<Preview>, UnfurlError> {
    let key = url.as_str().to_string();
    if let Ok(map) = cache().lock() {
        if let Some((at, value)) = map.get(&key) {
            if at.elapsed() < CACHE_TTL {
                return Ok(value.clone());
            }
        }
    }

    let result = match fetch_limited(
        url,
        "text/html,application/xhtml+xml",
        MAX_HTML_BYTES,
        is_html,
    )
    .await
    {
        Ok(page) => parse_preview(&page),
        Err(UnfurlError::Unsupported) => None,
        Err(e) => return Err(e),
    };

    if let Ok(mut map) = cache().lock() {
        if map.len() >= CACHE_MAX {
            map.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
            if map.len() >= CACHE_MAX {
                map.clear();
            }
        }
        map.insert(key, (Instant::now(), result.clone()));
    }
    Ok(result)
}

fn parse_preview(page: &Fetched) -> Option<Preview> {
    let html = String::from_utf8_lossy(&page.body);
    let metas = collect_metas(&html);
    let get = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| metas.get(*k))
            .map(|v| clean(v))
            .filter(|v| !v.is_empty())
    };

    let title = get(&["og:title", "twitter:title"]).or_else(|| title_tag(&html));
    let description = get(&["og:description", "twitter:description", "description"]);
    let site_name = get(&["og:site_name"]);
    let image = get(&["og:image", "og:image:url", "twitter:image"])
        .and_then(|src| page.final_url.join(&src).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .map(|u| u.to_string());

    if title.is_none() && description.is_none() {
        return None;
    }
    Some(Preview {
        url: page.final_url.to_string(),
        title: title.map(|t| truncate(&t, 200)),
        description: description.map(|d| truncate(&d, 400)),
        site_name: site_name.map(|s| truncate(&s, 80)),
        image,
    })
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{}…", cut.trim_end())
    }
}

fn collect_metas(html: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(rel) = lower[from..].find("<meta") {
        let start = from + rel;
        let Some(end_rel) = lower[start..].find('>') else {
            break;
        };
        let end = start + end_rel;
        let attrs = parse_attrs(&html[start + 5..end]);
        let key = attrs.get("property").or_else(|| attrs.get("name"));
        if let (Some(key), Some(content)) = (key, attrs.get("content")) {
            out.entry(key.to_ascii_lowercase())
                .or_insert_with(|| content.clone());
        }
        from = end;
    }
    out
}

fn title_tag(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open_end = lower[start..].find('>')? + start + 1;
    let close = lower[open_end..].find("</title")? + open_end;
    let text = clean(&html[open_end..close]);
    (!text.is_empty()).then_some(text)
}

fn parse_attrs(tag: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let chars: Vec<char> = tag.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == '/') {
            i += 1;
        }
        let name_start = i;
        while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '=' && chars[i] != '/' {
            i += 1;
        }
        let name: String = chars[name_start..i]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i < chars.len() && chars[i] == '=' {
            i += 1;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            let value: String;
            if i < chars.len() && (chars[i] == '"' || chars[i] == '\'') {
                let quote = chars[i];
                i += 1;
                let v_start = i;
                while i < chars.len() && chars[i] != quote {
                    i += 1;
                }
                value = chars[v_start..i].iter().collect();
                i += 1;
            } else {
                let v_start = i;
                while i < chars.len() && !chars[i].is_whitespace() {
                    i += 1;
                }
                value = chars[v_start..i].iter().collect();
            }
            if !name.is_empty() {
                out.entry(name).or_insert(value);
            }
        } else if name.is_empty() {
            i += 1;
        }
    }
    out
}

fn clean(raw: &str) -> String {
    let decoded = decode_entities(raw);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        rest = &rest[pos..];
        match rest.find(';').filter(|e| *e <= 10) {
            Some(end) => {
                let entity = &rest[1..end];
                let decoded = match entity {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" | "#39" | "#x27" => Some('\''),
                    "nbsp" => Some(' '),
                    _ => entity
                        .strip_prefix("#x")
                        .or_else(|| entity.strip_prefix("#X"))
                        .and_then(|h| u32::from_str_radix(h, 16).ok())
                        .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                        .and_then(char::from_u32),
                };
                match decoded {
                    Some(c) => {
                        out.push(c);
                        rest = &rest[end + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = &rest[1..];
                    }
                }
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn private_and_special_addresses_are_refused() {
        for a in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.9",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "198.18.0.1",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::7f00:1",
            "2001:db8::1",
        ] {
            assert!(!is_public_ip(ip(a)), "{a} must be refused");
        }
    }

    #[test]
    fn public_addresses_pass() {
        for a in [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34",
            "2606:4700:4700::1111",
        ] {
            assert!(is_public_ip(ip(a)), "{a} must pass");
        }
    }

    #[test]
    fn odd_urls_are_refused_before_any_lookup() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for u in [
            "ftp://example.com/",
            "file:///etc/passwd",
            "http://user:pw@example.com/",
            "http://example.com:8080/",
            "http://127.0.0.1/",
            "http://[::1]/",
            "http://169.254.169.254/latest/meta-data/",
            "http://2130706433/",
        ] {
            let url = Url::parse(u).unwrap();
            assert!(rt.block_on(vet(&url)).is_err(), "{u} must be refused");
        }
    }

    #[test]
    fn reads_open_graph_tags() {
        let html = r#"<html><head>
            <title>Fallback &amp; title</title>
            <meta property="og:title" content="Hello &quot;world&quot;">
            <meta property='og:description' content='A  short
               description'>
            <meta property="og:image" content="/img/cover.png">
            <meta name="og:site_name" content="Example">
            </head></html>"#;
        let page = Fetched {
            final_url: Url::parse("https://example.com/post/1").unwrap(),
            content_type: "text/html".into(),
            body: html.as_bytes().to_vec(),
        };
        let p = parse_preview(&page).unwrap();
        assert_eq!(p.title.as_deref(), Some("Hello \"world\""));
        assert_eq!(p.description.as_deref(), Some("A short description"));
        assert_eq!(p.site_name.as_deref(), Some("Example"));
        assert_eq!(
            p.image.as_deref(),
            Some("https://example.com/img/cover.png")
        );
    }

    #[test]
    fn falls_back_to_title_tag_and_skips_empty_pages() {
        let page = Fetched {
            final_url: Url::parse("https://example.com/").unwrap(),
            content_type: "text/html".into(),
            body: b"<title> Plain  page </title>".to_vec(),
        };
        assert_eq!(
            parse_preview(&page).unwrap().title.as_deref(),
            Some("Plain page")
        );

        let empty = Fetched {
            final_url: Url::parse("https://example.com/").unwrap(),
            content_type: "text/html".into(),
            body: b"<html><body>hi</body></html>".to_vec(),
        };
        assert!(parse_preview(&empty).is_none());
    }

    #[test]
    fn javascript_image_urls_are_dropped() {
        let page = Fetched {
            final_url: Url::parse("https://example.com/").unwrap(),
            content_type: "text/html".into(),
            body: br#"<meta property="og:title" content="t"><meta property="og:image" content="javascript:alert(1)">"#
                .to_vec(),
        };
        assert!(parse_preview(&page).unwrap().image.is_none());
    }
}
