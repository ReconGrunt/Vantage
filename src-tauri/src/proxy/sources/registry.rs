// registry.rs — the native mirror of server/sources/registry.js. Two jobs:
//   1. resolve_config(): read the same env vars Node's resolveConfig() reads, so keyed and
//      opt-in ("gray") sources activate identically on the desktop.
//   2. CATALOG + list_sources(): the descriptor table behind GET /api/sources, key-for-key
//      identical to Node's listAdapters() output {id,category,kinds,optin,keyed,enabled,
//      attribution,label}. The incidents/cameras handlers gate the keyed/gray fetches on the
//      same enabled(cfg) predicates, so with no keys the fused source set matches Node exactly.

use serde_json::{json, Value};

/// One configured scanner system (VANTAGE_SCANNER_SYSTEMS="short:lat:lon:Label,...").
#[derive(Clone)]
pub struct ScannerSys {
    pub short_name: String,
    pub lat: f64,
    pub lon: f64,
    pub label: String,
}

/// Resolved runtime config — mirror of Node's resolveConfig() (registry.js:74).
#[derive(Clone, Default)]
pub struct Config {
    pub socrata_token: Option<String>,
    pub airnow_key: Option<String>,
    pub firms_key: Option<String>,
    pub windy_key: Option<String>,
    pub wsdot_key: Option<String>,
    pub tfl_key: Option<String>,
    pub five11_sf_token: Option<String>,
    pub ticketmaster_key: Option<String>,
    pub enable_citizen: bool,
    pub enable_snap: bool,
    pub enable_pulsepoint: bool,
    pub pulsepoint_agencies: Vec<String>,
    pub enable_scanner: bool,
    pub scanner_systems: Vec<ScannerSys>,
    pub bluesky_query: Option<String>,
}

fn env_opt(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
fn env_flag(name: &str) -> bool {
    env_opt(name).as_deref() == Some("1")
}
fn csv(name: &str) -> Vec<String> {
    env_opt(name)
        .map(|s| s.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect())
        .unwrap_or_default()
}
fn parse_scanner(name: &str) -> Vec<ScannerSys> {
    let mut out = Vec::new();
    for tok in env_opt(name).unwrap_or_default().split(',') {
        let parts: Vec<&str> = tok.split(':').collect();
        if parts.len() < 3 {
            continue;
        }
        let short = parts[0].trim();
        let (lat, lon) = match (parts[1].trim().parse::<f64>(), parts[2].trim().parse::<f64>()) {
            (Ok(a), Ok(o)) if a.is_finite() && o.is_finite() => (a, o),
            _ => continue,
        };
        if short.is_empty() {
            continue;
        }
        let label = if parts.len() > 3 && !parts[3].trim().is_empty() { parts[3..].join(":") } else { short.to_string() };
        out.push(ScannerSys { short_name: short.to_string(), lat, lon, label });
    }
    out
}

pub fn resolve_config() -> Config {
    Config {
        socrata_token: env_opt("SOCRATA_APP_TOKEN"),
        airnow_key: env_opt("AIRNOW_KEY"),
        firms_key: env_opt("FIRMS_MAP_KEY"),
        windy_key: env_opt("WINDY_KEY"),
        wsdot_key: env_opt("WSDOT_KEY"),
        tfl_key: env_opt("TFL_APP_KEY"),
        five11_sf_token: env_opt("FIVE11_SF_TOKEN"),
        ticketmaster_key: env_opt("TICKETMASTER_KEY"),
        enable_citizen: env_flag("VANTAGE_ENABLE_CITIZEN"),
        enable_snap: env_flag("VANTAGE_ENABLE_SNAPMAP"),
        enable_pulsepoint: env_flag("VANTAGE_ENABLE_PULSEPOINT"),
        pulsepoint_agencies: csv("VANTAGE_PULSEPOINT_AGENCIES"),
        enable_scanner: env_flag("VANTAGE_ENABLE_SCANNER"),
        scanner_systems: parse_scanner("VANTAGE_SCANNER_SYSTEMS"),
        bluesky_query: env_opt("VANTAGE_BLUESKY_QUERY"),
    }
}

// --- descriptor catalog (order + fields mirror Node's ADAPTERS / listAdapters) -----------

pub struct Descriptor {
    pub id: &'static str,
    pub category: &'static str,
    pub kinds: &'static [&'static str],
    pub keyed: bool,
    pub optin: bool,
    pub attribution: &'static str,
    pub label: &'static str,
    pub enabled: fn(&Config) -> bool,
}

