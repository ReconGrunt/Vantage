// la.rs — Los Angeles department feeds. Native mirror of server/sources/{lapd,govrss}.js.
//
// LA publishes no real-time police/fire dispatch, so these are the two best official
// sources that exist:
//
//  · LAPD Calls for Service (Socrata xjgu-z4ju) — the closest thing to dispatch. Lags
//    ~5-7 days and carries NO coordinates, only `area_occ` (the LAPD geographic division:
//    Devonshire, Van Nuys, 77th Street...). We place each call at its DIVISION centroid,
//    which is exactly the precision the data has. Anything finer would be invented.
//
//  · LAPD news/alerts RSS — official press releases, near-real-time for major incidents.
//    X is the other place these go out, but its read API is paid and its syndication
//    endpoint rate-limits (429), so RSS is the correct source: free, legal, structured.
//    lapdonline.org returns 403 to a plain UA, so a browser UA is required.

use serde_json::Value;

use super::{get_json, kind_from_text, make_event, now_ms, parse_iso_ms, s_of, sev_from_text, Bbox};
use crate::server::AppState;

const LA_REGION: (f64, f64, f64, f64) = (33.68, 34.35, -118.68, -118.15);

const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/// The 21 LAPD geographic divisions at their station houses. "Outside" is dropped — calls
/// beyond LAPD jurisdiction have no meaningful location.
const DIVISIONS: &[(&str, f64, f64)] = &[
    ("central", 34.0444, -118.2456),
    ("rampart", 34.0629, -118.2755),
    ("southwest", 34.0181, -118.3081),
    ("hollenbeck", 34.0441, -118.2078),
    ("harbor", 33.7712, -118.2865),
    ("hollywood", 34.0956, -118.3300),
    ("wilshire", 34.0464, -118.3440),
    ("west la", 34.0451, -118.4453),
    ("van nuys", 34.1866, -118.4487),
    ("west valley", 34.2011, -118.5407),
    ("northeast", 34.1122, -118.2093),
    ("77th street", 33.9700, -118.2784),
    ("newton", 34.0107, -118.2586),
    ("pacific", 33.9910, -118.4193),
    ("n hollywood", 34.1716, -118.3800),
    ("foothill", 34.2551, -118.4136),
    ("devonshire", 34.2570, -118.5340),
    ("southeast", 33.9382, -118.2748),
    ("mission", 34.2726, -118.4690),
    ("olympic", 34.0552, -118.2919),
    ("topanga", 34.2013, -118.6015),
];

fn division_at(name: &str) -> Option<(f64, f64)> {
    let n = name.trim().to_lowercase();
    DIVISIONS.iter().find(|(d, _, _)| *d == n).map(|(_, la, lo)| (*la, *lo))
}

/// First division mentioned anywhere in a blob of text (for news posts).
fn division_in_text(text: &str) -> Option<(&'static str, f64, f64)> {
    let t = text.to_lowercase();
    DIVISIONS.iter().find(|(d, _, _)| t.contains(*d)).map(|(d, la, lo)| (*d, *la, *lo))
}

fn is_noise(call: &str) -> bool {
    let c = call.to_lowercase();
    ["traffic stop", "code 6", "code six", "follow-up", "follow up", "premise check", "report only"]
        .iter()
        .any(|w| c.contains(w))
}

