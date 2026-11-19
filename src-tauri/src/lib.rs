use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::Manager;
use tokio::sync::RwLock;
use yup_oauth2::{ServiceAccountAuthenticator, ServiceAccountKey, read_service_account_key};
use zeroize::Zeroizing;

const SCOPE: &str = "https://www.googleapis.com/auth/webmasters.readonly";
const PAGESPEED_SCOPE: &str = "openid";
const API_ROOT: &str = "https://searchconsole.googleapis.com/webmasters/v3";
const PAGESPEED_API: &str =
    "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed";
const CACHE_TTL: Duration = Duration::from_secs(60 * 60);

struct CacheEntry {
    stored_at: Instant,
    value: Value,
}

static RESPONSE_CACHE: OnceLock<RwLock<HashMap<String, CacheEntry>>> = OnceLock::new();
static CREDENTIALS_DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CredentialIndex {
    active_id: Option<String>,
    #[serde(default)]
    profiles: Vec<CredentialProfile>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CredentialProfile {
    id: String,
    client_email: String,
    project_id: String,
    private_key_id: String,
    #[serde(default)]
    sites: Vec<Site>,
}

fn credential_directory() -> Result<&'static PathBuf, String> {
    CREDENTIALS_DIR
        .get()
        .ok_or_else(|| "Secure credential storage is not initialized".to_string())
}

fn credential_index_path() -> Result<PathBuf, String> {
    Ok(credential_directory()?.join("accounts.json"))
}

async fn read_credential_index() -> Result<CredentialIndex, String> {
    let path = credential_index_path()?;
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("The credential index is damaged: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(CredentialIndex::default())
        }
        Err(error) => Err(format!("Could not read the credential index: {error}")),
    }
}

async fn write_credential_index(index: &CredentialIndex) -> Result<(), String> {
    let directory = credential_directory()?;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("Could not create secure credential storage: {error}"))?;
    let path = credential_index_path()?;
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(index)
        .map_err(|error| format!("Could not serialize credential metadata: {error}"))?;
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(|error| format!("Could not write credential metadata: {error}"))?;
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|error| format!("Could not replace credential metadata: {error}"))?;
    }
    tokio::fs::rename(temporary, path)
        .await
        .map_err(|error| format!("Could not finalize credential metadata: {error}"))
}

#[cfg(windows)]
fn protect_secret(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(format!(
            "Windows could not encrypt the credential: {}",
            std::io::Error::last_os_error()
        ));
    }
    let encrypted = unsafe {
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut std::ffi::c_void);
        bytes
    };
    Ok(encrypted)
}

#[cfg(windows)]
fn unprotect_secret(data: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(format!(
            "Windows could not decrypt the credential for this user: {}",
            std::io::Error::last_os_error()
        ));
    }
    let decrypted = unsafe {
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut std::ffi::c_void);
        bytes
    };
    Ok(Zeroizing::new(decrypted))
}

#[cfg(not(windows))]
fn protect_secret(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("Secure service-account import is currently supported on Windows only".to_string())
}

#[cfg(not(windows))]
fn unprotect_secret(_: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    Err("Secure service-account import is currently supported on Windows only".to_string())
}

fn response_cache() -> &'static RwLock<HashMap<String, CacheEntry>> {
    RESPONSE_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

async fn read_cache(key: &str) -> Option<Value> {
    let cache = response_cache().read().await;
    let entry = cache.get(key)?;
    (entry.stored_at.elapsed() < CACHE_TTL).then(|| entry.value.clone())
}