// enabled predicates (fn items so the table can be a const)
fn on(_: &Config) -> bool { true }
fn e_airnow(c: &Config) -> bool { c.airnow_key.is_some() }
fn e_firms(c: &Config) -> bool { c.firms_key.is_some() }
fn e_windy(c: &Config) -> bool { c.windy_key.is_some() }
fn e_wsdot(c: &Config) -> bool { c.wsdot_key.is_some() }
fn e_511(c: &Config) -> bool { c.five11_sf_token.is_some() }
fn e_tm(c: &Config) -> bool { c.ticketmaster_key.is_some() }
fn e_citizen(c: &Config) -> bool { c.enable_citizen }
fn e_pulsepoint(c: &Config) -> bool { c.enable_pulsepoint && !c.pulsepoint_agencies.is_empty() }
fn e_snap(c: &Config) -> bool { c.enable_snap }
fn e_scanner(c: &Config) -> bool { c.enable_scanner && !c.scanner_systems.is_empty() }
fn e_bsky(c: &Config) -> bool { c.bluesky_query.is_some() }

macro_rules! d {
    ($id:expr, $cat:expr, $kinds:expr, $keyed:expr, $optin:expr, $attr:expr, $label:expr, $en:expr) => {
        Descriptor { id: $id, category: $cat, kinds: &$kinds, keyed: $keyed, optin: $optin, attribution: $attr, label: $label, enabled: $en }
    };
}