// --- LAPD Calls for Service ---------------------------------------------------------
pub async fn lapd_calls(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    if !b.intersects(LA_REGION) {
        return Ok(vec![]);
    }
    let url = "https://data.lacity.org/resource/xjgu-z4ju.json\
?$limit=400&$order=dispatch_date%20DESC,dispatch_time%20DESC";
    let rows = get_json(st, url, "application/json").await?;
    let arr = match rows.as_array() {
        Some(a) => a,
        None => return Ok(vec![]),
    };
    let mut out = Vec::new();
    for r in arr {
        let area = s_of(r, "area_occ");
        let (la, lo) = match division_at(area) {
            Some(x) => x,
            None => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let call = s_of(r, "call_type_text").trim().to_string();
        if call.is_empty() || is_noise(&call) {
            continue;
        }
        let date = s_of(r, "dispatch_date");
        let time = s_of(r, "dispatch_time");
        let stamp = format!("{}T{}Z", date.chars().take(10).collect::<String>(), if time.is_empty() { "00:00:00" } else { time });
        let ts = parse_iso_ms(&stamp).unwrap_or_else(now_ms);
        let k = kind_from_text(&call);
        let kind = if k == "civic" { "police" } else { k };
        let native = {
            let n = s_of(r, "incident_number");
            if n.is_empty() { format!("{}:{}:{}", area, date, time) } else { n.to_string() }
        };
        if let Some(ev) = make_event(
            "lapd-calls", &native, kind, sev_from_text(&call), la, lo, &call,
            &format!("LAPD {} Division (division-level location)", area),
            Value::from("https://data.lacity.org/resource/xjgu-z4ju"), ts, Value::Null,
        ) {
            out.push(ev);
        }
    }
    Ok(out)
}

// --- LAPD news / alerts RSS -----------------------------------------------------------
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    for ch in s.replace("<![CDATA[", "").replace("]]>", "").chars() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            c if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn tag_value(block: &str, tag: &str) -> String {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let start = match block.find(&open) {
        Some(i) => match block[i..].find('>') {
            Some(j) => i + j + 1,
            None => return String::new(),
        },
        None => return String::new(),
    };
    let end = match block[start..].find(&close) {
        Some(j) => start + j,
        None => return String::new(),
    };
    strip_tags(&block[start..end])
}

pub async fn lapd_news(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    if !b.intersects(LA_REGION) {
        return Ok(vec![]);
    }
    // lapdonline.org's WAF fingerprints the TLS/ALPN handshake and refuses the default
    // h2-advertising client at the transport layer (Node/undici, HTTP/1.1-only, is accepted).
    // Use the dedicated HTTP/1.1 client + a fuller browser header set to match undici.
    let r = st
        .http1
        .get("https://www.lapdonline.org/feed/")
        .header("User-Agent", BROWSER_UA)
        .header("Accept", "application/rss+xml, application/xml, text/xml, */*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(err_chain)?;
    if !r.status().is_success() {
        return Err(format!("{} for lapdonline feed", r.status()));
    }
    let xml = r.text().await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for chunk in xml.split("<item").skip(1) {
        let block = match chunk.find("</item>") {
            Some(i) => &chunk[..i],
            None => chunk,
        };
        let title = tag_value(block, "title");
        if title.is_empty() {
            continue;
        }
        let desc = tag_value(block, "description");
        let link = tag_value(block, "link");
        let guid = tag_value(block, "guid");
        let blob = format!("{} {}", title, desc);
        let (where_, la, lo) = match division_in_text(&blob) {
            Some((d, a, o)) => (d, a, o),
            None => ("", 34.0522, -118.2437), // city centroid
        };
        if !b.contains(la, lo) {
            continue;
        }
        let ts = parse_iso_ms(&tag_value(block, "pubDate")).unwrap_or_else(now_ms);
        let k = kind_from_text(&blob);
        let kind = if k == "civic" { "police" } else { k };
        let native = if !guid.is_empty() { guid } else { title.clone() };
        let description = if where_.is_empty() {
            desc.chars().take(200).collect::<String>()
        } else {
            format!("{} division · {}", where_, desc.chars().take(180).collect::<String>())
        };
        if let Some(ev) = make_event(
            "lapd-news", &native, kind, sev_from_text(&blob), la, lo, &title, &description,
            Value::from(if link.is_empty() { "https://www.lapdonline.org".to_string() } else { link }),
            ts, Value::Null,
        ) {
            out.push(ev);
        }
    }
    Ok(out)
}

// --- CHP CAD live traffic incidents ---------------------------------------------------
// The only genuinely real-time public dispatch feed for LA. cad.chp.ca.gov is an ASP.NET
// WebForms page, so we drive it like a browser: GET (harvest __VIEWSTATE + cookies) then
// POST ddlComCenter=LACC and scrape the gvIncidents table. The list has no coordinates —
// only the dispatching CHP "Area" office — so, as with LAPD divisions, each incident is
// placed at that office's centroid. Native mirror of server/sources/chp.js.
const CHP_URL: &str = "https://cad.chp.ca.gov/Traffic.aspx";
const CHP_CENTER: &str = "LACC";
const CHP_REGION: (f64, f64, f64, f64) = (33.68, 34.82, -118.95, -117.6);

// The 10 CHP Area offices dispatched by LACC (+ Castaic CVEF), keyed by the exact "Area"
// string the CAD table prints; coordinates are the geocoded office addresses.
const CHP_AREAS: &[(&str, f64, f64)] = &[
    ("central la", 34.0345, -118.2722),
    ("east la", 34.0243, -118.1327),
    ("south la", 33.8430, -118.2792),
    ("west la", 33.9868, -118.3872),
    ("altadena", 34.1878, -118.1465),
    ("baldwin park", 34.0645, -117.9730),
    ("santa fe springs", 33.9445, -118.0648),
    ("west valley", 34.1815, -118.5885),
    ("newhall", 34.4128, -118.5670),
    ("antelope valley", 34.6890, -118.1640),
    ("castaic", 34.4361, -118.5936),
];

/// Walk an error's `source()` chain into one string — turns reqwest's opaque
/// "error sending request" into the real cause (TLS handshake / reset / timeout).
fn err_chain(e: reqwest::Error) -> String {
    let mut s = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(inner) = src {
        s.push_str(" <- ");
        s.push_str(&inner.to_string());
        src = inner.source();
    }
    s
}

fn chp_area(name: &str) -> Option<(f64, f64)> {
    let n = name.trim().to_lowercase();
    CHP_AREAS.iter().find(|(a, _, _)| *a == n).map(|(_, la, lo)| (*la, *lo))
}

/// Value of a hidden `<input id="…" … value="…">` (id precedes value in ASP.NET markup).
fn hidden_value(html: &str, id: &str) -> String {
    let anchor = match html.find(&format!("id=\"{}\"", id)) {
        Some(i) => &html[i..],
        None => return String::new(),
    };
    let vstart = match anchor.find("value=\"") {
        Some(i) => &anchor[i + 7..],
        None => return String::new(),
    };
    match vstart.find('"') {
        Some(e) => vstart[..e].to_string(),
        None => String::new(),
    }
}

fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Extract the gvIncidents rows as cell-string vectors: [Details, No, Time, Type, Loc, LocDesc, Area].
fn parse_chp_rows(html: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let tbl_start = match html.find("id=\"gvIncidents\"") {
        Some(i) => i,
        None => return rows,
    };
    let tbl_end = html[tbl_start..].find("</table>").map(|e| tbl_start + e).unwrap_or(html.len());
    let tbl = &html[tbl_start..tbl_end];
    let mut idx = 0;
    while let Some(tr_rel) = tbl[idx..].find("<tr") {
        let tr_start = idx + tr_rel;
        let tr_close = match tbl[tr_start..].find("</tr>") {
            Some(e) => tr_start + e,
            None => break,
        };
        let row = &tbl[tr_start..tr_close];
        let mut cells = Vec::new();
        let mut cidx = 0;
        while let Some(td_rel) = row[cidx..].find("<td") {
            let td_start = cidx + td_rel;
            let gt = match row[td_start..].find('>') {
                Some(g) => td_start + g + 1,
                None => break,
            };
            let td_close = match row[gt..].find("</td>") {
                Some(e) => gt + e,
                None => break,
            };
            cells.push(decode_entities(&strip_tags(&row[gt..td_close])));
            cidx = td_close + 5;
        }
        if cells.len() >= 6 {
            rows.push(cells);
        }
        idx = tr_close + 5;
    }
    rows
}

pub async fn chp_cad(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    if !b.intersects(CHP_REGION) {
        return Ok(vec![]);
    }
    // 1. GET the page for viewstate + session/F5 cookies.
    let g = st
        .http
        .get(CHP_URL)
        .header("User-Agent", BROWSER_UA)
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !g.status().is_success() {
        return Err(format!("{} for CHP CAD page", g.status()));
    }
    let cookie = g
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|c| c.split(';').next())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    let html = g.text().await.map_err(|e| e.to_string())?;
    let vs = hidden_value(&html, "__VIEWSTATE");
    let vsg = hidden_value(&html, "__VIEWSTATEGENERATOR");
    if vs.is_empty() {
        return Err("CHP CAD: no __VIEWSTATE (page shape changed)".into());
    }
    // 2. POST the LA Communications Center selection.
    let form = [
        ("__EVENTTARGET", "ddlComCenter"),
        ("__EVENTARGUMENT", ""),
        ("__VIEWSTATE", vs.as_str()),
        ("__VIEWSTATEGENERATOR", vsg.as_str()),
        ("ddlComCenter", CHP_CENTER),
    ];
    let p = st
        .http
        .post(CHP_URL)
        .header("User-Agent", BROWSER_UA)
        .header("Accept", "text/html")
        .header("Referer", CHP_URL)
        .header("Cookie", cookie)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !p.status().is_success() {
        return Err(format!("{} for CHP CAD {}", p.status(), CHP_CENTER));
    }
    let page = p.text().await.map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for cells in parse_chp_rows(&page) {
        let area = cells.get(6).map(String::as_str).unwrap_or("");
        let (la, lo) = match chp_area(area) {
            Some(x) => x,
            None => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let no = cells.get(1).map(String::as_str).unwrap_or("");
        let time = cells.get(2).map(String::as_str).unwrap_or("");
        let typ = cells.get(3).map(String::as_str).unwrap_or("");
        let loc = cells.get(4).map(String::as_str).unwrap_or("").trim();
        let locdesc = cells.get(5).map(String::as_str).unwrap_or("").trim();
        let title = if typ.is_empty() { "CHP incident" } else { typ };
        let where_ = [loc, locdesc].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" · ");
        let k = kind_from_text(title);
        let kind = if k == "civic" { "traffic" } else { k };
        let native = if no.is_empty() { format!("{}:{}:{}", area, time, title) } else { no.to_string() };
        let desc = format!(
            "{}CHP {} area{} (area-level location)",
            if where_.is_empty() { String::new() } else { format!("{} — ", where_) },
            area,
            if time.is_empty() { String::new() } else { format!(", reported {}", time) },
        );
        if let Some(ev) = make_event(
            "chp-cad", &native, kind, sev_from_text(title), la, lo, title, &desc,
            Value::from("https://cad.chp.ca.gov/Traffic.aspx"), now_ms(), Value::Null,
        ) {
            out.push(ev);
        }
    }
    Ok(out)
}