async fn write_cache(key: String, value: Value) {
    let mut cache = response_cache().write().await;
    cache.retain(|_, entry| entry.stored_at.elapsed() < CACHE_TTL);
    cache.insert(
        key,
        CacheEntry {
            stored_at: Instant::now(),
            value,
        },
    );
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Site {
    site_url: String,
    permission_level: String,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct MetricRow {
    #[serde(default)]
    keys: Vec<String>,
    #[serde(default)]
    clicks: f64,
    #[serde(default)]
    impressions: f64,
    #[serde(default)]
    ctr: f64,
    #[serde(default)]
    position: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PerformanceData {
    summary: MetricRow,
    daily: Vec<MetricRow>,
    rows: Vec<MetricRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Recommendation {
    category: String,
    title: String,
    description: String,
    page: String,
    change_percent: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sitemap {
    path: String,
    #[serde(default)]
    last_submitted: Option<String>,
    #[serde(default)]
    last_downloaded: Option<String>,
    #[serde(default)]
    is_pending: Option<bool>,
    #[serde(default)]
    is_sitemaps_index: Option<bool>,
    #[serde(default, rename = "type")]
    type_: Option<String>,
    #[serde(default)]
    warnings: Option<String>,
    #[serde(default)]
    errors: Option<String>,
    #[serde(default)]
    contents: Vec<SitemapContent>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SitemapContent {
    #[serde(default, rename = "type")]
    type_: Option<String>,
    #[serde(default)]
    submitted: Option<String>,
    #[serde(default)]
    indexed: Option<String>,
}

fn credentials_path() -> PathBuf {
    if let Ok(path) = std::env::var("GSC_CREDENTIALS_PATH") {
        return PathBuf::from(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.env.json")
}

async fn active_service_account_key() -> Result<ServiceAccountKey, String> {
    if CREDENTIALS_DIR.get().is_some() {
        let index = read_credential_index().await?;
        if let Some(active_id) = index.active_id {
            let encrypted_path = credential_directory()?.join(format!("{active_id}.bin"));
            let encrypted = tokio::fs::read(&encrypted_path)
                .await
                .map_err(|error| format!("Could not read the encrypted credential: {error}"))?;
            let decrypted = unprotect_secret(&encrypted)?;
            return serde_json::from_slice(&decrypted)
                .map_err(|error| format!("Could not decode the encrypted credential: {error}"));
        }
    }
    let path = credentials_path();
    read_service_account_key(&path)
        .await
        .map_err(|error| format!("Unable to read credentials at {}: {error}", path.display()))
}

async fn access_token_for_key(key: ServiceAccountKey) -> Result<String, String> {
    access_token_for_key_with_scopes(key, &[SCOPE]).await
}

async fn access_token_for_key_with_scopes(
    key: ServiceAccountKey,
    scopes: &[&str],
) -> Result<String, String> {
    let auth = ServiceAccountAuthenticator::builder(key)
        .build()
        .await
        .map_err(|error| format!("Unable to initialize Google authentication: {error}"))?;
    let token = auth
        .token(scopes)
        .await
        .map_err(|error| format!("Google authentication failed: {error}"))?;
    token
        .token()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Google returned an empty access token".to_string())
}

async fn access_token() -> Result<String, String> {
    access_token_for_key(active_service_account_key().await?).await
}

async fn google_get(path: &str) -> Result<Value, String> {
    let cache_key = format!("GET:{path}");
    if let Some(value) = read_cache(&cache_key).await {
        return Ok(value);
    }
    let response = reqwest::Client::new()
        .get(format!("{API_ROOT}{path}"))
        .bearer_auth(access_token().await?)
        .send()
        .await
        .map_err(|error| format!("Could not reach Search Console: {error}"))?;
    let value = parse_response(response).await?;
    write_cache(cache_key, value.clone()).await;
    Ok(value)
}

async fn google_post(path: &str, body: Value) -> Result<Value, String> {
    let cache_key = format!("POST:{path}:{body}");
    if let Some(value) = read_cache(&cache_key).await {
        return Ok(value);
    }
    let response = reqwest::Client::new()
        .post(format!("{API_ROOT}{path}"))
        .bearer_auth(access_token().await?)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Could not reach Search Console: {error}"))?;
    let value = parse_response(response).await?;
    write_cache(cache_key, value.clone()).await;
    Ok(value)
}

async fn parse_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read Google's response: {error}"))?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| value.pointer("/error/message")?.as_str().map(str::to_owned))
            .unwrap_or(body);
        return Err(format!("Search Console returned {status}: {detail}"));
    }
    serde_json::from_str(&body).map_err(|error| format!("Invalid response from Google: {error}"))
}

#[tauri::command]
async fn list_sites() -> Result<Vec<Site>, String> {
    let value = google_get("/sites").await?;
    serde_json::from_value(value.get("siteEntry").cloned().unwrap_or_else(|| json!([])))
        .map_err(|error| format!("Could not decode Search Console properties: {error}"))
}

async fn list_sites_with_token(token: &str) -> Result<Vec<Site>, String> {
    let response = reqwest::Client::new()
        .get(format!("{API_ROOT}/sites"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("Could not reach Search Console: {error}"))?;
    let value = parse_response(response).await?;
    serde_json::from_value(value.get("siteEntry").cloned().unwrap_or_else(|| json!([])))
        .map_err(|error| format!("Could not decode Search Console properties: {error}"))
}

#[tauri::command]
async fn has_credentials() -> Result<bool, String> {
    if let Ok(directory) = credential_directory() {
        let index = read_credential_index().await?;
        if let Some(active_id) = index.active_id {
            if tokio::fs::try_exists(directory.join(format!("{active_id}.bin")))
                .await
                .unwrap_or(false)
            {
                return Ok(true);
            }
        }
    }
    Ok(credentials_path().is_file())
}

#[tauri::command]
async fn list_credential_profiles() -> Result<Vec<CredentialProfile>, String> {
    Ok(read_credential_index().await?.profiles)
}

#[tauri::command]
async fn import_service_account(path: String) -> Result<CredentialProfile, String> {
    let source = PathBuf::from(path);
    if source.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err("Select a Google service-account .json file".to_string());
    }
    let metadata = tokio::fs::metadata(&source)
        .await
        .map_err(|error| format!("Could not inspect the selected file: {error}"))?;
    if metadata.len() > 32 * 1024 {
        return Err("The credential file is larger than the 32 KB safety limit".to_string());
    }
    let plaintext = Zeroizing::new(
        tokio::fs::read(&source)
            .await
            .map_err(|error| format!("Could not read the selected credential: {error}"))?,
    );
    let key: ServiceAccountKey = serde_json::from_slice(&plaintext)
        .map_err(|_| "This is not a valid Google service-account JSON file".to_string())?;
    if key.key_type.as_deref() != Some("service_account")
        || key.client_email.trim().is_empty()
        || !key.client_email.ends_with(".iam.gserviceaccount.com")
        || !key.private_key.contains("BEGIN PRIVATE KEY")
        || key.token_uri != "https://oauth2.googleapis.com/token"
    {
        return Err(
            "The selected JSON does not contain a valid Google service account".to_string(),
        );
    }
    let token = access_token_for_key(key.clone()).await?;
    let sites = list_sites_with_token(&token).await?;
    if sites.is_empty() {
        return Err(format!(
            "Authentication succeeded, but {} has no Search Console properties. Add this email as a user on the property first.",
            key.client_email
        ));
    }

    let mut index = read_credential_index().await?;
    let existing = index
        .profiles
        .iter()
        .position(|profile| profile.client_email == key.client_email);
    let id = existing
        .map(|position| index.profiles[position].id.clone())
        .unwrap_or_else(|| {
            format!(
                "gsc-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            )
        });
    let profile = CredentialProfile {
        id: id.clone(),
        client_email: key.client_email.clone(),
        project_id: key.project_id.clone().unwrap_or_default(),
        private_key_id: key.private_key_id.clone().unwrap_or_default(),
        sites,
    };
    let encrypted = protect_secret(&plaintext)?;
    let directory = credential_directory()?;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("Could not create secure credential storage: {error}"))?;
    let destination = directory.join(format!("{id}.bin"));
    let temporary = destination.with_extension("tmp");
    tokio::fs::write(&temporary, encrypted)
        .await
        .map_err(|error| format!("Could not write the encrypted credential: {error}"))?;
    if tokio::fs::try_exists(&destination).await.unwrap_or(false) {
        tokio::fs::remove_file(&destination)
            .await
            .map_err(|error| format!("Could not replace the encrypted credential: {error}"))?;
    }
    tokio::fs::rename(temporary, destination)
        .await
        .map_err(|error| format!("Could not finalize the encrypted credential: {error}"))?;

    if let Some(position) = existing {
        index.profiles[position] = profile.clone();
    } else {
        index.profiles.push(profile.clone());
    }
    index.active_id = Some(id);
    write_credential_index(&index).await?;
    response_cache().write().await.clear();
    Ok(profile)
}

#[tauri::command]
async fn activate_credential(id: String) -> Result<Vec<Site>, String> {
    let mut index = read_credential_index().await?;
    let profile = index
        .profiles
        .iter()
        .find(|profile| profile.id == id)
        .cloned()
        .ok_or_else(|| "Credential profile not found".to_string())?;
    index.active_id = Some(id);
    write_credential_index(&index).await?;
    response_cache().write().await.clear();
    Ok(profile.sites)
}

async fn analytics_query(
    site_url: &str,
    start_date: &str,
    end_date: &str,
    dimensions: Vec<&str>,
    row_limit: u32,
    search_type: &str,
    filter: Option<(&str, &str, &str)>,
) -> Result<Vec<MetricRow>, String> {
    let mut body = json!({
        "startDate": start_date,
        "endDate": end_date,
        "dimensions": dimensions,
        "type": search_type,
        "dataState": "final",
        "rowLimit": row_limit
    });
    if let Some((dimension, operator, expression)) = filter {
        body["dimensionFilterGroups"] = json!([{
            "groupType": "and",
            "filters": [{
                "dimension": dimension,
                "operator": operator,
                "expression": expression
            }]
        }]);
    }
    let value = google_post(
        &format!(
            "/sites/{}/searchAnalytics/query",
            urlencoding::encode(site_url)
        ),
        body,
    )
    .await?;
    serde_json::from_value(value.get("rows").cloned().unwrap_or_else(|| json!([])))
        .map_err(|error| format!("Could not decode performance data: {error}"))
}

#[tauri::command]
async fn get_performance(
    site_url: String,
    start_date: String,
    end_date: String,
    dimension: String,
    search_type: String,
    filter_dimension: Option<String>,
    filter_operator: Option<String>,
    filter_expression: Option<String>,
) -> Result<PerformanceData, String> {
    let dimension = match dimension.as_str() {
        "page" | "country" | "device" | "searchAppearance" | "date" => dimension,
        _ => "query".to_string(),
    };
    let search_type = match search_type.as_str() {
        "image" | "video" | "news" | "discover" | "googleNews" => search_type,
        _ => "web".to_string(),
    };
    let filter = match (
        filter_dimension.as_deref(),
        filter_operator.as_deref(),
        filter_expression.as_deref(),
    ) {
        (
            Some(dimension @ ("query" | "page" | "country" | "device" | "searchAppearance")),
            Some(operator @ ("contains" | "equals")),
            Some(expression),
        ) if !expression.trim().is_empty() => Some((dimension, operator, expression)),
        _ => None,
    };
    let (summary, daily, rows) = tokio::join!(
        analytics_query(
            &site_url,
            &start_date,
            &end_date,
            vec![],
            1,
            &search_type,
            filter
        ),
        analytics_query(
            &site_url,
            &start_date,
            &end_date,
            vec!["date"],
            5000,
            &search_type,
            filter
        ),
        analytics_query(
            &site_url,
            &start_date,
            &end_date,
            vec![dimension.as_str()],
            25000,
            &search_type,
            filter
        )
    );
    Ok(PerformanceData {
        summary: summary?.into_iter().next().unwrap_or_default(),
        daily: daily?,
        rows: rows?,
    })
}

#[tauri::command]
async fn get_recommendations(
    site_url: String,
    current_start: String,
    current_end: String,
    previous_start: String,
    previous_end: String,
) -> Result<Vec<Recommendation>, String> {
    let (current, previous) = tokio::join!(
        analytics_query(
            &site_url,
            &current_start,
            &current_end,
            vec!["page"],
            5000,
            "web",
            None
        ),
        analytics_query(
            &site_url,
            &previous_start,
            &previous_end,
            vec!["page"],
            5000,
            "web",
            None
        )
    );
    let current = current?;
    let previous = previous?;
    let current_by_page: HashMap<String, f64> = current
        .into_iter()
        .filter_map(|row| Some((row.keys.first()?.clone(), row.impressions)))
        .collect();
    let previous_by_page: HashMap<String, f64> = previous
        .into_iter()
        .filter_map(|row| Some((row.keys.first()?.clone(), row.impressions)))
        .collect();
    let mut changes: Vec<(String, f64, f64, f64)> = current_by_page
        .keys()
        .chain(previous_by_page.keys())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .filter_map(|page| {
            let current = *current_by_page.get(page).unwrap_or(&0.0);
            let previous = *previous_by_page.get(page).unwrap_or(&0.0);
            let difference = current - previous;
            let percent = if previous > 0.0 {
                difference / previous * 100.0
            } else if current >= 25.0 {
                100.0
            } else {
                0.0
            };
            let enough_data = current.max(previous) >= 25.0 && difference.abs() >= 15.0;
            (enough_data && percent.abs() >= 30.0)
                .then(|| (page.clone(), current, previous, percent))
        })
        .collect();
    changes.sort_by(|a, b| {
        (b.1 - b.2)
            .abs()
            .partial_cmp(&(a.1 - a.2).abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(changes
        .into_iter()
        .take(2)
        .map(|(page, _, _, percent)| {
            let increased = percent > 0.0;
            Recommendation {
                category: if increased { "opportunity" } else { "issue" }.to_string(),
                title: format!(
                    "A page recently got {} impressions than usual",
                    if increased { "more" } else { "fewer" }
                ),
                description: "Based on the last 7 finalized days compared with the previous 7 days"
                    .to_string(),
                page,
                change_percent: percent.round() as i64,
            }
        })
        .collect())
}

#[tauri::command]
async fn list_sitemaps(site_url: String) -> Result<Vec<Sitemap>, String> {
    let value = google_get(&format!(
        "/sites/{}/sitemaps",
        urlencoding::encode(&site_url)
    ))
    .await?;
    serde_json::from_value(value.get("sitemap").cloned().unwrap_or_else(|| json!([])))
        .map_err(|error| format!("Could not decode sitemaps: {error}"))
}

const LIGHTHOUSE_METRICS: [&str; 7] = [
    "largest-contentful-paint",
    "interaction-to-next-paint",
    "cumulative-layout-shift",
    "total-blocking-time",
    "first-contentful-paint",
    "speed-index",
    "server-response-time",
];

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LighthouseCategory {
    id: String,
    title: String,
    score: Option<f64>,
    #[serde(default)]
    audit_refs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LighthouseAudit {
    id: String,
    title: String,
    description: String,
    score: Option<f64>,
    score_display_mode: String,
    display_value: Option<String>,
    numeric_value: Option<f64>,
    numeric_unit: Option<String>,
    category: Option<String>,
    savings_ms: Option<f64>,
    savings_bytes: Option<f64>,
    #[serde(default)]
    details: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PassedAudit {
    id: String,
    title: String,
    category: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LighthouseReport {
    requested_url: String,
    final_url: String,
    fetch_time: String,
    lighthouse_version: String,
    strategy: String,
    form_factor: Option<String>,
    duration_ms: u64,
    categories: Vec<LighthouseCategory>,
    metrics: Vec<LighthouseAudit>,
    audits: Vec<LighthouseAudit>,
    passed: Vec<PassedAudit>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LighthouseEnvironment {
    node_installed: bool,
    browser_installed: bool,
    local_cli_available: bool,
    local_available: bool,
}

fn shorten(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let mut value: String = trimmed.chars().take(limit).collect();
    value.push('…');
    value
}

fn trim_lighthouse_item(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut trimmed = serde_json::Map::new();
            for (key, item) in map {
                match key.as_str() {
                    "node" => {
                        trimmed.insert(
                            "node".to_string(),
                            json!({
                                "snippet": shorten(item.get("snippet").and_then(Value::as_str).unwrap_or_default(), 90),
                                "selector": shorten(item.get("selector").and_then(Value::as_str).unwrap_or_default(), 120),
                            }),
                        );
                    }
                    "screenshot" | "data" | "trace" | "timing" | "subItems" => {}
                    "url" => {
                        let text = item.as_str().unwrap_or_default();
                        let value = if text.starts_with("data:") {
                            "(inline data)".to_string()
                        } else {
                            shorten(text, 180)
                        };
                        trimmed.insert(key.clone(), json!(value));
                    }
                    _ => {
                        trimmed.insert(key.clone(), trim_lighthouse_item(item));
                    }
                }
            }
            Value::Object(trimmed)
        }
        Value::Array(items) => {
            Value::Array(items.iter().take(10).map(trim_lighthouse_item).collect())
        }
        Value::String(text) => json!(shorten(text, 220)),
        other => other.clone(),
    }
}

fn trim_lighthouse_details(details: &Value) -> Option<Value> {
    let kind = details.get("type").and_then(Value::as_str)?;
    if matches!(
        kind,
        "screenshot" | "filmstrip" | "full-page-screenshot" | "debugdata" | "treemap-data"
    ) {
        return None;
    }
    let headings: Vec<Value> = details
        .get("headings")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|heading| {
                    json!({
                        "key": heading.get("key").and_then(Value::as_str),
                        "label": heading.get("label").and_then(Value::as_str),
                        "valueType": heading.get("valueType").and_then(Value::as_str),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let items: Vec<Value> = details
        .get("items")
        .and_then(Value::as_array)
        .map(|items| items.iter().take(10).map(trim_lighthouse_item).collect())
        .unwrap_or_default();
    Some(json!({ "type": kind, "headings": headings, "items": items }))
}

fn parse_lighthouse_report(
    report: &Value,
    strategy: &str,
    duration_ms: u64,
) -> Result<LighthouseReport, String> {
    let audit_values = report
        .get("audits")
        .and_then(Value::as_object)
        .ok_or_else(|| "Lighthouse returned an empty report".to_string())?;
    let mut categories = Vec::new();
    let mut audit_categories: HashMap<String, String> = HashMap::new();
    if let Some(values) = report.get("categories").and_then(Value::as_object) {
        for (id, category) in values {
            let refs: Vec<String> = category
                .get("auditRefs")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            item.get("id")
                                .and_then(Value::as_str)
                                .map(ToOwned::to_owned)
                        })
                        .collect()
                })
                .unwrap_or_default();
            for reference in &refs {
                audit_categories
                    .entry(reference.clone())
                    .or_insert_with(|| id.clone());
            }
            categories.push(LighthouseCategory {
                id: id.clone(),
                title: category
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                score: category.get("score").and_then(Value::as_f64),
                audit_refs: refs,
            });
        }
    }

    let mut metrics = Vec::new();
    let mut audits = Vec::new();
    let mut passed = Vec::new();
    for (id, audit) in audit_values {
        let score_display_mode = audit
            .get("scoreDisplayMode")
            .and_then(Value::as_str)
            .unwrap_or("numeric")
            .to_string();
        let score = audit.get("score").and_then(Value::as_f64);
        let title = audit
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_string();
        let category = audit_categories.get(id).cloned();
        let savings_ms = audit
            .get("details")
            .and_then(|details| details.get("overallSavingsMs"))
            .and_then(Value::as_f64)
            .or_else(|| {
                audit
                    .get("metricSavings")
                    .and_then(Value::as_object)
                    .map(|values| {
                        values
                            .values()
                            .filter_map(Value::as_f64)
                            .fold(0.0_f64, f64::max)
                    })
            });
        let savings_bytes = audit
            .get("details")
            .and_then(|details| details.get("overallSavingsBytes"))
            .and_then(Value::as_f64)
            .or_else(|| {
                audit
                    .get("details")
                    .and_then(|details| details.get("debugData"))
                    .and_then(|debug| debug.get("wastedBytes"))
                    .and_then(Value::as_f64)
            });

        if LIGHTHOUSE_METRICS.contains(&id.as_str()) {
            metrics.push(LighthouseAudit {
                id: id.clone(),
                title,
                description: shorten(
                    audit
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    500,
                ),
                score,
                score_display_mode,
                display_value: audit
                    .get("displayValue")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                numeric_value: audit.get("numericValue").and_then(Value::as_f64),
                numeric_unit: audit
                    .get("numericUnit")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                category,
                savings_ms,
                savings_bytes,
                details: None,
            });
            continue;
        }

        if matches!(
            score_display_mode.as_str(),
            "notApplicable" | "manual" | "error" | "informative"
        ) {
            continue;
        }

        if score == Some(1.0) {
            passed.push(PassedAudit {
                id: id.clone(),
                title,
                category,
            });
            continue;
        }

        audits.push(LighthouseAudit {
            id: id.clone(),
            title,
            description: shorten(
                audit
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                500,
            ),
            score,
            score_display_mode,
            display_value: audit
                .get("displayValue")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            numeric_value: audit.get("numericValue").and_then(Value::as_f64),
            numeric_unit: audit
                .get("numericUnit")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            category,
            savings_ms,
            savings_bytes,
            details: audit.get("details").and_then(trim_lighthouse_details),
        });
    }

    metrics.sort_by_key(|audit| {
        LIGHTHOUSE_METRICS
            .iter()
            .position(|id| *id == audit.id)
            .unwrap_or(usize::MAX)
    });
    audits.sort_by(|left, right| {
        let left_weight =
            left.savings_ms.unwrap_or(0.0) + left.savings_bytes.unwrap_or(0.0) / 1000.0;
        let right_weight =
            right.savings_ms.unwrap_or(0.0) + right.savings_bytes.unwrap_or(0.0) / 1000.0;
        right_weight
            .partial_cmp(&left_weight)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                left.score
                    .unwrap_or(1.0)
                    .partial_cmp(&right.score.unwrap_or(1.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    passed.sort_by(|left, right| left.title.cmp(&right.title));

    Ok(LighthouseReport {
        requested_url: report
            .get("requestedUrl")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        final_url: report
            .get("finalDisplayedUrl")
            .or_else(|| report.get("finalUrl"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        fetch_time: report
            .get("fetchTime")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        lighthouse_version: report
            .get("lighthouseVersion")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        strategy: report
            .get("configSettings")
            .and_then(|settings| settings.get("formFactor"))
            .and_then(Value::as_str)
            .unwrap_or(strategy)
            .to_string(),
        form_factor: report
            .get("configSettings")
            .and_then(|settings| settings.get("formFactor"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        duration_ms,
        categories,
        metrics,
        audits,
        passed,
        warnings: report
            .get("runWarnings")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn lighthouse_cli_path() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("LIGHTHOUSE_CLI_PATH") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(directory) = std::env::current_dir() {
        roots.push(directory);
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));
    for root in roots {
        let mut directory: Option<&Path> = Some(root.as_path());
        for _ in 0..6 {
            let Some(current) = directory else { break };
            for entry in ["cli", "lighthouse-cli"] {
                let candidate = current
                    .join("node_modules")
                    .join("lighthouse")
                    .join(entry)
                    .join("index.js");
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
            directory = current.parent();
        }
    }
    None
}

fn chrome_path() -> Option<String> {
    if let Ok(value) = std::env::var("CHROME_PATH") {
        if PathBuf::from(&value).is_file() {
            return Some(value);
        }
    }
    #[cfg(windows)]
    {
        let mut chrome_candidates: Vec<PathBuf> = Vec::new();
        let mut edge_candidates: Vec<PathBuf> = Vec::new();
        for variable in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Ok(root) = std::env::var(variable) {
                chrome_candidates.push(
                    PathBuf::from(&root)
                        .join("Google")
                        .join("Chrome")
                        .join("Application")
                        .join("chrome.exe"),
                );
                edge_candidates.push(
                    PathBuf::from(&root)
                        .join("Microsoft")
                        .join("Edge")
                        .join("Application")
                        .join("msedge.exe"),
                );
            }
        }
        for candidate in chrome_candidates
            .into_iter()
            .chain(edge_candidates.into_iter())
        {
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

async fn command_available(program: &str, argument: &str) -> bool {
    let mut command = tokio::process::Command::new(program);
    command
        .arg(argument)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    matches!(
        tokio::time::timeout(Duration::from_secs(5), command.status()).await,
        Ok(Ok(status)) if status.success()
    )
}

#[tauri::command]
async fn check_lighthouse_environment() -> LighthouseEnvironment {
    let node_installed = command_available("node", "--version").await;
    let browser_installed = chrome_path().is_some();
    let bundled_cli = lighthouse_cli_path().is_some();
    let npx_available = if bundled_cli || !node_installed {
        false
    } else if cfg!(windows) {
        command_available("npx.cmd", "--version").await
    } else {
        command_available("npx", "--version").await
    };
    let local_cli_available = bundled_cli || npx_available;
    LighthouseEnvironment {
        node_installed,
        browser_installed,
        local_cli_available,
        local_available: node_installed && browser_installed && local_cli_available,
    }
}

fn lighthouse_command(
    url: &str,
    strategy: &str,
    output_path: &Path,
    debugging_port: u16,
) -> tokio::process::Command {
    let chrome_flags = "--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage";
    let mut command = match lighthouse_cli_path() {
        Some(cli) => {
            let mut command = tokio::process::Command::new("node");
            command.arg(cli);
            command
        }
        None => {
            if cfg!(windows) {
                let mut command = tokio::process::Command::new("cmd");
                command.args([
                    "/C",
                    "npx.cmd",
                    "--yes",
                    "--package",
                    "lighthouse@13",
                    "lighthouse",
                ]);
                command
            } else {
                let mut command = tokio::process::Command::new("npx");
                command.args(["--yes", "--package", "lighthouse@13", "lighthouse"]);
                command
            }
        }
    };
    command
        .arg(url)
        .arg("--output=json")
        .arg(format!("--output-path={}", output_path.display()))
        .arg(format!("--chrome-flags={chrome_flags}"))
        .arg(format!("--port={debugging_port}"))
        .arg("--only-categories=performance,accessibility,best-practices,seo")
        .arg("--max-wait-for-load=45000")
        .arg("--quiet")
        .stdin(std::process::Stdio::null());
    if strategy == "desktop" {
        command.arg("--preset=desktop");
    }
    if let Some(path) = chrome_path() {
        command.env("CHROME_PATH", path);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
}

fn lighthouse_error_message(stderr: &str) -> &str {
    stderr
        .lines()
        .map(str::trim)
        .find(|line| {
            !line.is_empty()
                && !line.starts_with("at ")
                && !line.starts_with("file:")
                && !line.starts_with('(')
        })
        .or_else(|| stderr.lines().map(str::trim).find(|line| !line.is_empty()))
        .unwrap_or("Lighthouse could not audit this page")
}

async fn run_lighthouse_cli(url: &str, strategy: &str) -> Result<Value, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let output_path = std::env::temp_dir().join(format!("gsc-studio-lighthouse-{stamp}.json"));

    let mut attempt = 0;
    loop {
        let _ = tokio::fs::remove_file(&output_path).await;
        let debugging_port = std::net::TcpListener::bind(("127.0.0.1", 0))
            .and_then(|listener| listener.local_addr())
            .map(|address| address.port())
            .map_err(|error| format!("Could not reserve a Chrome debugging port: {error}"))?;
        let mut command = lighthouse_command(url, strategy, &output_path, debugging_port);
        let output = match tokio::time::timeout(Duration::from_secs(240), command.output()).await {
            Err(_) => {
                let _ = tokio::fs::remove_file(&output_path).await;
                return Err("The Lighthouse audit timed out after 4 minutes".to_string());
            }
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err("Lighthouse needs Node.js and Chrome. Install Node.js or set LIGHTHOUSE_CLI_PATH to the Lighthouse CLI file.".to_string());
            }
            Ok(Err(error)) => {
                return Err(format!("Lighthouse could not start: {error}"));
            }
            Ok(Ok(output)) => output,
        };
        if output.status.success() {
            break;
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let launcher_failed = stderr.contains("ChromeLauncher")
            || stderr.contains("at poll")
            || stderr.contains("waiting for dynamic debugging port")
            || stderr.contains("Unable to connect to Chrome")
            || stderr.contains("browser process has unexpectedly exited");
        if attempt == 0 && launcher_failed {
            attempt += 1;
            tokio::time::sleep(Duration::from_millis(800)).await;
            continue;
        }
        let _ = tokio::fs::remove_file(&output_path).await;
        return Err(format!(
            "Lighthouse failed: {}",
            shorten(lighthouse_error_message(&stderr), 300)
        ));
    }

    let bytes = tokio::fs::read(&output_path)
        .await
        .map_err(|error| format!("Lighthouse did not produce a report for this page: {error}"))?;
    let _ = tokio::fs::remove_file(&output_path).await;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not decode the Lighthouse report: {error}"))
}

#[tauri::command]
async fn run_lighthouse(
    url: String,
    strategy: String,
    force: bool,
) -> Result<LighthouseReport, String> {
    let url = url.trim().to_string();
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| "Enter a valid URL, for example https://example.com".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https pages can be audited".to_string());
    }
    let strategy = if strategy == "desktop" {
        "desktop"
    } else {
        "mobile"
    };
    let cache_key = format!("LIGHTHOUSE:{strategy}:{url}");
    if !force {
        if let Some(value) = read_cache(&cache_key).await {
            if let Ok(report) = serde_json::from_value::<LighthouseReport>(value) {
                return Ok(report);
            }
        }
    }
    let started = Instant::now();
    let raw = run_lighthouse_cli(&url, strategy).await?;
    let report = parse_lighthouse_report(&raw, strategy, started.elapsed().as_millis() as u64)?;
    if let Ok(value) = serde_json::to_value(&report) {
        write_cache(cache_key, value).await;
    }
    Ok(report)
}

#[tauri::command]
async fn run_pagespeed(
    url: String,
    strategy: String,
    force: bool,
) -> Result<LighthouseReport, String> {
    let url = url.trim().to_string();
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| "Enter a valid URL, for example https://example.com".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https pages can be audited".to_string());
    }
    let strategy = if strategy == "desktop" {
        "desktop"
    } else {
        "mobile"
    };
    let cache_key = format!("PAGESPEED:{strategy}:{url}");
    if !force {
        if let Some(value) = read_cache(&cache_key).await {
            if let Ok(report) = serde_json::from_value::<LighthouseReport>(value) {
                return Ok(report);
            }
        }
    }

    let key = active_service_account_key().await?;
    let quota_project = key
        .project_id
        .clone()
        .ok_or_else(|| "The service-account JSON does not contain a project ID".to_string())?;
    let token = access_token_for_key_with_scopes(key, &[PAGESPEED_SCOPE]).await?;
    let started = Instant::now();
    let response = reqwest::Client::new()
        .get(PAGESPEED_API)
        .bearer_auth(token)
        .header("x-goog-user-project", quota_project)
        .query(&[
            ("url", url.as_str()),
            ("strategy", strategy),
            ("category", "performance"),
            ("category", "accessibility"),
            ("category", "best-practices"),
            ("category", "seo"),
        ])
        .send()
        .await
        .map_err(|error| format!("Could not reach PageSpeed Insights: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read PageSpeed Insights response: {error}"))?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| value.pointer("/error/message")?.as_str().map(str::to_owned))
            .unwrap_or(body);
        return Err(format!("PageSpeed Insights returned {status}: {detail}"));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid response from PageSpeed Insights: {error}"))?;
    let raw = value
        .get("lighthouseResult")
        .ok_or_else(|| "PageSpeed Insights did not return a Lighthouse report".to_string())?;
    let report = parse_lighthouse_report(raw, strategy, started.elapsed().as_millis() as u64)?;
    if let Ok(value) = serde_json::to_value(&report) {
        write_cache(cache_key, value).await;
    }
    Ok(report)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let directory = app.path().app_data_dir()?.join("credentials");
            let _ = CREDENTIALS_DIR.set(directory);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sites,
            has_credentials,
            list_credential_profiles,
            import_service_account,
            activate_credential,
            get_performance,
            get_recommendations,
            list_sitemaps,
            check_lighthouse_environment,
            run_lighthouse,
            run_pagespeed
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(windows)]
    fn dpapi_round_trip_is_user_scoped() {
        let plaintext = b"credential-encryption-test";
        let encrypted = super::protect_secret(plaintext).expect("DPAPI encryption failed");
        assert_ne!(encrypted, plaintext);
        let decrypted = super::unprotect_secret(&encrypted).expect("DPAPI decryption failed");
        assert_eq!(decrypted.as_slice(), plaintext);
    }

    #[tokio::test]
    #[ignore = "requires live Google credentials and network access"]
    async fn service_account_can_list_search_console_sites() {
        let sites = super::list_sites()
            .await
            .expect("service account could not query Search Console");
        assert!(
            !sites.is_empty(),
            "credentials are valid, but the service account has no Search Console properties"
        );
        let site_url = &sites[0].site_url;
        super::analytics_query(
            site_url,
            "2026-10-01",
            "2026-10-31",
            vec!["date"],
            10,
            "web",
            None,
        )
        .await
        .expect("service account could not query Search Analytics");
        super::list_sitemaps(site_url.to_string())
            .await
            .expect("service account could not list sitemaps");
        super::get_recommendations(
            site_url.to_string(),
            "2026-10-19".to_string(),
            "2026-11-15".to_string(),
            "2026-09-21".to_string(),
            "2026-10-18".to_string(),
        )
        .await
        .expect("service account could not calculate recommendations");
    }
}
