use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tokio::sync::RwLock;
use yup_oauth2::{ServiceAccountAuthenticator, ServiceAccountKey, read_service_account_key};
use zeroize::Zeroizing;

const SCOPE: &str = "https://www.googleapis.com/auth/webmasters.readonly";
const WRITE_SCOPE: &str = "https://www.googleapis.com/auth/webmasters";
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

fn validate_sitemap_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    let parsed = reqwest::Url::parse(value)
        .map_err(|_| "Enter a valid sitemap URL, for example https://example.com/sitemap.xml")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("The sitemap URL must use http or https".to_string());
    }
    Ok(value.to_string())
}

fn sitemap_api_path(site_url: &str, sitemap_url: &str) -> String {
    format!(
        "/sites/{}/sitemaps/{}",
        urlencoding::encode(site_url),
        urlencoding::encode(sitemap_url)
    )
}

#[tauri::command]
async fn get_sitemap(site_url: String, sitemap_url: String) -> Result<Sitemap, String> {
    let sitemap_url = validate_sitemap_url(&sitemap_url)?;
    let value = google_get(&sitemap_api_path(&site_url, &sitemap_url)).await?;
    serde_json::from_value(value)
        .map_err(|error| format!("Could not decode sitemap details: {error}"))
}

async fn mutate_sitemap(
    method: reqwest::Method,
    site_url: &str,
    sitemap_url: &str,
    action: &str,
) -> Result<(), String> {
    let key = active_service_account_key().await?;
    let token = access_token_for_key_with_scopes(key, &[WRITE_SCOPE]).await?;
    let response = reqwest::Client::new()
        .request(
            method,
            format!("{API_ROOT}{}", sitemap_api_path(site_url, sitemap_url)),
        )
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("Could not reach Search Console: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .map_err(|error| format!("Could not read Google's response: {error}"))?;
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| value.pointer("/error/message")?.as_str().map(str::to_owned))
            .unwrap_or(body);
        return Err(format!(
            "Search Console could not {action} ({status}): {detail}"
        ));
    }
    response_cache().write().await.clear();
    Ok(())
}

#[tauri::command]
async fn submit_sitemap(site_url: String, sitemap_url: String) -> Result<(), String> {
    let sitemap_url = validate_sitemap_url(&sitemap_url)?;
    mutate_sitemap(
        reqwest::Method::PUT,
        &site_url,
        &sitemap_url,
        "submit the sitemap",
    )
    .await
}

#[tauri::command]
async fn delete_sitemap(site_url: String, sitemap_url: String) -> Result<(), String> {
    let sitemap_url = validate_sitemap_url(&sitemap_url)?;
    mutate_sitemap(
        reqwest::Method::DELETE,
        &site_url,
        &sitemap_url,
        "delete the sitemap",
    )
    .await
}