pub const CATALOG: &[Descriptor] = &[
    // keyless core (always on) — same order as server/sources/registry.js ADAPTERS
    d!("sea-fire-cad", "incidents", ["fire", "medical"], false, false, "Seattle Fire · data.seattle.gov", "Seattle Fire/EMS dispatch", on),
    d!("sf-pd-cad", "incidents", ["police"], false, false, "SFPD · data.sfgov.org", "SF Police dispatch (real-time)", on),
    d!("sf-fire-cad", "incidents", ["fire", "medical"], false, false, "SF Fire · data.sfgov.org", "SF Fire calls", on),
    d!("chi-311", "incidents", ["civic"], false, false, "City of Chicago · data.cityofchicago.org", "Chicago 311 service requests", on),
    d!("chi-crime", "incidents", ["police"], false, false, "Chicago PD · data.cityofchicago.org", "Chicago crimes (7-day lag)", on),
    d!("nyc-311", "incidents", ["civic"], false, false, "NYC OpenData · data.cityofnewyork.us", "NYC 311 service requests", on),
    d!("cin-cad", "incidents", ["police"], false, false, "Cincinnati PD · data.cincinnati-oh.gov", "Cincinnati PD dispatch", on),
    d!("dc-mpd", "incidents", ["police"], false, false, "DC Metropolitan Police · dcgis.dc.gov", "DC Police incidents", on),
    d!("fl511-cam", "cameras", ["camera"], false, false, "Florida DOT · FL511", "Florida DOT cameras", on),
    d!("nws-alerts", "incidents", ["weather", "hazard"], false, false, "US National Weather Service · api.weather.gov", "NWS active alerts", on),
    d!("usgs-quake", "incidents", ["quake"], false, false, "USGS Earthquake Hazards Program", "USGS earthquakes", on),
    d!("usgs-volcano", "incidents", ["hazard"], false, false, "USGS Volcano Hazards Program", "USGS volcano alerts", on),
    d!("iem-lsr", "incidents", ["weather", "hazard"], false, false, "Iowa Environmental Mesonet · NWS", "NWS storm reports (IEM)", on),
    d!("eonet", "incidents", ["fire-wildland", "hazard", "weather"], false, false, "NASA EONET", "NASA EONET natural events", on),
    d!("gdacs", "incidents", ["hazard", "quake", "weather"], false, false, "GDACS · UN/EC", "GDACS global disasters", on),
    d!("nwps", "incidents", ["hazard"], false, false, "NOAA/NWS NWPS", "NWPS flood gauges", on),
    d!("caltrans-lcs", "incidents", ["traffic"], false, false, "Caltrans CWWP2 (no charge)", "Caltrans lane closures (live)", on),
    d!("caltrans-cms", "incidents", ["traffic"], false, false, "Caltrans CWWP2 (no charge)", "Caltrans message signs (live)", on),
    d!("lapd-calls", "incidents", ["police", "fire", "medical", "traffic"], false, false, "LAPD · data.lacity.org", "LAPD calls for service (~5d lag)", on),
    d!("lapd-news", "incidents", ["police"], false, false, "LAPD Online · lapdonline.org", "LAPD news & alerts", on),
    d!("chp-cad", "incidents", ["traffic", "hazard", "police", "medical"], false, false, "California Highway Patrol · cad.chp.ca.gov", "CHP traffic incidents (live)", on),
    d!("caltrans-cam", "cameras", ["camera"], false, false, "Caltrans CWWP2 (no charge)", "Caltrans CCTV", on),
    d!("alertca-cam", "cameras", ["camera"], false, false, "ALERTCalifornia · UC San Diego", "ALERTCalifornia PTZ cameras", on),
    d!("nyc-dot-cam", "cameras", ["camera"], false, false, "NYC DOT · nyctmc.org", "NYC DOT cameras", on),
    d!("tfl-jamcam", "cameras", ["camera"], false, false, "Powered by TfL Open Data", "TfL JamCams (London)", on),
    // keyed-but-free (OFF until an env key is set)
    d!("airnow", "incidents", ["hazard"], true, false, "US EPA AirNow", "AirNow air quality", e_airnow),
    d!("firms", "incidents", ["fire-wildland"], true, false, "NASA FIRMS (VIIRS S-NPP)", "NASA FIRMS wildfire", e_firms),
    d!("windy-cam", "cameras", ["camera"], true, false, "Windy Webcams", "Windy webcams", e_windy),
    d!("wsdot-cam", "cameras", ["camera"], true, false, "WSDOT", "WSDOT cameras (WA)", e_wsdot),
    d!("wsdot-alerts", "incidents", ["traffic"], true, false, "WSDOT", "WSDOT traffic alerts (WA)", e_wsdot),
    d!("511sfbay", "incidents", ["traffic", "civic"], true, false, "511.org · MTC", "511 SF Bay traffic", e_511),
    d!("ticketmaster", "incidents", ["civic"], true, false, "Ticketmaster Discovery", "Ticketmaster events", e_tm),
    // opt-in "gray" (OFF unless an explicit flag is set)
    d!("citizen", "incidents", ["police", "fire", "medical", "hazard"], false, true, "Citizen (unofficial · place-only)", "Citizen incidents", e_citizen),
    d!("pulsepoint", "incidents", ["fire", "medical"], false, true, "PulsePoint (in-the-clear · place-only)", "PulsePoint fire/EMS", e_pulsepoint),
    d!("snapmap", "incidents", ["social"], false, true, "Snap Map (aggregate place-heat only)", "Snap Map activity", e_snap),
    d!("scanner", "incidents", ["police"], false, true, "OpenMHz scanner (aggregate activity)", "Scanner activity", e_scanner),
    d!("bluesky", "incidents", ["social"], false, true, "Bluesky (aggregate place-heat)", "Bluesky social chatter", e_bsky),
];

/// GET /api/sources body — mirror of Node listAdapters(cfg).
pub fn list_sources(cfg: &Config) -> Vec<Value> {
    CATALOG
        .iter()
        .map(|d| {
            json!({
                "id": d.id,
                "category": d.category,
                "kinds": d.kinds,
                "optin": d.optin,
                "keyed": d.keyed,
                "enabled": (d.enabled)(cfg),
                "attribution": d.attribution,
                "label": d.label,
            })
        })
        .collect()
}