async fn inspect_url_with_token(
    site_url: &str,
    inspection_url: &str,
    token: &str,
) -> Result<Value, String> {
    let inspection_url = inspection_url.trim().to_string();
    let parsed = reqwest::Url::parse(&inspection_url)
        .map_err(|_| "Enter a valid URL, for example https://example.com/page".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https URLs can be inspected".to_string());
    }
    let cache_key = format!("URL_INSPECTION:{site_url}:{inspection_url}");
    if let Some(value) = read_cache(&cache_key).await {
        return Ok(value);
    }
    let response = reqwest::Client::new()
        .post("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect")
        .bearer_auth(token)
        .json(&json!({
            "inspectionUrl": inspection_url,
            "siteUrl": site_url,
            "languageCode": "en-US"
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach URL Inspection: {error}"))?;
    let value = parse_response(response).await?;
    let result = value
        .get("inspectionResult")
        .cloned()
        .ok_or_else(|| "Google did not return an inspection result for this URL".to_string())?;
    write_cache(cache_key, result.clone()).await;
    Ok(result)
}

async fn inspect_url_cached(site_url: &str, inspection_url: &str) -> Result<Value, String> {
    let cache_key = format!("URL_INSPECTION:{site_url}:{}", inspection_url.trim());
    if let Some(value) = read_cache(&cache_key).await {
        return Ok(value);
    }
    let token = access_token().await?;
    inspect_url_with_token(site_url, inspection_url, &token).await
}

#[tauri::command]
async fn inspect_url(site_url: String, inspection_url: String) -> Result<Value, String> {
    inspect_url_cached(&site_url, &inspection_url).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditCheck {
    id: String,
    title: String,
    status: String,
    count: usize,
    description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeoOverview {
    current: MetricRow,
    previous: MetricRow,
    clicks_change: f64,
    impressions_change: f64,
    ctr_change: f64,
    position_change: f64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SitemapAudit {
    total: usize,
    errors: usize,
    warnings: usize,
    pending: usize,
    stale: usize,
    zero_indexed: usize,
    submitted_urls: f64,
    indexed_urls: f64,
    issues: Vec<SitemapAuditIssue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SitemapAuditIssue {
    path: String,
    issue: String,
    severity: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CtrOpportunity {
    key: String,
    kind: String,
    clicks: f64,
    impressions: f64,
    ctr: f64,
    position: f64,
    benchmark_ctr: f64,
    missed_clicks: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StrikingDistance {
    query: String,
    clicks: f64,
    impressions: f64,
    ctr: f64,
    position: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DecliningItem {
    key: String,
    kind: String,
    clicks: f64,
    previous_clicks: f64,
    impressions: f64,
    previous_impressions: f64,
    clicks_change: f64,
    impressions_change: f64,
    position: f64,
    previous_position: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CannibalPage {
    page: String,
    clicks: f64,
    impressions: f64,
    position: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CannibalizationItem {
    query: String,
    impressions: f64,
    pages: Vec<CannibalPage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceGapItem {
    page: String,
    mobile_position: f64,
    desktop_position: f64,
    gap: f64,
    mobile_impressions: f64,
    desktop_impressions: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchAppearanceRow {
    appearance: String,
    clicks: f64,
    impressions: f64,
    ctr: f64,
    position: f64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct IndexingAudit {
    sampled: usize,
    inspected: usize,
    indexed: usize,
    not_indexed: usize,
    failed: usize,
    stale: usize,
    canonical_mismatches: usize,
    robots_blocked: usize,
    fetch_failed: usize,
    mobile_issue_pages: usize,
    rich_issue_pages: usize,
    items: Vec<IndexingItem>,
    errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexingItem {
    url: String,
    verdict: String,
    coverage_state: String,
    indexing_state: String,
    last_crawl_time: Option<String>,
    page_fetch_state: String,
    robots_txt_state: String,
    crawled_as: Option<String>,
    user_canonical: Option<String>,
    google_canonical: Option<String>,
    canonical_mismatch: bool,
    sitemap_count: usize,
    mobile_issues: usize,
    rich_issues: usize,
    impressions: f64,
    clicks: f64,
    issue: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeoAuditReport {
    generated_at: u64,
    data_start: String,
    data_end: String,
    previous_start: String,
    previous_end: String,
    search_type: String,
    min_impressions: f64,
    inspect_limit: usize,
    overview: SeoOverview,
    checks: Vec<AuditCheck>,
    sitemaps: SitemapAudit,
    ctr_opportunities: Vec<CtrOpportunity>,
    striking_distance: Vec<StrikingDistance>,
    declining: Vec<DecliningItem>,
    cannibalization: Vec<CannibalizationItem>,
    device_gap: Vec<DeviceGapItem>,
    search_appearance: Vec<SearchAppearanceRow>,
    indexing: IndexingAudit,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn parse_rfc3339_millis(value: &str) -> Option<u64> {
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: i64 = value.get(5..7)?.parse().ok()?;
    let day: i64 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: i64 = value.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
    u64::try_from(seconds * 1_000).ok()
}

fn percent_change(current: f64, previous: f64) -> f64 {
    if previous > 0.0 {
        (current - previous) / previous * 100.0
    } else if current > 0.0 {
        100.0
    } else {
        0.0
    }
}

fn position_bucket(position: f64) -> usize {
    if position <= 3.0 {
        0
    } else if position <= 10.0 {
        1
    } else if position <= 20.0 {
        2
    } else {
        3
    }
}

fn ctr_by_bucket(rows: &[MetricRow]) -> [f64; 4] {
    let mut clicks = [0.0_f64; 4];
    let mut impressions = [0.0_f64; 4];
    for row in rows {
        let bucket = position_bucket(row.position);
        clicks[bucket] += row.clicks;
        impressions[bucket] += row.impressions;
    }
    let mut values = [0.0_f64; 4];
    for (index, value) in values.iter_mut().enumerate() {
        if impressions[index] > 0.0 {
            *value = clicks[index] / impressions[index];
        }
    }
    values
}

fn collect_ctr_opportunities(
    rows: &[MetricRow],
    kind: &str,
    min_impressions: f64,
) -> Vec<CtrOpportunity> {
    let benchmarks = ctr_by_bucket(rows);
    rows.iter()
        .filter_map(|row| {
            let key = row.keys.first()?.clone();
            let benchmark = benchmarks[position_bucket(row.position)];
            if row.impressions < min_impressions
                || row.position <= 0.0
                || row.position > 10.0
                || benchmark <= 0.0
                || row.ctr >= benchmark * 0.7
            {
                return None;
            }
            let missed = (benchmark - row.ctr) * row.impressions;
            (missed >= 10.0).then(|| CtrOpportunity {
                key,
                kind: kind.to_string(),
                clicks: row.clicks,
                impressions: row.impressions,
                ctr: row.ctr,
                position: row.position,
                benchmark_ctr: benchmark,
                missed_clicks: missed,
            })
        })
        .collect()
}

fn collect_striking_distance(rows: &[MetricRow], min_impressions: f64) -> Vec<StrikingDistance> {
    let mut items: Vec<StrikingDistance> = rows
        .iter()
        .filter_map(|row| {
            let query = row.keys.first()?.clone();
            (row.position >= 5.0 && row.position <= 20.0 && row.impressions >= min_impressions)
                .then(|| StrikingDistance {
                    query,
                    clicks: row.clicks,
                    impressions: row.impressions,
                    ctr: row.ctr,
                    position: row.position,
                })
        })
        .collect();
    items.sort_by(|left, right| {
        right
            .impressions
            .partial_cmp(&left.impressions)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    items.truncate(30);
    items
}

fn collect_declining_items(
    current: &[MetricRow],
    previous: &[MetricRow],
    kind: &str,
    min_impressions: f64,
) -> Vec<DecliningItem> {
    let current_by_key: HashMap<&str, &MetricRow> = current
        .iter()
        .filter_map(|row| Some((row.keys.first()?.as_str(), row)))
        .collect();
    let mut scored: Vec<(f64, DecliningItem)> = previous
        .iter()
        .filter_map(|row| {
            let key = row.keys.first()?.clone();
            if row.clicks < 5.0 && row.impressions < min_impressions {
                return None;
            }
            let now = current_by_key.get(key.as_str()).copied();
            let clicks = now.map(|item| item.clicks).unwrap_or_default();
            let impressions = now.map(|item| item.impressions).unwrap_or_default();
            let position = now.map(|item| item.position).unwrap_or_default();
            let clicks_change = percent_change(clicks, row.clicks);
            let impressions_change = percent_change(impressions, row.impressions);
            if clicks_change > -20.0 && impressions_change > -20.0 {
                return None;
            }
            let lost =
                (row.clicks - clicks).max(0.0) * 20.0 + (row.impressions - impressions).max(0.0);
            Some((
                lost,
                DecliningItem {
                    key,
                    kind: kind.to_string(),
                    clicks,
                    previous_clicks: row.clicks,
                    impressions,
                    previous_impressions: row.impressions,
                    clicks_change,
                    impressions_change,
                    position,
                    previous_position: row.position,
                },
            ))
        })
        .collect();
    scored.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.into_iter().take(30).map(|(_, item)| item).collect()
}

fn collect_cannibalization(rows: &[MetricRow], min_impressions: f64) -> Vec<CannibalizationItem> {
    let mut grouped: HashMap<String, Vec<CannibalPage>> = HashMap::new();
    for row in rows {
        if row.impressions < 5.0 {
            continue;
        }
        let (Some(query), Some(page)) = (row.keys.first(), row.keys.get(1)) else {
            continue;
        };
        grouped
            .entry(query.clone())
            .or_default()
            .push(CannibalPage {
                page: page.clone(),
                clicks: row.clicks,
                impressions: row.impressions,
                position: row.position,
            });
    }
    let mut items: Vec<CannibalizationItem> = grouped
        .into_iter()
        .filter_map(|(query, mut pages)| {
            let total: f64 = pages.iter().map(|page| page.impressions).sum();
            if pages.len() < 2 || total < min_impressions {
                return None;
            }
            pages.sort_by(|left, right| {
                left.position
                    .partial_cmp(&right.position)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            pages.truncate(5);
            Some(CannibalizationItem {
                query,
                impressions: total,
                pages,
            })
        })
        .collect();
    items.sort_by(|left, right| {
        right
            .impressions
            .partial_cmp(&left.impressions)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    items.truncate(20);
    items
}

fn collect_device_gaps(
    mobile: &[MetricRow],
    desktop: &[MetricRow],
    min_impressions: f64,
) -> Vec<DeviceGapItem> {
    let desktop_by_page: HashMap<&str, &MetricRow> = desktop
        .iter()
        .filter_map(|row| Some((row.keys.first()?.as_str(), row)))
        .collect();
    let mut items: Vec<DeviceGapItem> = mobile
        .iter()
        .filter_map(|row| {
            let page = row.keys.first()?.clone();
            let desktop_row = desktop_by_page.get(page.as_str())?;
            if row.impressions < min_impressions / 2.0
                || row.position <= 0.0
                || desktop_row.position <= 0.0
            {
                return None;
            }
            let gap = row.position - desktop_row.position;
            (gap >= 5.0).then(|| DeviceGapItem {
                page,
                mobile_position: row.position,
                desktop_position: desktop_row.position,
                gap,
                mobile_impressions: row.impressions,
                desktop_impressions: desktop_row.impressions,
            })
        })
        .collect();
    items.sort_by(|left, right| {
        right
            .gap
            .partial_cmp(&left.gap)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    items.truncate(20);
    items
}

fn sitemap_number(value: &Option<String>) -> f64 {
    value
        .as_deref()
        .and_then(|item| item.parse::<f64>().ok())
        .unwrap_or_default()
}

fn seo_severity_rank(severity: &str) -> u8 {
    match severity {
        "error" => 0,
        "warning" => 1,
        _ => 2,
    }
}

fn build_sitemap_audit(sitemaps: &[Sitemap], now: u64) -> SitemapAudit {
    let mut audit = SitemapAudit {
        total: sitemaps.len(),
        ..Default::default()
    };
    for item in sitemaps {
        let errors = sitemap_number(&item.errors);
        let warnings = sitemap_number(&item.warnings);
        let submitted: f64 = item
            .contents
            .iter()
            .map(|content| sitemap_number(&content.submitted))
            .sum();
        let indexed: f64 = item
            .contents
            .iter()
            .map(|content| sitemap_number(&content.indexed))
            .sum();
        audit.submitted_urls += submitted;
        audit.indexed_urls += indexed;
        if errors > 0.0 {
            audit.errors += 1;
        }
        if warnings > 0.0 {
            audit.warnings += 1;
        }
        let pending = item.is_pending.unwrap_or(false);
        if pending {
            audit.pending += 1;
        }
        let stale = item
            .last_downloaded
            .as_deref()
            .and_then(parse_rfc3339_millis)
            .map(|time| now.saturating_sub(time) > 7 * 86_400_000)
            .unwrap_or(false);
        if stale {
            audit.stale += 1;
        }
        if submitted > 0.0 && indexed == 0.0 {
            audit.zero_indexed += 1;
        }
        let mut problems = Vec::new();
        let mut severity = "info";
        if errors > 0.0 {
            problems.push(format!("{} error(s)", errors as u64));
            severity = "error";
        }
        if warnings > 0.0 {
            problems.push(format!("{} warning(s)", warnings as u64));
            if severity != "error" {
                severity = "warning";
            }
        }
        if pending {
            problems.push("Pending processing".to_string());
            if severity != "error" {
                severity = "warning";
            }
        }
        if stale {
            problems.push("Not downloaded in the last 7 days".to_string());
            if severity != "error" {
                severity = "warning";
            }
        }
        if submitted > 0.0 && indexed == 0.0 {
            problems.push("No indexed URLs reported".to_string());
            if severity != "error" {
                severity = "warning";
            }
        } else if submitted > 0.0 && indexed / submitted < 0.5 {
            problems.push(format!(
                "Only {} of {} submitted URLs indexed",
                indexed as u64, submitted as u64
            ));
            if severity != "error" {
                severity = "warning";
            }
        }
        if !problems.is_empty() {
            audit.issues.push(SitemapAuditIssue {
                path: item.path.clone(),
                issue: problems.join("; "),
                severity: severity.to_string(),
            });
        }
    }
    audit.issues.sort_by(|left, right| {
        seo_severity_rank(&left.severity).cmp(&seo_severity_rank(&right.severity))
    });
    audit
}

fn value_string(value: &Value, path: &str) -> Option<String> {
    value.pointer(path)?.as_str().map(ToOwned::to_owned)
}

fn array_len_at(value: &Value, path: &str) -> usize {
    value
        .pointer(path)
        .and_then(Value::as_array)
        .map_or(0, Vec::len)
}

fn rich_issue_count(value: &Value) -> usize {
    value
        .pointer("/richResultsResult/detectedItems")
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .map(|group| {
                    group
                        .pointer("/items")
                        .and_then(Value::as_array)
                        .map(|items| items.iter().map(|item| array_len_at(item, "/issues")).sum())
                        .unwrap_or(0)
                })
                .sum()
        })
        .unwrap_or(0)
}

fn property_sample_url(site_url: &str) -> String {
    site_url
        .strip_prefix("sc-domain:")
        .map(|domain| format!("https://{domain}/"))
        .unwrap_or_else(|| site_url.to_string())
}

#[tauri::command]
async fn run_seo_audit(
    site_url: String,
    start_date: String,
    end_date: String,
    previous_start: String,
    previous_end: String,
    search_type: String,
    min_impressions: Option<f64>,
    inspect_limit: Option<u32>,
) -> Result<SeoAuditReport, String> {
    let search_type = match search_type.as_str() {
        "image" | "video" | "news" => search_type,
        _ => "web".to_string(),
    };
    let min_impressions = min_impressions.unwrap_or(100.0).clamp(1.0, 100_000.0);
    let inspect_limit = inspect_limit.unwrap_or(25).clamp(1, 50) as usize;

    let (
        summary_current,
        summary_previous,
        pages_current,
        pages_previous,
        queries_current,
        queries_previous,
        query_pages,
        mobile_pages,
        desktop_pages,
        search_appearances,
        sitemaps,
    ) = tokio::join!(
        analytics_query(
            &site_url,
            &start_date,
            &end_date,
            vec![],
            1,
            &search_type,
            None
        ),
        analytics_query(
            &site_url,
            &previous_start,
            &previous_end,
            vec![],
            1,
            &search_type,
            None
        ),
        analytics_query(
            &site_url,
            &start_date,
            &end_date,
            vec!["page"],
            25_000,
            &search_type,
            None
        ),
        analytics_query(
            &site_url,
            &previous_start,
            &previous_end,
            vec!["page"],
            25_000,
            &search_type,
            None
        ),
        analytics_query(
            &site_url,
            &start_date,
            &end_date,
            vec!["query"],
            25_000,
            &search_type,
            None
        ),
        analytics_query(
            &site_url,
            &previous_start,
            &previous_end,
            vec!["query"],
            25_000,
            &search_type,
            None
        ),
        analytics_query(
            &site_url,
            &start_date,
            &end_date,
            vec!["query", "page"],
            25_000,
            &search_type,
            None
        ),
        analytics_query(
            &site_url,
            &start_date,
            &end_date,
            vec!["page"],
            25_000,
            &search_type,
            Some(("device", "equals", "MOBILE"))
        ),
        analytics_query(
            &site_url,
            &start_date,
            &end_date,
            vec!["page"],
            25_000,
            &search_type,
            Some(("device", "equals", "DESKTOP"))
        ),
        analytics_query(
            &site_url,
            &start_date,
            &end_date,
            vec!["searchAppearance"],
            25_000,
            &search_type,
            None
        ),
        list_sitemaps(site_url.clone()),
    );

    let overview_current = summary_current?.into_iter().next().unwrap_or_default();
    let overview_previous = summary_previous?.into_iter().next().unwrap_or_default();
    let pages_current = pages_current?;
    let pages_previous = pages_previous?;
    let queries_current = queries_current?;
    let queries_previous = queries_previous?;
    let query_pages = query_pages?;
    let mobile_pages = mobile_pages?;
    let desktop_pages = desktop_pages?;
    let mut search_appearance: Vec<SearchAppearanceRow> = search_appearances?
        .into_iter()
        .filter_map(|row| {
            Some(SearchAppearanceRow {
                appearance: row.keys.first()?.clone(),
                clicks: row.clicks,
                impressions: row.impressions,
                ctr: row.ctr,
                position: row.position,
            })
        })
        .collect();
    search_appearance.sort_by(|left, right| {
        right
            .impressions
            .partial_cmp(&left.impressions)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    search_appearance.truncate(20);
    let now = now_millis();
    let sitemap_audit = build_sitemap_audit(&sitemaps?, now);

    let mut ctr_opportunities =
        collect_ctr_opportunities(&queries_current, "query", min_impressions);
    ctr_opportunities.extend(collect_ctr_opportunities(
        &pages_current,
        "page",
        min_impressions,
    ));
    ctr_opportunities.sort_by(|left, right| {
        right
            .missed_clicks
            .partial_cmp(&left.missed_clicks)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    ctr_opportunities.truncate(30);

    let striking_distance = collect_striking_distance(&queries_current, min_impressions);

    let mut declining =
        collect_declining_items(&pages_current, &pages_previous, "page", min_impressions);
    declining.extend(collect_declining_items(
        &queries_current,
        &queries_previous,
        "query",
        min_impressions,
    ));
    declining.sort_by(|left, right| {
        let left_lost = (left.previous_clicks - left.clicks).max(0.0) * 20.0
            + (left.previous_impressions - left.impressions).max(0.0);
        let right_lost = (right.previous_clicks - right.clicks).max(0.0) * 20.0
            + (right.previous_impressions - right.impressions).max(0.0);
        right_lost
            .partial_cmp(&left_lost)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    declining.truncate(30);

    let cannibalization = collect_cannibalization(&query_pages, min_impressions);
    let device_gap = collect_device_gaps(&mobile_pages, &desktop_pages, min_impressions);

    let page_metrics: HashMap<String, MetricRow> = pages_current
        .iter()
        .filter_map(|row| Some((row.keys.first()?.clone(), row.clone())))
        .collect();
    let mut sample = vec![property_sample_url(&site_url)];
    for row in &pages_current {
        if sample.len() >= inspect_limit {
            break;
        }
        if let Some(url) = row.keys.first() {
            if (url.starts_with("http://") || url.starts_with("https://"))
                && !sample.iter().any(|existing| existing == url)
            {
                sample.push(url.clone());
            }
        }
    }

    let mut indexing = IndexingAudit {
        sampled: sample.len(),
        ..Default::default()
    };
    let inspection_token = access_token().await?;
    let mut consecutive_failures = 0;
    for url in &sample {
        match inspect_url_with_token(&site_url, url, &inspection_token).await {
            Ok(value) => {
                consecutive_failures = 0;
                let verdict = value_string(&value, "/indexStatusResult/verdict")
                    .unwrap_or_else(|| "VERDICT_UNSPECIFIED".to_string());
                let coverage_state = value_string(&value, "/indexStatusResult/coverageState")
                    .unwrap_or_else(|| "Not provided".to_string());
                let indexing_state = value_string(&value, "/indexStatusResult/indexingState")
                    .unwrap_or_else(|| "INDEXING_STATE_UNSPECIFIED".to_string());
                let page_fetch_state = value_string(&value, "/indexStatusResult/pageFetchState")
                    .unwrap_or_else(|| "PAGE_FETCH_STATE_UNSPECIFIED".to_string());
                let robots_txt_state = value_string(&value, "/indexStatusResult/robotsTxtState")
                    .unwrap_or_else(|| "ROBOTS_TXT_STATE_UNSPECIFIED".to_string());
                let last_crawl_time = value_string(&value, "/indexStatusResult/lastCrawlTime");
                let crawled_as = value_string(&value, "/indexStatusResult/crawledAs");
                let user_canonical = value_string(&value, "/indexStatusResult/userCanonical");
                let google_canonical = value_string(&value, "/indexStatusResult/googleCanonical");
                let sitemap_count = array_len_at(&value, "/indexStatusResult/sitemap");
                let canonical_mismatch = match (&user_canonical, &google_canonical) {
                    (Some(user), Some(google)) => {
                        !user.is_empty() && !google.is_empty() && user != google
                    }
                    _ => false,
                };
                let indexed = verdict == "PASS";
                let robots_blocked = robots_txt_state.contains("DISALLOWED");
                let fetch_failed = page_fetch_state != "PAGE_FETCH_STATE_SUCCESSFUL"
                    && page_fetch_state != "PAGE_FETCH_STATE_UNSPECIFIED";
                let stale = last_crawl_time
                    .as_deref()
                    .and_then(parse_rfc3339_millis)
                    .map(|time| now.saturating_sub(time) > 90 * 86_400_000)
                    .unwrap_or(false);
                let mobile_issues = array_len_at(&value, "/mobileUsabilityResult/issues");
                let mobile_failed = mobile_issues > 0
                    || value_string(&value, "/mobileUsabilityResult/verdict").as_deref()
                        == Some("FAIL");
                let rich_issues = rich_issue_count(&value);
                let rich_failed = rich_issues > 0
                    || value_string(&value, "/richResultsResult/verdict").as_deref()
                        == Some("FAIL");

                if indexed {
                    indexing.indexed += 1;
                } else {
                    indexing.not_indexed += 1;
                }
                indexing.inspected += 1;
                if canonical_mismatch {
                    indexing.canonical_mismatches += 1;
                }
                if robots_blocked {
                    indexing.robots_blocked += 1;
                }
                if fetch_failed {
                    indexing.fetch_failed += 1;
                }
                if stale {
                    indexing.stale += 1;
                }
                if mobile_failed {
                    indexing.mobile_issue_pages += 1;
                }
                if rich_failed {
                    indexing.rich_issue_pages += 1;
                }

                let mut issues = Vec::new();
                if !indexed {
                    issues.push(format!("Not indexed ({coverage_state})"));
                }
                if canonical_mismatch {
                    issues.push("Canonical mismatch".to_string());
                }
                if robots_blocked {
                    issues.push("Blocked by robots.txt".to_string());
                }
                if fetch_failed {
                    issues.push("Page fetch was not successful".to_string());
                }
                if stale {
                    issues.push("Last crawl was over 90 days ago".to_string());
                }
                if mobile_failed {
                    issues.push(if mobile_issues > 0 {
                        format!("{mobile_issues} mobile usability issue(s)")
                    } else {
                        "Mobile usability check failed".to_string()
                    });
                }
                if rich_failed {
                    issues.push(if rich_issues > 0 {
                        format!("{rich_issues} rich result issue(s)")
                    } else {
                        "Rich results check failed".to_string()
                    });
                }

                let metrics = page_metrics.get(url);
                indexing.items.push(IndexingItem {
                    url: url.clone(),
                    verdict,
                    coverage_state,
                    indexing_state,
                    last_crawl_time,
                    page_fetch_state,
                    robots_txt_state,
                    crawled_as,
                    user_canonical,
                    google_canonical,
                    canonical_mismatch,
                    sitemap_count,
                    mobile_issues,
                    rich_issues,
                    impressions: metrics.map(|row| row.impressions).unwrap_or_default(),
                    clicks: metrics.map(|row| row.clicks).unwrap_or_default(),
                    issue: issues.join("; "),
                });
            }
            Err(error) => {
                indexing.failed += 1;
                consecutive_failures += 1;
                if indexing.errors.len() < 3 {
                    indexing.errors.push(format!("{url}: {error}"));
                }
                if consecutive_failures >= 3 {
                    break;
                }
            }
        }
    }
    indexing.items.sort_by(|left, right| {
        left.issue
            .is_empty()
            .cmp(&right.issue.is_empty())
            .then_with(|| {
                right
                    .impressions
                    .partial_cmp(&left.impressions)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let clicks_change = percent_change(overview_current.clicks, overview_previous.clicks);
    let impressions_change =
        percent_change(overview_current.impressions, overview_previous.impressions);
    let ctr_change = (overview_current.ctr - overview_previous.ctr) * 100.0;
    let position_change = overview_current.position - overview_previous.position;

    let sitemap_issue_count =
        sitemap_audit.errors + sitemap_audit.warnings + sitemap_audit.pending + sitemap_audit.stale;
    let mut checks = Vec::new();
    checks.push(AuditCheck {
        id: "visibility".to_string(),
        title: "Search visibility".to_string(),
        status: if impressions_change <= -40.0 {
            "fail"
        } else if impressions_change <= -20.0 {
            "warn"
        } else {
            "pass"
        }
        .to_string(),
        count: 0,
        description: format!(
            "Impressions {} {:.1}% versus the previous period.",
            if impressions_change < 0.0 {
                "fell"
            } else {
                "changed"
            },
            impressions_change.abs()
        ),
    });
    checks.push(AuditCheck {
        id: "indexing".to_string(),
        title: "Indexing & crawl".to_string(),
        status: if indexing.not_indexed > 0
            || indexing.robots_blocked > 0
            || indexing.fetch_failed > 0
        {
            "fail"
        } else if indexing.failed > 0 {
            "warn"
        } else {
            "pass"
        }
        .to_string(),
        count: indexing.not_indexed + indexing.robots_blocked + indexing.fetch_failed,
        description: format!(
            "{} of {} inspected pages are indexed. {} inspection(s) failed.",
            indexing.indexed, indexing.inspected, indexing.failed
        ),
    });
    checks.push(AuditCheck {
        id: "canonical".to_string(),
        title: "Canonical URLs".to_string(),
        status: if indexing.canonical_mismatches > 0 {
            "warn"
        } else {
            "pass"
        }
        .to_string(),
        count: indexing.canonical_mismatches,
        description: if indexing.canonical_mismatches > 0 {
            "Google selected a different canonical than the page declares.".to_string()
        } else {
            "No canonical differences were found in the inspected sample.".to_string()
        },
    });
    checks.push(AuditCheck {
        id: "crawl-freshness".to_string(),
        title: "Crawl freshness".to_string(),
        status: if indexing.stale > 0 { "warn" } else { "pass" }.to_string(),
        count: indexing.stale,
        description: if indexing.stale > 0 {
            "Some sampled pages have not been crawled in the last 90 days.".to_string()
        } else {
            "The inspected sample was crawled recently.".to_string()
        },
    });
    checks.push(AuditCheck {
        id: "mobile".to_string(),
        title: "Mobile usability".to_string(),
        status: if indexing.mobile_issue_pages > 0 {
            "warn"
        } else {
            "pass"
        }
        .to_string(),
        count: indexing.mobile_issue_pages,
        description: if indexing.mobile_issue_pages > 0 {
            "Inspected pages have mobile usability issues.".to_string()
        } else {
            "No mobile usability issues were reported for the inspected sample.".to_string()
        },
    });
    checks.push(AuditCheck {
        id: "rich-results".to_string(),
        title: "Rich results".to_string(),
        status: if indexing.rich_issue_pages > 0 {
            "warn"
        } else {
            "pass"
        }
        .to_string(),
        count: indexing.rich_issue_pages,
        description: if indexing.rich_issue_pages > 0 {
            "Inspected pages have rich result warnings or errors.".to_string()
        } else {
            "No rich result issues were reported for the inspected sample.".to_string()
        },
    });
    checks.push(AuditCheck {
        id: "sitemaps".to_string(),
        title: "Sitemaps".to_string(),
        status: if sitemap_audit.errors > 0 {
            "fail"
        } else if sitemap_issue_count > 0 {
            "warn"
        } else {
            "pass"
        }
        .to_string(),
        count: sitemap_audit.issues.len(),
        description: if sitemap_issue_count > 0 {
            format!(
                "{} sitemap issue(s) across {} submitted sitemaps.",
                sitemap_audit.issues.len(),
                sitemap_audit.total
            )
        } else {
            format!("{} submitted sitemaps look healthy.", sitemap_audit.total)
        },
    });
    checks.push(AuditCheck {
        id: "ctr".to_string(),
        title: "CTR opportunities".to_string(),
        status: if ctr_opportunities.is_empty() {
            "pass"
        } else {
            "warn"
        }
        .to_string(),
        count: ctr_opportunities.len(),
        description: if ctr_opportunities.is_empty() {
            "No large CTR gaps were found for top-10 results.".to_string()
        } else {
            "Some pages or queries earn much less CTR than the site average for their position."
                .to_string()
        },
    });
    checks.push(AuditCheck {
        id: "striking-distance".to_string(),
        title: "Striking distance".to_string(),
        status: if striking_distance.is_empty() {
            "pass"
        } else {
            "info"
        }
        .to_string(),
        count: striking_distance.len(),
        description: if striking_distance.is_empty() {
            "No page 1-2 queries were found outside the top five.".to_string()
        } else {
            "Queries rank on page 1-2 but below the top five and could be improved.".to_string()
        },
    });
    checks.push(AuditCheck {
        id: "declining".to_string(),
        title: "Declining content".to_string(),
        status: if declining.is_empty() { "pass" } else { "warn" }.to_string(),
        count: declining.len(),
        description: if declining.is_empty() {
            "No pages or queries lost at least 20% of clicks or impressions.".to_string()
        } else {
            "Pages or queries lost at least 20% of clicks or impressions versus the previous period."
                .to_string()
        },
    });
    checks.push(AuditCheck {
        id: "cannibalization".to_string(),
        title: "Keyword cannibalization".to_string(),
        status: if cannibalization.is_empty() {
            "pass"
        } else {
            "warn"
        }
        .to_string(),
        count: cannibalization.len(),
        description: if cannibalization.is_empty() {
            "No queries with multiple competing pages were found.".to_string()
        } else {
            "Multiple pages compete for the same queries.".to_string()
        },
    });
    checks.push(AuditCheck {
        id: "device-gap".to_string(),
        title: "Mobile vs desktop rankings".to_string(),
        status: if device_gap.is_empty() {
            "pass"
        } else {
            "warn"
        }
        .to_string(),
        count: device_gap.len(),
        description: if device_gap.is_empty() {
            "Mobile and desktop positions are broadly aligned.".to_string()
        } else {
            "Some pages rank noticeably worse on mobile than on desktop.".to_string()
        },
    });

    Ok(SeoAuditReport {
        generated_at: now,
        data_start: start_date,
        data_end: end_date,
        previous_start,
        previous_end,
        search_type,
        min_impressions,
        inspect_limit,
        overview: SeoOverview {
            current: overview_current,
            previous: overview_previous,
            clicks_change,
            impressions_change,
            ctr_change,
            position_change,
        },
        checks,
        sitemaps: sitemap_audit,
        ctr_opportunities,
        striking_distance,
        declining,
        cannibalization,
        device_gap,
        search_appearance,
        indexing,
    })
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
            get_sitemap,
            submit_sitemap,
            delete_sitemap,
            inspect_url,
            run_seo_audit,
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
        let inspection_url = site_url
            .strip_prefix("sc-domain:")
            .map(|domain| format!("https://{domain}/"))
            .unwrap_or_else(|| site_url.clone());
        let inspection = super::inspect_url(site_url.to_string(), inspection_url)
            .await
            .expect("service account could not inspect a URL");
        assert!(
            inspection.get("indexStatusResult").is_some(),
            "URL inspection response did not include an index status result"
        );
        let audit = super::run_seo_audit(
            site_url.to_string(),
            "2026-10-19".to_string(),
            "2026-11-15".to_string(),
            "2026-09-21".to_string(),
            "2026-10-18".to_string(),
            "web".to_string(),
            Some(100.0),
            Some(3),
        )
        .await
        .expect("service account could not run the SEO audit");
        assert!(
            !audit.checks.is_empty(),
            "SEO audit did not return any checks"
        );
        assert!(
            audit.indexing.inspected > 0,
            "SEO audit did not inspect any pages"
        );
    }
}
