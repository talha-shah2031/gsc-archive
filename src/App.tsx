import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { AppIcon, type IconName } from "./Icons";
import SeoAudit from "./SeoAudit";
import ContentAudit from "./ContentAudit";
import "./App.css";

type Page = "overview" | "performance" | "inspection" | "seoaudit" | "contentaudit" | "sitemaps" | "vitals";
type Dimension = "query" | "page" | "country" | "device" | "searchAppearance" | "date";
type Range = 1 | 7 | 28 | 90 | 180 | 365 | 480;
type SearchType = "web" | "image" | "video" | "news" | "discover" | "googleNews";
type MetricKey = "clicks" | "impressions" | "ctr" | "position";
type AuditSource = "lighthouse" | "pagespeed";

interface PerformanceFilter {
  dimension: Exclude<Dimension, "date">;
  operator: "contains" | "equals";
  expression: string;
}

interface Site {
  siteUrl: string;
  permissionLevel: string;
}

interface CredentialProfile {
  id: string;
  clientEmail: string;
  projectId: string;
  sites: Site[];
}

interface MetricRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface PerformanceData {
  summary: MetricRow;
  daily: MetricRow[];
  rows: MetricRow[];
}

interface SearchRecommendation {
  category: "issue" | "opportunity" | "configuration";
  title: string;
  description: string;
  page: string;
  changePercent: number;
}

interface SitemapContent {
  type?: string;
  submitted?: string;
  indexed?: string;
}

interface Sitemap {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  warnings?: string;
  errors?: string;
  contents: SitemapContent[];
}

interface InspectionIssue {
  severity?: string;
  message?: string;
  issueMessage?: string;
  issueType?: string;
}

interface IndexStatusInspection {
  verdict?: string;
  coverageState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  pageFetchState?: string;
  robotsTxtState?: string;
  crawledAs?: string;
  userCanonical?: string;
  googleCanonical?: string;
  sitemap?: string[];
  referringUrls?: string[];
}

interface MobileUsabilityInspection {
  verdict?: string;
  issues?: InspectionIssue[];
}

interface RichResultItem {
  name?: string;
  issues?: InspectionIssue[];
}

interface RichResultGroup {
  richResultType?: string;
  items?: RichResultItem[];
}

interface RichResultsInspection {
  verdict?: string;
  detectedItems?: RichResultGroup[];
}

interface AmpInspection {
  verdict?: string;
  ampUrl?: string;
  ampIndexStatusVerdict?: string;
  indexingState?: string;
  pageFetchState?: string;
  robotsTxtState?: string;
  lastCrawlTime?: string;
  issues?: InspectionIssue[];
}

interface UrlInspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: IndexStatusInspection;
  mobileUsabilityResult?: MobileUsabilityInspection;
  richResultsResult?: RichResultsInspection;
  ampResult?: AmpInspection;
}

interface LighthouseCategory {
  id: string;
  title: string;
  score?: number | null;
  auditRefs: string[];
}

interface LighthouseDetailHeading {
  key?: string;
  label?: string;
  valueType?: string;
}

interface LighthouseAuditDetails {
  type?: string;
  headings: LighthouseDetailHeading[];
  items: Record<string, unknown>[];
}

interface LighthouseAudit {
  id: string;
  title: string;
  description: string;
  score?: number | null;
  scoreDisplayMode: string;
  displayValue?: string | null;
  numericValue?: number | null;
  numericUnit?: string | null;
  category?: string | null;
  savingsMs?: number | null;
  savingsBytes?: number | null;
  details?: LighthouseAuditDetails | null;
}

interface PassedAudit {
  id: string;
  title: string;
  category?: string | null;
}

interface LighthouseReport {
  requestedUrl: string;
  finalUrl: string;
  fetchTime: string;
  lighthouseVersion: string;
  strategy: string;
  formFactor?: string | null;
  durationMs: number;
  categories: LighthouseCategory[];
  metrics: LighthouseAudit[];
  audits: LighthouseAudit[];
  passed: PassedAudit[];
  warnings: string[];
}

interface LighthouseEnvironment {
  nodeInstalled: boolean;
  browserInstalled: boolean;
  localCliAvailable: boolean;
  localAvailable: boolean;
}

const navGroups = [
  {
    title: "",
    items: [
      ["overview", "home", "Overview"],
      ["insights", "insights", "Insights"],
      ["performance", "performance", "Performance"],
      ["inspection", "search", "URL inspection"],
    ],
  },
  {
    title: "Audits",
    items: [
      ["seoaudit", "insights", "SEO audit"],
      ["contentaudit", "pages", "Content audit"],
    ],
  },
  {
    title: "Indexing",
    items: [
      ["pages", "pages", "Pages"],
      ["sitemaps", "sitemap", "Sitemaps"],
    ],
  },
  {
    title: "Experience",
    items: [
      ["vitals", "vitals", "Core Web Vitals"],
      ["https", "https", "HTTPS"],
    ],
  },
] as const;

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function dateRange(days: Range) {
  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

function recommendationDateRanges() {
  const currentEnd = new Date();
  currentEnd.setDate(currentEnd.getDate() - 3);
  const currentStart = new Date(currentEnd);
  currentStart.setDate(currentStart.getDate() - 6);
  const previousEnd = new Date(currentStart);
  previousEnd.setDate(previousEnd.getDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setDate(previousStart.getDate() - 6);
  return {
    currentStart: isoDate(currentStart),
    currentEnd: isoDate(currentEnd),
    previousStart: isoDate(previousStart),
    previousEnd: isoDate(previousEnd),
  };
}

function prettySite(site: string) {
  return site.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function siteOrigin(site: string) {
  const url = site.startsWith("sc-domain:") ? `https://${site.slice(10)}` : site;
  try {
    return new URL(url).origin;
  } catch {
    return `https://${prettySite(site)}`;
  }
}

function SiteFavicon({ siteUrl }: { siteUrl: string }) {
  const origin = siteOrigin(siteUrl);
  const host = prettySite(siteUrl);
  const candidates = [
    `${origin}/favicon-32x32.png`,
    `${origin}/favicon.ico`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
  ];
  const [candidate, setCandidate] = useState(0);
  useEffect(() => setCandidate(0), [siteUrl]);
  return (
    <img
      className="property-favicon"
      src={candidates[candidate]}
      alt=""
      onError={() => setCandidate((current) => Math.min(current + 1, candidates.length - 1))}
    />
  );
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

function formatDate(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function Logo() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <b />
    </div>
  );
}

function Header({ site, sidebarOpen = true, onToggleSidebar, onInspect }: { site?: Site; sidebarOpen?: boolean; onToggleSidebar?: () => void; onInspect?: () => void }) {
  return (
    <header className="topbar">
      <button
        className="icon-button menu-button"
        aria-label={sidebarOpen ? "Hide navigation" : "Show navigation"}
        aria-expanded={sidebarOpen}
        onClick={onToggleSidebar}
      >☰</button>
      <div className="brand"><Logo /><span>Google Search Console</span></div>
      <div
        className="inspect-search"
        role={onInspect ? "button" : undefined}
        tabIndex={onInspect ? 0 : undefined}
        onClick={onInspect}
        onKeyDown={(event) => {
          if (onInspect && (event.key === "Enter" || event.key === " ")) onInspect();
        }}
      >
        <AppIcon name="search" className="header-search-icon" />
        <span>Inspect any URL in "{site ? prettySite(site.siteUrl) : "your property"}"</span>
      </div>
      <div className="top-actions">
        <button className="icon-button">?</button>
        <button className="icon-button">♙</button>
        <button className="icon-button notification">♢<b>3</b></button>
        <button className="icon-button dots">⠿</button>
        <div className="avatar">G</div>
      </div>
    </header>
  );
}

function Sidebar({
  page,
  sites,
  selected,
  onSelect,
  onNavigate,
  onAddAccount,
}: {
  page: Page;
  sites: Site[];
  selected?: Site;
  onSelect: (site: Site) => void;
  onNavigate: (page: Page) => void;
  onAddAccount: () => void;
}) {
  const navigate = (key: string) => {
    if (key === "overview" || key === "performance" || key === "inspection" || key === "seoaudit" || key === "contentaudit" || key === "sitemaps" || key === "vitals") onNavigate(key);
  };
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const handlePointer = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [pickerOpen]);

  return (
    <aside className="sidebar">
      <div className="property-picker" ref={pickerRef}>
        <button
          type="button"
          className="property-trigger"
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          aria-label="Choose Search Console property"
          onClick={() => setPickerOpen((open) => !open)}
        >
          {selected ? <SiteFavicon siteUrl={selected.siteUrl} /> : <span className="site-avatar">G</span>}
          <span className="property-name">{selected ? prettySite(selected.siteUrl) : "Select property"}</span>
          <AppIcon name="chevron" className={"property-caret" + (pickerOpen ? " open" : "")} />
        </button>
        {pickerOpen && (
          <div className="property-menu" role="listbox" aria-label="Search Console properties">
            {sites.map((site) => {
              const isSelected = site.siteUrl === selected?.siteUrl;
              return (
                <button
                  key={site.siteUrl}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={"property-option" + (isSelected ? " selected" : "")}
                  onClick={() => {
                    onSelect(site);
                    setPickerOpen(false);
                  }}
                >
                  <SiteFavicon siteUrl={site.siteUrl} />
                  <span>{prettySite(site.siteUrl)}</span>
                  {isSelected && <b className="property-check">✓</b>}
                </button>
              );
            })}
            <div className="property-menu-divider" />
            <button
              type="button"
              className="property-add-json"
              onClick={() => {
                setPickerOpen(false);
                onAddAccount();
              }}
            >
              <span className="property-add-json-icon">＋</span>
              <span>Add GSC JSON</span>
            </button>
          </div>
        )}
      </div>
      <nav>
        {navGroups.map((group, groupIndex) => (
          <section className="nav-group" key={group.title || "main"}>
            {group.title && <div className="nav-heading"><span>{group.title}</span><b><AppIcon name="chevron" /></b></div>}
            {group.items.map(([key, icon, label]) => (
              <button
                key={key}
                className={(page === key ? "active " : "") + (!["overview", "performance", "sitemaps", "vitals"].includes(key) ? "disabled" : "")}
                onClick={() => navigate(key)}
              >
                <span className="nav-icon">
                  {["home", "insights", "performance", "search", "pages", "sitemap", "vitals", "https"].includes(icon)
                    ? <AppIcon name={icon as IconName} />
                    : icon}
                </span>
                <span>{label}</span>
                {key === "performance" && <AppIcon name="chevron" className="nav-caret" />}
              </button>
            ))}
            {groupIndex < navGroups.length - 1 && <div className="nav-divider" />}
          </section>
        ))}
      </nav>
    </aside>
  );
}

function AddAccountModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [profile, setProfile] = useState<CredentialProfile>();

  const chooseCredential = async () => {
    setStatus("idle");
    setMessage("");
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: "Select Google Search Console service-account JSON",
        filters: [{ name: "Google service account", extensions: ["json"] }],
      });
      if (!selected) return;
      setStatus("loading");
      const imported = await invoke<CredentialProfile>("import_service_account", { path: selected });
      setProfile(imported);
      await onImported();
      setStatus("success");
    } catch (reason) {
      setStatus("error");
      setMessage(String(reason));
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && status !== "loading") onClose();
    }}>
      <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="add-account-title">
        <div className="modal-heading">
          <div className="secure-icon">▣</div>
          <div><h2 id="add-account-title">Add Search Console account</h2><p>Import a Google service-account credential</p></div>
          <button onClick={onClose} disabled={status === "loading"} aria-label="Close">×</button>
        </div>

        {status === "success" && profile ? (
          <div className="import-success">
            <span>✓</span>
            <h3>Account added securely</h3>
            <p>{profile.clientEmail}</p>
            <div><b>{profile.sites.length}</b> accessible {profile.sites.length === 1 ? "property" : "properties"} found</div>
            <button onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <div className="security-note">
              <b>Your private key stays on this device</b>
              <p>Rust reads the selected file directly. It is encrypted with Windows DPAPI for your Windows account and is never exposed to the dashboard or stored in this project.</p>
            </div>
            <div className="import-steps">
              <div><span>1</span><p><b>Select the JSON file</b><small>Choose a Google service-account key downloaded from Google Cloud.</small></p></div>
              <div><span>2</span><p><b>We validate access</b><small>Google authentication and Search Console property access are checked before saving.</small></p></div>
              <div><span>3</span><p><b>Encrypted local storage</b><small>Only encrypted credentials and non-sensitive account metadata are retained.</small></p></div>
            </div>
            {status === "error" && <div className="import-error"><b>Could not add account</b><p>{message}</p></div>}
            <div className="modal-actions">
              <button className="secondary" onClick={onClose} disabled={status === "loading"}>Cancel</button>
              <button className="primary" onClick={() => void chooseCredential()} disabled={status === "loading"}>
                {status === "loading" ? <><span className="button-spinner" />Validating with Google…</> : "Choose JSON file"}
              </button>
            </div>
            <p className="source-reminder">After a successful import, delete the original plaintext JSON from insecure locations.</p>
          </>
        )}
      </section>
    </div>
  );
}

function LineChart({
  rows,
  overview = false,
  visibleMetrics = ["clicks", "impressions"],
}: {
  rows: MetricRow[];
  overview?: boolean;
  visibleMetrics?: MetricKey[];
}) {
  const width = 1100;
  const height = overview ? 220 : 270;
  const pad = { left: 48, right: 48, top: 18, bottom: 38 };
  const maxima: Record<MetricKey, number> = {
    clicks: Math.max(1, ...rows.map((row) => row.clicks)),
    impressions: Math.max(1, ...rows.map((row) => row.impressions)),
    ctr: Math.max(0.01, ...rows.map((row) => row.ctr)),
    position: Math.max(1, ...rows.map((row) => row.position)),
  };
  const axisMetrics = visibleMetrics.slice(0, 2);
  const axisValue = (key: MetricKey, tick: number) => {
    const value = maxima[key] * (1 - tick);
    return key === "ctr" ? `${(value * 100).toFixed(value < .1 ? 1 : 0)}%` : key === "position" ? value.toFixed(1) : formatCompact(Math.round(value));
  };
  const points = (key: MetricKey) =>
    rows.map((row, index) => {
      const x = pad.left + (index / Math.max(1, rows.length - 1)) * (width - pad.left - pad.right);
      const y = pad.top + (1 - row[key] / maxima[key]) * (height - pad.top - pad.bottom);
      return `${x},${y}`;
    }).join(" ");
  const ticks = [0, 0.33, 0.66, 1];
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Search performance chart">
        {ticks.map((tick) => {
          const y = pad.top + tick * (height - pad.top - pad.bottom);
          return (
            <g key={tick}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} className="grid-line" />
              {!overview && axisMetrics[0] && <text x={pad.left - 9} y={y + 4} textAnchor="end">{axisValue(axisMetrics[0], tick)}</text>}
              {!overview && axisMetrics[1] && <text x={width - pad.right + 9} y={y + 4}>{axisValue(axisMetrics[1], tick)}</text>}
            </g>
          );
        })}
        {visibleMetrics.includes("clicks") && <polyline points={points("clicks")} className="click-line" />}
        {!overview && visibleMetrics.includes("impressions") && <polyline points={points("impressions")} className="impression-line" />}
        {!overview && visibleMetrics.includes("ctr") && <polyline points={points("ctr")} className="ctr-line" />}
        {!overview && visibleMetrics.includes("position") && <polyline points={points("position")} className="position-line" />}
        {rows.length > 0 && (
          <>
            {Array.from(new Set([0, 1, 2, 3, 4, 5].map((step) => Math.round(step * (rows.length - 1) / 5)))).map((index) => {
              const x = pad.left + (index / Math.max(1, rows.length - 1)) * (width - pad.left - pad.right);
              return <text key={index} x={x} y={height - 6} textAnchor={index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle"}>{formatDate(rows[index]?.keys[0]).replace(/, \d{4}/, "")}</text>;
            })}
          </>
        )}
      </svg>
    </div>
  );
}

function Skeleton({ variant }: { variant: "boot" | "overview" | "performance" | "sitemaps" | "recommendations" | "vitals" }) {
  if (variant === "vitals") {
    return (
      <div className="skeleton-page" aria-label="Running Lighthouse audit" aria-busy="true">
        <section className="card skeleton-overview">
          <div className="skeleton-heading"><i /><i /></div>
          <div className="skeleton-vitals-rings">{[0, 1, 2, 3].map((item) => <i key={item} />)}</div>
        </section>
        <section className="card skeleton-metrics skeleton-vitals-metrics">{[0, 1, 2, 3, 4, 5, 6].map((item) => <div className="skeleton-block" key={item}><i /><b /></div>)}</section>
        <section className="card skeleton-chart skeleton-vitals-chart"><span /><span /><span /><span /><i className="skeleton-line wide" /><i className="skeleton-line medium" /></section>
        <section className="card skeleton-table">
          <div className="skeleton-heading"><i /><i /></div>
          {[0, 1, 2, 3, 4].map((item) => <div className="skeleton-row" key={item}><i /><i /><i /></div>)}
        </section>
      </div>
    );
  }
  if (variant === "performance") {
    return (
      <div className="skeleton-page" aria-label="Loading performance data" aria-busy="true">
        <section className="card skeleton-report">
          <div className="skeleton-metrics">{[0, 1, 2, 3].map((item) => <div className="skeleton-block" key={item}><i /><b /></div>)}</div>
          <div className="skeleton-chart">
            <span /><span /><span /><span />
            <i className="skeleton-line wide" /><i className="skeleton-line medium" />
          </div>
        </section>
        <section className="card skeleton-table">
          <div className="skeleton-tabs">{[0, 1, 2, 3, 4].map((item) => <i key={item} />)}</div>
          {[0, 1, 2, 3, 4, 5].map((item) => <div className="skeleton-row" key={item}><i /><i /><i /></div>)}
        </section>
      </div>
    );
  }
  if (variant === "sitemaps") {
    return (
      <section className="card skeleton-table skeleton-sitemaps" aria-label="Loading sitemaps" aria-busy="true">
        <div className="skeleton-heading"><i /><i /></div>
        {[0, 1, 2, 3, 4].map((item) => <div className="skeleton-row" key={item}><i /><i /><i /><i /></div>)}
      </section>
    );
  }
  if (variant === "recommendations") {
    return (
      <section className="recommendations skeleton-recommendations" aria-label="Loading recommendations" aria-busy="true">
        <div className="skeleton-heading"><i /><i /></div>
        <div className="skeleton-recommendation-grid">
          {[0, 1].map((item) => <div className="skeleton-block" key={item}><i /><b /><i /></div>)}
        </div>
      </section>
    );
  }
  if (variant === "overview") {
    return (
      <section className="card skeleton-overview" aria-label="Loading overview data" aria-busy="true">
        <div className="skeleton-heading"><i /><i /></div>
        <div className="skeleton-legend"><i /><i /></div>
        <div className="skeleton-chart"><span /><span /><span /><span /><i className="skeleton-line wide" /></div>
      </section>
    );
  }
  return (
    <div className="boot-skeleton" aria-label="Connecting to Google Search Console" aria-busy="true">
      <div className="skeleton-heading"><i /><i /></div>
      <div className="skeleton-block"><i /><b /></div>
      <div className="skeleton-chart"><span /><span /><span /><span /></div>
    </div>
  );
}

function ErrorCard({ error, retry, title = "Search Console data couldn't be loaded" }: { error: string; retry: () => void; title?: string }) {
  return (
    <div className="error-card">
      <b>{title}</b>
      <p>{error}</p>
      <button onClick={retry}>Try again</button>
    </div>
  );
}

function Overview({
  data,
  recommendations,
  recommendationsLoading,
  loading,
  error,
  retry,
  openPerformance,
}: {
  data?: PerformanceData;
  recommendations: SearchRecommendation[];
  recommendationsLoading: boolean;
  loading: boolean;
  error: string;
  retry: () => void;
  openPerformance: () => void;
}) {
  return (
    <>
      <div className="page-title"><h1>Overview</h1></div>
      <div className="overview-content">
        <div className="insight-strip"><span className="bulb">♧</span><span>Get insights into your site's Search performance</span><button onClick={openPerformance}>Explore your insights　›</button></div>
        {loading ? <Skeleton variant="overview" /> : error ? <ErrorCard error={error} retry={retry} /> : data && (
          <section className="card overview-performance">
            <div className="card-heading">
              <h2>Performance</h2>
              <button onClick={openPerformance}>Full report　›</button>
            </div>
            <div className="chart-legend"><i />{formatCompact(data.summary.clicks)} total web search clicks</div>
            <LineChart rows={data.daily} overview />
          </section>
        )}
        {!loading && !error && recommendationsLoading && <Skeleton variant="recommendations" />}
        {!loading && !error && recommendations.length > 0 && (
          <section className="recommendations">
            <div className="recommendations-heading">
              <h2>Recommendations <small>?</small></h2>
            </div>
            <div className="recommendation-list">
              {recommendations.map((recommendation) => (
                <article key={recommendation.page}>
                  <div className="recommendation-title">
                    <span className="recommendation-icon"><AppIcon name="insights" /></span>
                    <h3>{recommendation.title}</h3>
                  </div>
                  <p>{recommendation.description}</p>
                  <div className="recommendation-page">
                    <span>{recommendation.page}</span>
                    <b className={recommendation.changePercent >= 0 ? "trend-up" : "trend-down"}>
                      {recommendation.changePercent >= 0 ? "↑" : "↓"} {Math.abs(recommendation.changePercent).toLocaleString()}%
                    </b>
                  </div>
                  <div className="recommendation-actions">
                    <button onClick={openPerformance}>Check page performance</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

const dimensions: { key: Dimension; label: string; column: string }[] = [
  { key: "query", label: "QUERIES", column: "Top queries" },
  { key: "page", label: "PAGES", column: "Top pages" },
  { key: "country", label: "COUNTRIES", column: "Country" },
  { key: "device", label: "DEVICES", column: "Device" },
  { key: "searchAppearance", label: "SEARCH APPEARANCE", column: "Search appearance" },
  { key: "date", label: "DATES", column: "Date" },
];

function Performance({
  data,
  loading,
  error,
  range,
  dimension,
  searchType,
  performanceFilter,
  siteUrl,
  setRange,
  setDimension,
  setSearchType,
  setPerformanceFilter,
  retry,
}: {
  data?: PerformanceData;
  loading: boolean;
  error: string;
  range: Range;
  dimension: Dimension;
  searchType: SearchType;
  performanceFilter?: PerformanceFilter;
  siteUrl: string;
  setRange: (range: Range) => void;
  setDimension: (dimension: Dimension) => void;
  setSearchType: (searchType: SearchType) => void;
  setPerformanceFilter: (filter?: PerformanceFilter) => void;
  retry: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchTypeOpen, setSearchTypeOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterEditorOpen, setFilterEditorOpen] = useState(false);
  const addFilterRef = useRef<HTMLDivElement>(null);
  const searchTypeRef = useRef<HTMLDivElement>(null);
  const [draftFilter, setDraftFilter] = useState<PerformanceFilter>(
    performanceFilter ?? { dimension: "query", operator: "contains", expression: "" },
  );
  const [visibleMetrics, setVisibleMetrics] = useState<MetricKey[]>(["clicks", "impressions"]);
  const [granularity, setGranularity] = useState<"daily" | "weekly">("daily");
  const [tableSearchOpen, setTableSearchOpen] = useState(false);
  const [tableSearch, setTableSearch] = useState("");
  const [sort, setSort] = useState<{ key: MetricKey | "dimension"; direction: "asc" | "desc" }>({
    key: "clicks",
    direction: "desc",
  });
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [pageNumber, setPageNumber] = useState(1);

  const searchTypes: { key: SearchType; label: string }[] = [
    { key: "web", label: "Web (text)" },
    { key: "image", label: "Image" },
    { key: "video", label: "Video" },
    { key: "news", label: "News" },
    { key: "discover", label: "Discover" },
    { key: "googleNews", label: "Google News" },
  ];
  const metricLabels: Record<MetricKey, string> = { clicks: "Clicks", impressions: "Impressions", ctr: "CTR", position: "Position" };
  const rangeLabel = (days: Range) => days === 1 ? "1 day" : days === 90 ? "3 months" : days === 180 ? "6 months" : days === 365 ? "12 months" : days === 480 ? "16 months" : `${days} days`;
  const activeSearchType = searchTypes.find((item) => item.key === searchType)?.label ?? "Web";
  const filterLabels: Record<PerformanceFilter["dimension"], string> = {
    query: "Query",
    page: "Page",
    country: "Country",
    device: "Device",
    searchAppearance: "Search appearance",
  };
  const availableFilterDimensions = (Object.keys(filterLabels) as PerformanceFilter["dimension"][])
    .filter((item) => !((searchType === "discover" || searchType === "googleNews") && item === "query"));
  const chooseFilterDimension = (filterDimension: PerformanceFilter["dimension"]) => {
    setDraftFilter({
      dimension: filterDimension,
      operator: filterDimension === "device" || filterDimension === "country" || filterDimension === "searchAppearance" ? "equals" : "contains",
      expression: filterDimension === "device" ? "DESKTOP" : "",
    });
    setFilterEditorOpen(true);
  };
  const closeFilter = () => {
    setFilterOpen(false);
    setFilterEditorOpen(false);
  };
  const applyFilter = () => {
    if (!draftFilter.expression.trim()) return;
    setPerformanceFilter({ ...draftFilter, expression: draftFilter.expression.trim() });
    closeFilter();
  };
  const chooseSearchType = (nextType: SearchType) => {
    setSearchType(nextType);
    if (nextType === "discover" || nextType === "googleNews") {
      if (dimension === "query") setDimension("page");
      if (performanceFilter?.dimension === "query") setPerformanceFilter(undefined);
      if (draftFilter.dimension === "query") setDraftFilter({ ...draftFilter, dimension: "page" });
    }
    setSearchTypeOpen(false);
  };

  const rows = useMemo(() => {
    const query = tableSearch.trim().toLowerCase();
    const filtered = (data?.rows ?? []).filter((row) => !query || (row.keys[0] ?? "").toLowerCase().includes(query));
    return [...filtered].sort((a, b) => {
      const left = sort.key === "dimension" ? (a.keys[0] ?? "") : a[sort.key];
      const right = sort.key === "dimension" ? (b.keys[0] ?? "") : b[sort.key];
      const comparison = typeof left === "string" ? left.localeCompare(String(right)) : left - Number(right);
      return sort.direction === "asc" ? comparison : -comparison;
    });
  }, [data, tableSearch, sort]);
  const chartRows = useMemo(() => {
    const daily = data?.daily ?? [];
    if (granularity === "daily") return daily;
    const weekly: MetricRow[] = [];
    for (let index = 0; index < daily.length; index += 7) {
      const group = daily.slice(index, index + 7);
      const clicks = group.reduce((sum, row) => sum + row.clicks, 0);
      const impressions = group.reduce((sum, row) => sum + row.impressions, 0);
      const weightedPosition = group.reduce((sum, row) => sum + row.position * row.impressions, 0);
      weekly.push({
        keys: [group[0]?.keys[0] ?? ""],
        clicks,
        impressions,
        ctr: impressions ? clicks / impressions : 0,
        position: impressions ? weightedPosition / impressions : 0,
      });
    }
    return weekly;
  }, [data, granularity]);
  const totalPages = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  const currentPage = Math.min(pageNumber, totalPages);
  const start = (currentPage - 1) * rowsPerPage;
  const pageRows = rows.slice(start, start + rowsPerPage);

  useEffect(() => setPageNumber(1), [dimension, rowsPerPage, tableSearch, data]);
  useEffect(() => {
    if (range < 28) setGranularity("daily");
  }, [range]);
  useEffect(() => {
    if (!filterOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!addFilterRef.current?.contains(event.target as Node)) closeFilter();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFilter();
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [filterOpen]);
  useEffect(() => {
    if (!searchTypeOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!searchTypeRef.current?.contains(event.target as Node)) setSearchTypeOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSearchTypeOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [searchTypeOpen]);

  const changeSort = (key: MetricKey | "dimension") => {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
      : { key, direction: key === "dimension" ? "asc" : "desc" });
  };
  const sortMark = (key: MetricKey | "dimension") => sort.key === key ? (sort.direction === "desc" ? "↓" : "↑") : "";
  const toggleMetric = (key: MetricKey) => {
    setVisibleMetrics((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };
  const exportCsv = () => {
    if (!data) return;
    const header = ["Dimension", "Clicks", "Impressions", "CTR", "Position"];
    const body = rows.map((row) => [row.keys[0], row.clicks, row.impressions, row.ctr, row.position]);
    const csv = [header, ...body].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = `search-console-${dimension}-${searchType}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <>
      <div className="page-title performance-title"><h1>Performance</h1><button onClick={exportCsv}>⬇　EXPORT</button></div>
      <div className="filter-bar performance-filter-bar">
        <div className="range-buttons">
          {([1, 7, 28, 90] as Range[]).map((days) => (
            <button key={days} className={range === days ? "selected" : ""} onClick={() => setRange(days)}>
              {range === days && "✓　"}{rangeLabel(days)}
            </button>
          ))}
          <div className="filter-menu-wrap">
            <button className={range > 90 ? "selected" : ""} onClick={() => setMoreOpen((open) => !open)}>
              {range > 90 && "✓　"}{range > 90 ? rangeLabel(range) : "More"}　<AppIcon name="chevron" className="caret-down" />
            </button>
            {moreOpen && <div className="filter-menu range-menu">
              {([180, 365, 480] as Range[]).map((days) => (
                <button key={days} onClick={() => { setRange(days); setMoreOpen(false); }}>{rangeLabel(days)}</button>
              ))}
            </div>}
          </div>
        </div>
        <span className="filter-divider" />
        <div className="filter-menu-wrap" ref={searchTypeRef}>
          <button className="filter-chip" onClick={() => setSearchTypeOpen((open) => !open)}>Search type: {activeSearchType}　<AppIcon name="chevron" className="caret-down" /></button>
          {searchTypeOpen && <div className="filter-menu search-type-menu">
            {searchTypes.map((item) => (
              <button key={item.key} className={searchType === item.key ? "active" : ""} onClick={() => chooseSearchType(item.key)}>
                <span>{searchType === item.key ? "✓" : ""}</span>{item.label}
              </button>
            ))}
          </div>}
        </div>
        {performanceFilter && (
          <button className="filter-chip active-filter" onClick={() => {
            setDraftFilter(performanceFilter);
            setFilterOpen(true);
            setFilterEditorOpen(true);
          }}>
            {performanceFilter.dimension}: {performanceFilter.expression}
            <span onClick={(event) => { event.stopPropagation(); setPerformanceFilter(undefined); }}>×</span>
          </button>
        )}
        <div className="filter-menu-wrap" ref={addFilterRef}>
          <button className="filter-chip" onClick={() => {
            if (filterOpen) closeFilter();
            else {
              setFilterOpen(true);
              setFilterEditorOpen(false);
            }
          }}>＋　Add filter</button>
          {filterOpen && !filterEditorOpen && (
            <div className="filter-menu add-filter-menu">
              {availableFilterDimensions.map((item) => <button key={item} onClick={() => chooseFilterDimension(item)}>{filterLabels[item]}</button>)}
            </div>
          )}
          {filterOpen && filterEditorOpen && <div className="filter-panel">
            <div className="filter-panel-title">
              <button onClick={() => setFilterEditorOpen(false)} aria-label="Back to filter types">‹</button>
              <b>Filter by {filterLabels[draftFilter.dimension]}</b>
            </div>
            {draftFilter.dimension !== "device" && <label>Match
              <select value={draftFilter.operator} onChange={(event) => setDraftFilter({ ...draftFilter, operator: event.target.value as PerformanceFilter["operator"] })}>
                <option value="contains">Contains</option>
                <option value="equals">Exactly matches</option>
              </select>
            </label>}
            <label>{draftFilter.dimension === "device" ? "Device type" : filterLabels[draftFilter.dimension]}
              {draftFilter.dimension === "device" ? (
                <select autoFocus value={draftFilter.expression} onChange={(event) => setDraftFilter({ ...draftFilter, expression: event.target.value })}>
                  <option value="DESKTOP">Desktop</option>
                  <option value="MOBILE">Mobile</option>
                  <option value="TABLET">Tablet</option>
                </select>
              ) : (
                <input
                  autoFocus
                  placeholder={draftFilter.dimension === "page" ? "https://example.com/page" : draftFilter.dimension === "country" ? "3-letter country code, e.g. USA" : `Enter ${filterLabels[draftFilter.dimension].toLowerCase()}`}
                  value={draftFilter.expression}
                  onChange={(event) => setDraftFilter({ ...draftFilter, expression: event.target.value })}
                  onKeyDown={(event) => { if (event.key === "Enter") applyFilter(); }}
                />
              )}
            </label>
            <div className="filter-panel-actions"><button onClick={closeFilter}>Cancel</button><button disabled={!draftFilter.expression.trim()} onClick={applyFilter}>Apply</button></div>
          </div>}
        </div>
        <button className="reset-filters" onClick={() => setPerformanceFilter(undefined)}>Reset filters</button>
        <span className="last-update">Final data through 3 days ago</span>
      </div>
      <div className="performance-content">
        {loading ? <Skeleton variant="performance" /> : error ? <ErrorCard error={error} retry={retry} /> : data && (
          <>
            <section className="card report-card">
              <select className="granularity-select" value={granularity} onChange={(event) => setGranularity(event.target.value as "daily" | "weekly")}>
                <option value="daily">Daily</option>
                <option value="weekly" disabled={range < 28}>Weekly</option>
              </select>
              <div className="metric-cards">
                <button className={"metric clicks" + (visibleMetrics.includes("clicks") ? " selected" : "")} onClick={() => toggleMetric("clicks")}><span>{visibleMetrics.includes("clicks") ? "☑" : "□"} Total clicks</span><strong>{formatCompact(data.summary.clicks)}</strong><b title="Clicks from Google Search">?</b></button>
                <button className={"metric impressions" + (visibleMetrics.includes("impressions") ? " selected" : "")} onClick={() => toggleMetric("impressions")}><span>{visibleMetrics.includes("impressions") ? "☑" : "□"} Total impressions</span><strong>{formatCompact(data.summary.impressions)}</strong><b title="Times your site appeared in search">?</b></button>
                <button className={"metric ctr" + (visibleMetrics.includes("ctr") ? " selected" : "")} onClick={() => toggleMetric("ctr")}><span>{visibleMetrics.includes("ctr") ? "☑" : "□"} Average CTR</span><strong>{(data.summary.ctr * 100).toFixed(1)}%</strong><b title="Clicks divided by impressions">?</b></button>
                <button className={"metric position" + (visibleMetrics.includes("position") ? " selected" : "")} onClick={() => toggleMetric("position")}><span>{visibleMetrics.includes("position") ? "☑" : "□"} Average position</span><strong>{data.summary.position.toFixed(1)}</strong><b title="Average topmost search position">?</b></button>
              </div>
              <div className="chart-labels">
                <span>{visibleMetrics[0] ? metricLabels[visibleMetrics[0]] : "Daily performance"}</span>
                <span>{visibleMetrics[1] ? metricLabels[visibleMetrics[1]] : rangeLabel(range)}</span>
              </div>
              <LineChart rows={chartRows} visibleMetrics={visibleMetrics} />
              <div className="performance-info">
                <span className="info-icon">i</span>
                <span>Get more details on your site's performance in generative AI features on Google Search</span>
                <button onClick={() => window.open(`https://search.google.com/search-console/performance/search-appearance?resource_id=${encodeURIComponent(siteUrl)}`, "_blank", "noopener,noreferrer")}>Open report　›</button>
              </div>
            </section>
            <section className="card data-table-card">
              <div className="tabs">
                {dimensions.map((item) => {
                  const unavailable = (searchType === "discover" || searchType === "googleNews") && item.key === "query";
                  return <button key={item.key} disabled={unavailable} title={unavailable ? `Queries aren't available for ${activeSearchType}` : ""} className={dimension === item.key ? "active" : ""} onClick={() => setDimension(item.key)}>{item.label}</button>;
                })}
              </div>
              <div className="table-filter">
                {tableSearchOpen && <input autoFocus placeholder={`Filter ${dimensions.find((item) => item.key === dimension)?.column.toLowerCase()}`} value={tableSearch} onChange={(event) => setTableSearch(event.target.value)} />}
                {tableSearch && <button onClick={() => setTableSearch("")}>Clear</button>}
                <button aria-label="Filter table" className={tableSearchOpen ? "active" : ""} onClick={() => setTableSearchOpen((open) => !open)}>≡</button>
              </div>
              <table>
                <thead><tr>
                  <th><button onClick={() => changeSort("dimension")}>{dimensions.find((item) => item.key === dimension)?.column} {sortMark("dimension")}</button></th>
                  <th><button onClick={() => changeSort("clicks")}>{sortMark("clicks")}　Clicks</button></th>
                  <th><button onClick={() => changeSort("impressions")}>{sortMark("impressions")}　Impressions</button></th>
                  <th><button onClick={() => changeSort("ctr")}>{sortMark("ctr")}　CTR</button></th>
                  <th><button onClick={() => changeSort("position")}>{sortMark("position")}　Position</button></th>
                </tr></thead>
                <tbody>
                  {pageRows.map((row, index) => (
                    <tr key={`${row.keys[0]}-${index}`}>
                      <td>{dimension === "date" ? formatDate(row.keys[0]) : row.keys[0]}</td>
                      <td className="blue">{formatCompact(row.clicks)}</td>
                      <td className="purple">{formatCompact(row.impressions)}</td>
                      <td className="teal">{(row.ctr * 100).toFixed(1)}%</td>
                      <td className="orange">{row.position.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && <div className="empty-state">No data was returned for this period or table filter.</div>}
              <div className="pagination">
                <label>Rows per page:
                  <select value={rowsPerPage} onChange={(event) => setRowsPerPage(Number(event.target.value))}>
                    {[10, 25, 50, 100].map((count) => <option key={count} value={count}>{count}</option>)}
                  </select>
                </label>
                <span>{rows.length ? start + 1 : 0}–{Math.min(start + rowsPerPage, rows.length)} of {rows.length}</span>
                <button disabled={currentPage === 1} onClick={() => setPageNumber((page) => Math.max(1, page - 1))}>‹</button>
                <button disabled={currentPage === totalPages} onClick={() => setPageNumber((page) => Math.min(totalPages, page + 1))}>›</button>
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}

function Sitemaps({
  items,
  loading,
  error,
  retry,
  siteUrl,
}: {
  items: Sitemap[];
  loading: boolean;
  error: string;
  retry: () => void;
  siteUrl: string;
}) {
  const prefix = siteUrl.startsWith("sc-domain:") ? `https://${siteUrl.slice(10)}/` : siteUrl;
  const [sitemapInput, setSitemapInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionPath, setActionPath] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");
  const [detailsPath, setDetailsPath] = useState("");
  const [details, setDetails] = useState<Sitemap>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [pageNumber, setPageNumber] = useState(1);

  const totalPages = Math.max(1, Math.ceil(items.length / rowsPerPage));
  const currentPage = Math.min(pageNumber, totalPages);
  const start = (currentPage - 1) * rowsPerPage;
  const visibleItems = items.slice(start, start + rowsPerPage);

  useEffect(() => setPageNumber(1), [items.length, rowsPerPage, siteUrl]);

  function fullSitemapUrl() {
    const value = sitemapInput.trim();
    if (!value) return "";
    if (/^https?:\/\//i.test(value)) return value;
    try {
      return new URL(value.replace(/^\/+/, ""), prefix.endsWith("/") ? prefix : `${prefix}/`).toString();
    } catch {
      return value;
    }
  }

  async function submit() {
    const sitemapUrl = fullSitemapUrl();
    if (!sitemapUrl) return;
    setSubmitting(true);
    setActionError("");
    setActionSuccess("");
    try {
      await invoke("submit_sitemap", { siteUrl, sitemapUrl });
      setSitemapInput("");
      setActionSuccess("Sitemap submitted successfully.");
      await retry();
    } catch (reason) {
      setActionError(String(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function openDetails(item: Sitemap) {
    setDetailsPath(item.path);
    setDetails(undefined);
    setDetailsLoading(true);
    setActionError("");
    try {
      setDetails(await invoke<Sitemap>("get_sitemap", { siteUrl, sitemapUrl: item.path }));
    } catch (reason) {
      setActionError(String(reason));
      setDetailsPath("");
    } finally {
      setDetailsLoading(false);
    }
  }

  async function remove(item: Sitemap) {
    if (!window.confirm(`Delete this sitemap from Search Console?\n\n${item.path}`)) return;
    setActionPath(item.path);
    setActionError("");
    setActionSuccess("");
    try {
      await invoke("delete_sitemap", { siteUrl, sitemapUrl: item.path });
      setActionSuccess("Sitemap deleted successfully.");
      if (detailsPath === item.path) {
        setDetailsPath("");
        setDetails(undefined);
      }
      await retry();
    } catch (reason) {
      setActionError(String(reason));
    } finally {
      setActionPath("");
    }
  }

  return (
    <>
      <div className="page-title"><h1>Sitemaps</h1></div>
      <div className="sitemap-content">
        <section className="card add-sitemap">
          <h2>Add a new sitemap</h2>
          <div>
            <span>{prefix}</span>
            <input
              value={sitemapInput}
              placeholder="sitemap.xml"
              disabled={submitting}
              onChange={(event) => setSitemapInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && sitemapInput.trim() && !submitting) void submit();
              }}
            />
            <button disabled={!sitemapInput.trim() || submitting} onClick={() => void submit()}>
              {submitting ? "SUBMITTING…" : "SUBMIT"}
            </button>
          </div>
          <small>Submitting and deleting require Full user or Owner permission for the service-account email.</small>
          {actionSuccess && <p className="sitemap-feedback success">{actionSuccess}</p>}
          {actionError && <p className="sitemap-feedback error">{actionError}</p>}
        </section>
        {loading ? <Skeleton variant="sitemaps" /> : error ? <ErrorCard error={error} retry={retry} /> : (
          <section className="card sitemap-table">
            <div className="card-heading"><h2>Submitted sitemaps</h2><span>{items.length} total</span></div>
            <div className="sitemap-table-wrap">
              <table>
                <thead><tr><th>Sitemap</th><th>Type</th><th>Submitted　↓</th><th>Last read</th><th>Status</th><th>Submitted URLs</th><th>Indexed URLs</th><th>Actions</th></tr></thead>
                <tbody>
                  {visibleItems.map((item) => {
                    const submitted = item.contents.reduce((total, content) => total + Number(content.submitted ?? 0), 0);
                    const indexed = item.contents.reduce((total, content) => total + Number(content.indexed ?? 0), 0);
                    const errors = Number(item.errors ?? 0);
                    const warnings = Number(item.warnings ?? 0);
                    const status = item.isPending ? "Pending" : errors > 0 ? `${errors} errors` : warnings > 0 ? `${warnings} warnings` : "Success";
                    const contentTypes = [...new Set(item.contents.map((content) => content.type).filter(Boolean))].join(", ");
                    return (
                      <tr key={item.path}>
                        <td title={item.path}>{item.path.replace(prefix.replace(/\/$/, ""), "") || item.path}</td>
                        <td>{item.isSitemapsIndex ? "Sitemap index" : (contentTypes || item.type || "Sitemap")}</td>
                        <td>{formatDateTime(item.lastSubmitted)}</td>
                        <td>{formatDateTime(item.lastDownloaded)}</td>
                        <td><span className={`sitemap-status ${status === "Success" ? "success" : errors > 0 ? "error" : "warning"}`}>{status}</span></td>
                        <td>{formatCompact(submitted)}</td>
                        <td>{formatCompact(indexed)}</td>
                        <td>
                          <div className="sitemap-actions">
                            <button title="View sitemap details" onClick={() => void openDetails(item)}>Details</button>
                            <button className="delete" title="Delete sitemap" disabled={actionPath === item.path} onClick={() => void remove(item)}>
                              {actionPath === item.path ? "Deleting…" : "Delete"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {items.length === 0 && <div className="empty-state">No submitted sitemaps found.</div>}
            <div className="pagination">
              <label>Rows per page:
                <select value={rowsPerPage} onChange={(event) => setRowsPerPage(Number(event.target.value))}>
                  {[10, 25, 50, 100].map((count) => <option key={count} value={count}>{count}</option>)}
                </select>
              </label>
              <span>{items.length ? start + 1 : 0}–{Math.min(start + rowsPerPage, items.length)} of {items.length}</span>
              <button disabled={currentPage === 1} onClick={() => setPageNumber((value) => Math.max(1, value - 1))}>‹</button>
              <button disabled={currentPage === totalPages} onClick={() => setPageNumber((value) => Math.min(totalPages, value + 1))}>›</button>
            </div>
          </section>
        )}
      </div>
      {detailsPath && (
        <div className="modal-backdrop" onMouseDown={() => {
          setDetailsPath("");
          setDetails(undefined);
        }}>
          <section className="sitemap-detail-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="sitemap-detail-heading">
              <div><span>Sitemap details</span><h2>{detailsPath}</h2></div>
              <button aria-label="Close sitemap details" onClick={() => {
                setDetailsPath("");
                setDetails(undefined);
              }}>×</button>
            </div>
            {detailsLoading || !details ? <Skeleton variant="sitemaps" /> : (
              <>
                <div className="sitemap-detail-grid">
                  <div><span>Last submitted</span><b>{formatDateTime(details.lastSubmitted)}</b></div>
                  <div><span>Last downloaded</span><b>{formatDateTime(details.lastDownloaded)}</b></div>
                  <div><span>Status</span><b>{details.isPending ? "Pending" : Number(details.errors ?? 0) > 0 ? "Has errors" : "Success"}</b></div>
                  <div><span>Sitemap format</span><b>{details.isSitemapsIndex ? "Sitemap index" : "Normal sitemap"}</b></div>
                  <div><span>Warnings</span><b>{details.warnings ?? "0"}</b></div>
                  <div><span>Errors</span><b>{details.errors ?? "0"}</b></div>
                </div>
                <div className="sitemap-content-details">
                  <h3>Sitemap content</h3>
                  <table>
                    <thead><tr><th>Content type</th><th>Submitted URLs</th><th>Indexed URLs</th></tr></thead>
                    <tbody>
                      {details.contents.map((content, index) => (
                        <tr key={`${content.type}-${index}`}><td>{content.type ?? "Unknown"}</td><td>{content.submitted ?? "0"}</td><td>{content.indexed ?? "0"}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  {details.contents.length === 0 && <p>No content counters were returned for this sitemap.</p>}
                </div>
                {actionError && <p className="sitemap-feedback error sitemap-detail-error">{actionError}</p>}
                <div className="sitemap-detail-actions">
                  <button className="delete" disabled={actionPath === details.path} onClick={() => void remove(details)}>Delete sitemap</button>
                  <button onClick={() => {
                    setDetailsPath("");
                    setDetails(undefined);
                  }}>Close</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}

const INSPECTION_ENUM_PREFIX = /^(VERDICT|PAGE_FETCH_STATE|ROBOTS_TXT_STATE|INDEXING_STATE|CRAWLING_USER_AGENT|AMP_INDEXING_STATE)_/;

function inspectionEnum(value?: string) {
  return (value ?? "").replace(INSPECTION_ENUM_PREFIX, "");
}

function inspectionText(value?: string) {
  if (!value) return "Not provided";
  return inspectionEnum(value)
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inspectionTone(value?: string) {
  const state = inspectionEnum(value);
  if (state === "PASS" || state === "SUCCESSFUL" || state === "ALLOWED" || state === "INDEXING_ALLOWED" || state === "AMP_INDEXING_ALLOWED") return "good";
  if (state === "FAIL" || state.startsWith("BLOCKED") || state === "DISALLOWED" || state === "SERVER_ERROR" || state === "NOT_FOUND") return "bad";
  if (state === "PARTIAL") return "warning";
  return "neutral";
}

function InspectionIssues({ issues }: { issues?: InspectionIssue[] }) {
  if (!issues?.length) return <p className="inspection-no-issues">No issues reported.</p>;
  return (
    <ul className="inspection-issues">
      {issues.map((issue, index) => (
        <li key={`${issue.issueType}-${index}`} className={issue.severity?.toLowerCase()}>
          <b>{inspectionText(issue.severity)}</b>
          <span>{issue.message || issue.issueMessage || inspectionText(issue.issueType)}</span>
        </li>
      ))}
    </ul>
  );
}

function UrlInspection({ siteUrl }: { siteUrl: string }) {
  const [url, setUrl] = useState(siteOrigin(siteUrl));
  const [result, setResult] = useState<UrlInspectionResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    setUrl(siteOrigin(siteUrl));
    setResult(undefined);
    setError("");
    setLoading(false);
  }, [siteUrl]);

  async function inspect() {
    const inspectionUrl = url.trim();
    if (!inspectionUrl) {
      setError("Enter a URL to inspect.");
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const response = await invoke<UrlInspectionResult>("inspect_url", { siteUrl, inspectionUrl });
      if (id !== requestId.current) return;
      setResult(response);
    } catch (reason) {
      if (id !== requestId.current) return;
      setResult(undefined);
      setError(String(reason));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  const index = result?.indexStatusResult;
  const indexed = index?.verdict === "PASS";
  const richGroups = result?.richResultsResult?.detectedItems ?? [];
  const richIssues = richGroups.flatMap((group) => (group.items ?? []).flatMap((item) => item.issues ?? []));

  return (
    <>
      <div className="page-title inspection-title"><h1>URL inspection</h1></div>
      <div className="inspection-content">
        <section className="card inspection-runner">
          <label htmlFor="inspection-url">Inspect a URL in this property</label>
          <div>
            <AppIcon name="search" />
            <input
              id="inspection-url"
              value={url}
              spellCheck={false}
              placeholder="https://example.com/page"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !loading) void inspect();
              }}
            />
            <button disabled={loading || !url.trim()} onClick={() => void inspect()}>
              {loading ? "INSPECTING…" : "INSPECT URL"}
            </button>
          </div>
          <small>This report shows Google's indexed version of the URL. The public API does not run a live URL test.</small>
        </section>

        {loading ? <Skeleton variant="overview" /> : error ? (
          <ErrorCard title="The URL couldn't be inspected" error={error} retry={() => void inspect()} />
        ) : !result ? (
          <section className="card inspection-empty">
            <div>⌕</div>
            <h2>Inspect any URL in this property</h2>
            <p>Check indexing, crawl, canonical, mobile usability, rich results and AMP information from Google Search Console.</p>
          </section>
        ) : (
          <>
            <section className={`card inspection-verdict ${indexed ? "indexed" : "not-indexed"}`}>
              <div className="inspection-verdict-icon">{indexed ? "✓" : "!"}</div>
              <div>
                <span>Page indexing</span>
                <h2>{indexed ? "URL is on Google" : "URL is not on Google"}</h2>
                <p>{index?.coverageState || "Google did not provide a coverage description."}</p>
              </div>
              {result.inspectionResultLink && (
                <button onClick={() => window.open(result.inspectionResultLink, "_blank", "noopener,noreferrer")}>OPEN IN SEARCH CONSOLE</button>
              )}
            </section>

            <section className="card inspection-panel">
              <div className="inspection-panel-heading"><h2>Indexing details</h2><span>Google index</span></div>
              <div className="inspection-detail-grid">
                <div><span>Coverage status</span><b>{index?.coverageState || "Not provided"}</b></div>
                <div><span>Indexing status</span><b className={inspectionTone(index?.indexingState)}>{inspectionText(index?.indexingState)}</b></div>
                <div><span>Last crawl</span><b>{formatDateTime(index?.lastCrawlTime)}</b></div>
                <div><span>Page fetch</span><b className={inspectionTone(index?.pageFetchState)}>{inspectionText(index?.pageFetchState)}</b></div>
                <div><span>Robots.txt</span><b className={inspectionTone(index?.robotsTxtState)}>{inspectionText(index?.robotsTxtState)}</b></div>
                <div><span>Crawled as</span><b>{index?.crawledAs ? `${inspectionText(index.crawledAs)} crawler` : "Not provided"}</b></div>
              </div>
            </section>

            <section className="card inspection-panel">
              <div className="inspection-panel-heading"><h2>Canonical and discovery</h2><span>As reported by Google</span></div>
              <div className="inspection-canonical">
                <div><span>User-declared canonical</span><b>{index?.userCanonical || "Not provided"}</b></div>
                <div><span>Google-selected canonical</span><b>{index?.googleCanonical || "Not provided"}</b></div>
              </div>
              <div className="inspection-discovery-grid">
                <div>
                  <h3>Sitemaps</h3>
                  {index?.sitemap?.length ? <ul>{index.sitemap.map((item) => <li key={item}>{item}</li>)}</ul> : <p>No referring sitemap reported.</p>}
                </div>
                <div>
                  <h3>Referring URLs</h3>
                  {index?.referringUrls?.length ? <ul>{index.referringUrls.map((item) => <li key={item}>{item}</li>)}</ul> : <p>Google did not provide referring URLs.</p>}
                </div>
              </div>
            </section>

            <div className="inspection-result-columns">
              <section className="card inspection-panel">
                <div className="inspection-panel-heading">
                  <h2>Mobile usability</h2>
                  <span className={`inspection-badge ${inspectionTone(result.mobileUsabilityResult?.verdict)}`}>{inspectionText(result.mobileUsabilityResult?.verdict)}</span>
                </div>
                {result.mobileUsabilityResult ? <InspectionIssues issues={result.mobileUsabilityResult.issues} /> : <p className="inspection-no-issues">Mobile usability data was not provided by Google.</p>}
              </section>

              <section className="card inspection-panel">
                <div className="inspection-panel-heading">
                  <h2>Rich results</h2>
                  <span className={`inspection-badge ${inspectionTone(result.richResultsResult?.verdict)}`}>{inspectionText(result.richResultsResult?.verdict)}</span>
                </div>
                {richGroups.length > 0 ? (
                  <div className="inspection-rich-types">
                    {richGroups.map((group, index) => <span key={`${group.richResultType}-${index}`}>{group.richResultType || "Structured data"} · {group.items?.length ?? 0}</span>)}
                  </div>
                ) : <p className="inspection-no-issues">No rich-result types detected.</p>}
                <InspectionIssues issues={richIssues} />
              </section>
            </div>

            <section className="card inspection-panel">
              <div className="inspection-panel-heading">
                <h2>AMP</h2>
                <span className={`inspection-badge ${inspectionTone(result.ampResult?.verdict)}`}>{result.ampResult ? inspectionText(result.ampResult.verdict) : "Not applicable"}</span>
              </div>
              {result.ampResult ? (
                <>
                  <div className="inspection-detail-grid amp">
                    <div><span>AMP URL</span><b>{result.ampResult.ampUrl || "Not provided"}</b></div>
                    <div><span>AMP index status</span><b>{inspectionText(result.ampResult.ampIndexStatusVerdict)}</b></div>
                    <div><span>Indexing status</span><b>{inspectionText(result.ampResult.indexingState)}</b></div>
                    <div><span>Page fetch</span><b>{inspectionText(result.ampResult.pageFetchState)}</b></div>
                    <div><span>Robots.txt</span><b>{inspectionText(result.ampResult.robotsTxtState)}</b></div>
                    <div><span>Last crawl</span><b>{formatDateTime(result.ampResult.lastCrawlTime)}</b></div>
                  </div>
                  <InspectionIssues issues={result.ampResult.issues} />
                </>
              ) : <p className="inspection-no-issues">No AMP result was returned for this URL.</p>}
            </section>
          </>
        )}
      </div>
    </>
  );
}

function NoCredentials({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="onboarding">
      <section className="onboarding-card">
        <div className="onboarding-icon">▣</div>
        <h1>No key found</h1>
        <p>Please add a key to continue.</p>
        <p className="onboarding-detail">
          Import your Google Search Console service-account JSON to load your properties.
          The key is validated with Google, encrypted with Windows DPAPI, and stored only on this device.
        </p>
        <button onClick={onAdd}>Add key JSON</button>
        <small>Your private key is never sent to the dashboard or saved in this project.</small>
      </section>
    </div>
  );
}

const cwvMetricConfig: {
  id: string;
  abbreviation: string;
  label: string;
  good: number;
  poor: number;
  goodLabel: string;
  poorLabel: string;
}[] = [
  { id: "largest-contentful-paint", abbreviation: "LCP", label: "Largest Contentful Paint", good: 2500, poor: 4000, goodLabel: "2.5 s", poorLabel: "4.0 s" },
  { id: "interaction-to-next-paint", abbreviation: "INP", label: "Interaction to Next Paint", good: 200, poor: 500, goodLabel: "200 ms", poorLabel: "500 ms" },
  { id: "cumulative-layout-shift", abbreviation: "CLS", label: "Cumulative Layout Shift", good: 0.1, poor: 0.25, goodLabel: "0.1", poorLabel: "0.25" },
  { id: "total-blocking-time", abbreviation: "TBT", label: "Total Blocking Time", good: 200, poor: 600, goodLabel: "200 ms", poorLabel: "600 ms" },
  { id: "first-contentful-paint", abbreviation: "FCP", label: "First Contentful Paint", good: 1800, poor: 3000, goodLabel: "1.8 s", poorLabel: "3.0 s" },
  { id: "speed-index", abbreviation: "SI", label: "Speed Index", good: 3400, poor: 5800, goodLabel: "3.4 s", poorLabel: "5.8 s" },
  { id: "server-response-time", abbreviation: "TTFB", label: "Time to First Byte", good: 800, poor: 1800, goodLabel: "0.8 s", poorLabel: "1.8 s" },
];

function scoreRating(score?: number | null) {
  if (score === null || score === undefined) return "unknown";
  if (score >= 0.9) return "good";
  if (score >= 0.5) return "average";
  return "poor";
}

function ratingLabel(rating: string) {
  if (rating === "good") return "Good";
  if (rating === "average") return "Needs improvement";
  if (rating === "poor") return "Poor";
  return "No data";
}

function metricRating(audit: LighthouseAudit, good: number, poor: number) {
  if (audit.numericValue !== null && audit.numericValue !== undefined) {
    if (audit.numericValue <= good) return "good";
    if (audit.numericValue <= poor) return "average";
    return "poor";
  }
  return scoreRating(audit.score);
}

function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(formatDetailValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.snippet === "string") return record.snippet;
    if (typeof record.selector === "string") return record.selector;
    if (typeof record.text === "string") return record.text;
    return Object.entries(record)
      .map(([key, item]) => `${key}: ${formatDetailValue(item)}`)
      .join(" · ");
  }
  return String(value);
}

function formatAuditTime(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ScoreRing({ score, label, size = 96 }: { score?: number | null; label: string; size?: number }) {
  const value = Math.max(0, Math.min(1, score ?? 0));
  const stroke = Math.max(5, size * 0.075);
  const radius = size / 2 - stroke;
  const circumference = 2 * Math.PI * radius;
  const rating = scoreRating(score);
  return (
    <div className={`cwv-ring ${rating}`} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${score === null || score === undefined ? "no score" : Math.round(value * 100)}`}>
        <circle className="cwv-ring-track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} />
        <circle
          className="cwv-ring-value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          strokeDasharray={`${value * circumference} ${circumference}`}
        />
      </svg>
      <span className="cwv-ring-label">
        <b>{score === null || score === undefined ? "—" : Math.round(value * 100)}</b>
        <small>{label}</small>
      </span>
    </div>
  );
}

function CoreWebVitals({ siteUrl }: { siteUrl: string }) {
  const [url, setUrl] = useState(siteOrigin(siteUrl));
  const [strategy, setStrategy] = useState<"mobile" | "desktop">("mobile");
  const [source, setSource] = useState<AuditSource>();
  const [environment, setEnvironment] = useState<LighthouseEnvironment>();
  const [environmentError, setEnvironmentError] = useState(false);
  const [report, setReport] = useState<LighthouseReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedAudit, setExpandedAudit] = useState<string>();
  const [showAllPassed, setShowAllPassed] = useState(false);
  const requestId = useRef(0);

  async function analyze(force = false) {
    const target = url.trim();
    if (!target) {
      setError("Enter a page URL to audit.");
      return;
    }
    if (!source) return;
    if (source === "lighthouse" && !environment?.localAvailable) {
      setError("Local Lighthouse is unavailable. Use PageSpeed Insights instead.");
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const command = source === "lighthouse" ? "run_lighthouse" : "run_pagespeed";
      const result = await invoke<LighthouseReport>(command, { url: target, strategy, force });
      if (id !== requestId.current) return;
      setReport(result);
      setExpandedAudit(undefined);
      setShowAllPassed(false);
    } catch (reason) {
      if (id !== requestId.current) return;
      setError(String(reason));
      setReport(undefined);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void invoke<LighthouseEnvironment>("check_lighthouse_environment")
      .then((result) => {
        if (!active) return;
        setEnvironment(result);
        setEnvironmentError(false);
        setSource(result.localAvailable ? "lighthouse" : "pagespeed");
      })
      .catch(() => {
        if (!active) return;
        setEnvironmentError(true);
        setSource("pagespeed");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    requestId.current += 1;
    setUrl(siteOrigin(siteUrl));
    setReport(undefined);
    setError("");
    setLoading(false);
  }, [siteUrl]);

  const localUnavailableMessage = environmentError
    ? "Local Lighthouse could not be detected. PageSpeed Insights has been selected."
    : environment && !environment.localAvailable
      ? !environment.nodeInstalled && !environment.browserInstalled
        ? "Node.js and Chrome or Edge are not installed. Use PageSpeed Insights to audit this page."
        : !environment.nodeInstalled
          ? "Node.js is not installed. Use PageSpeed Insights, or install Node.js to run Lighthouse locally."
          : !environment.browserInstalled
            ? "Chrome or Edge is not installed. Use PageSpeed Insights, or install a supported browser for local Lighthouse."
            : "The local Lighthouse CLI is unavailable. PageSpeed Insights has been selected."
      : "";

  const performanceCategory = report?.categories.find((category) => category.id === "performance");
  const metricTiles = report
    ? cwvMetricConfig.map((config) => ({ config, audit: report.metrics.find((metric) => metric.id === config.id) }))
    : [];
  const allOpportunities = report
    ? report.audits.filter((audit) => (audit.savingsMs ?? 0) > 0 || (audit.savingsBytes ?? 0) > 0)
    : [];
  const maxSavingsMs = Math.max(...allOpportunities.map((audit) => audit.savingsMs ?? 0), 1);
  const maxSavingsBytes = Math.max(...allOpportunities.map((audit) => audit.savingsBytes ?? 0), 1);
  const opportunities = allOpportunities.slice(0, 10);
  const diagnostics = report
    ? report.audits.filter((audit) => (audit.savingsMs ?? 0) <= 0 && (audit.savingsBytes ?? 0) <= 0)
    : [];
  const passed = report ? (showAllPassed ? report.passed : report.passed.slice(0, 12)) : [];

  return (
    <>
      <div className="page-title performance-title">
        <h1>Core Web Vitals</h1>
        {report && <button onClick={() => void analyze(true)} disabled={loading}>↻　RE-RUN AUDIT</button>}
      </div>
      <div className="cwv-content">
        <section className="card cwv-runner">
          <div className="cwv-source-row">
            <div>
              <span>Audit source</span>
              <small>{source === "lighthouse" ? "Runs on this computer" : "Runs on Google's servers"}</small>
            </div>
            <div className="cwv-source-toggle" role="group" aria-label="Audit source">
              <button
                className={source === "lighthouse" ? "selected" : ""}
                disabled={!environment?.localAvailable || loading}
                title={!environment?.localAvailable ? "Node.js, Chrome or Edge, and Lighthouse CLI are required" : ""}
                onClick={() => {
                  setSource("lighthouse");
                  setReport(undefined);
                  setError("");
                }}
              >
                Lighthouse CLI
              </button>
              <button
                className={source === "pagespeed" ? "selected" : ""}
                disabled={!source || loading}
                onClick={() => {
                  setSource("pagespeed");
                  setReport(undefined);
                  setError("");
                }}
              >
                PageSpeed Insights
              </button>
            </div>
          </div>
          {localUnavailableMessage && (
            <div className="cwv-environment-notice">
              <span>!</span>
              <p><b>Local Lighthouse unavailable</b>{localUnavailableMessage}</p>
            </div>
          )}
          <div className="cwv-runner-row">
            <div className="cwv-url-field">
              <label htmlFor="cwv-url">Page URL</label>
              <input
                id="cwv-url"
                value={url}
                placeholder="https://example.com/"
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !loading) void analyze();
                }}
              />
            </div>
            <div className="cwv-strategy" role="group" aria-label="Audit device">
              <button
                className={strategy === "mobile" ? "selected" : ""}
                onClick={() => {
                  setStrategy("mobile");
                  setReport(undefined);
                  setError("");
                }}
              >
                Mobile
              </button>
              <button
                className={strategy === "desktop" ? "selected" : ""}
                onClick={() => {
                  setStrategy("desktop");
                  setReport(undefined);
                  setError("");
                }}
              >
                Desktop
              </button>
            </div>
            <button className="cwv-run" onClick={() => void analyze()} disabled={loading || !url.trim() || !source}>
              {loading ? <><span className="cwv-spinner" />Auditing…</> : report ? "Re-run audit" : "Analyze page"}
            </button>
          </div>
          <p className="cwv-runner-note">
            {source === "lighthouse"
              ? "Lighthouse CLI audits the page in a local headless browser. This is a single lab run, not field data collected from real visitors."
              : "PageSpeed Insights audits public pages on Google's servers. No local Node.js or browser installation is required."}
          </p>
        </section>

        {loading ? <Skeleton variant="vitals" /> : error ? <ErrorCard title="The audit couldn't be completed" error={error} retry={() => void analyze()} /> : !report ? (
          <section className="card cwv-empty">
            <div className="cwv-empty-icon">⚡</div>
            <h2>Audit any public page</h2>
            <p>Enter a URL above and run the audit to see performance scores, Core Web Vitals, savings opportunities and diagnostics.</p>
            <button className="cwv-run" onClick={() => void analyze()} disabled={loading}>Analyze page</button>
          </section>
        ) : (
          <>
            <section className="card cwv-overview">
              <div className="cwv-overview-top">
                <div className="cwv-scores">
                  {report.categories.map((category) => (
                    <ScoreRing key={category.id} score={category.score} label={category.title} size={98} />
                  ))}
                </div>
                <div className="cwv-verdict">
                  <span className="cwv-chip">{source === "pagespeed" ? "PageSpeed Insights" : "Local Lighthouse"} · Lab audit</span>
                  <h2>{performanceCategory ? ratingLabel(scoreRating(performanceCategory.score)) : "Report ready"}</h2>
                  <p>{report.finalUrl || report.requestedUrl}</p>
                  <span className="cwv-verdict-detail">
                    {report.strategy === "desktop" ? "Desktop" : "Mobile"} · {report.lighthouseVersion ? `Lighthouse ${report.lighthouseVersion}` : "Lighthouse"} · {(report.durationMs / 1000).toFixed(1)} s
                  </span>
                </div>
              </div>
              <div className="cwv-meta">
                <div><span>Audited</span><b>{formatAuditTime(report.fetchTime)}</b></div>
                <div><span>Requested URL</span><b>{report.requestedUrl || url}</b></div>
                <div><span>Final URL</span><b>{report.finalUrl || report.requestedUrl || url}</b></div>
                <div><span>Form factor</span><b>{report.formFactor || report.strategy}</b></div>
              </div>
              {report.warnings.length > 0 && (
                <ul className="cwv-warnings">
                  {report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                </ul>
              )}
            </section>

            {metricTiles.length > 0 && (
              <section className="card cwv-panel">
                <div className="cwv-panel-heading">
                  <h2>Core Web Vitals</h2>
                  <span className="cwv-legend"><i className="good" />Good<i className="average" />Needs improvement<i className="poor" />Poor</span>
                </div>
                <div className="cwv-metric-grid">
                  {metricTiles.map(({ config, audit }) => {
                    const rating = audit ? metricRating(audit, config.good, config.poor) : "unknown";
                    const numericValue = audit?.numericValue;
                    const hasValue = typeof numericValue === "number";
                    const scale = config.poor * 1.35;
                    const position = hasValue ? Math.min(100, Math.max(0, (numericValue / scale) * 100)) : 50;
                    return (
                      <article className={`cwv-metric ${rating}`} key={config.id}>
                        <div className="cwv-metric-head">
                          <span>{config.abbreviation}</span>
                          <b className={rating}>{ratingLabel(rating)}</b>
                        </div>
                        <p>{config.label}</p>
                        <strong>{audit?.displayValue || (hasValue ? String(numericValue) : "—")}</strong>
                        {hasValue ? (
                          <>
                            <div className="cwv-threshold" aria-hidden="true">
                              <i className="good" style={{ width: `${(config.good / scale) * 100}%` }} />
                              <i className="average" style={{ width: `${((config.poor - config.good) / scale) * 100}%` }} />
                              <i className="poor" style={{ width: `${(1 - config.poor / scale) * 100}%` }} />
                              <b style={{ left: `${position}%` }} />
                            </div>
                            <small>Good ≤ {config.goodLabel} · Poor &gt; {config.poorLabel}</small>
                          </>
                        ) : (
                          <small>Not measured in this run</small>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            <div className="cwv-columns">
              <section className="card cwv-panel cwv-opportunities">
                <div className="cwv-panel-heading">
                  <h2>Opportunities</h2>
                  <span>{opportunities.length} found</span>
                </div>
                {opportunities.length === 0 ? (
                  <p className="cwv-muted">No estimated savings were reported for this page.</p>
                ) : (
                  <div className="cwv-bars">
                    {opportunities.map((audit, index) => (
                      <div className="cwv-bar-row" key={audit.id}>
                        <div className="cwv-bar-label">
                          <b title={audit.title}>{index + 1}. {audit.title}</b>
                          <span>{audit.displayValue || `${Math.round(audit.savingsMs ?? 0)} ms`}</span>
                        </div>
                        <div className="cwv-bar-track">
                          <i style={{
                            width: `${Math.max(4, (audit.savingsMs ?? 0) > 0
                              ? ((audit.savingsMs ?? 0) / maxSavingsMs) * 100
                              : ((audit.savingsBytes ?? 0) / maxSavingsBytes) * 100)}%`,
                          }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="card cwv-panel cwv-passed">
                <div className="cwv-panel-heading">
                  <h2>Passed audits</h2>
                  <span>{report.passed.length} checks</span>
                </div>
                {report.passed.length === 0 ? (
                  <p className="cwv-muted">No passed audits were reported.</p>
                ) : (
                  <ul>
                    {passed.map((audit) => (
                      <li key={audit.id}><span>✓</span>{audit.title}</li>
                    ))}
                  </ul>
                )}
                {report.passed.length > 12 && (
                  <button className="cwv-link" onClick={() => setShowAllPassed((value) => !value)}>
                    {showAllPassed ? "Show fewer" : `Show all ${report.passed.length}`}
                  </button>
                )}
              </section>
            </div>

            <section className="card cwv-panel cwv-diagnostics">
              <div className="cwv-panel-heading">
                <h2>Diagnostics</h2>
                <span>{diagnostics.length} audits</span>
              </div>
              {diagnostics.length === 0 ? (
                <p className="cwv-muted">No diagnostics were reported for this page.</p>
              ) : (
                <div className="cwv-table-wrap">
                  <table>
                    <thead>
                      <tr><th>Audit</th><th>Status</th><th>Value</th><th /></tr>
                    </thead>
                    <tbody>
                      {diagnostics.map((audit) => {
                        const rating = scoreRating(audit.score);
                        const isOpen = expandedAudit === audit.id;
                        const details = audit.details;
                        const expandable = Boolean(audit.description || (details && details.items.length > 0));
                        return (
                          <Fragment key={audit.id}>
                            <tr
                              className={(isOpen ? "open" : "") + (expandable ? " expandable" : "")}
                              onClick={() => {
                                if (expandable) setExpandedAudit(isOpen ? undefined : audit.id);
                              }}
                            >
                              <td><b>{audit.title}</b></td>
                              <td><span className={`cwv-status ${rating}`}>{ratingLabel(rating)}</span></td>
                              <td>{audit.displayValue || "—"}</td>
                              <td className="cwv-chevron">{expandable ? (isOpen ? "▴" : "▾") : ""}</td>
                            </tr>
                            {isOpen && (
                              <tr className="cwv-detail-row">
                                <td colSpan={4}>
                                  {audit.description && <p>{audit.description}</p>}
                                  {details && details.items.length > 0 && details.headings.length > 0 && (
                                    <div className="cwv-detail-table-wrap">
                                      <table className="cwv-detail-table">
                                        <thead>
                                          <tr>{details.headings.map((heading, index) => <th key={index}>{heading.label || heading.key}</th>)}</tr>
                                        </thead>
                                        <tbody>
                                          {details.items.map((item, rowIndex) => (
                                            <tr key={rowIndex}>
                                              {details.headings.map((heading, cellIndex) => (
                                                <td key={cellIndex}>{formatDetailValue(item[heading.key ?? ""]) || "—"}</td>
                                              ))}
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}

function App() {
  const [page, setPage] = useState<Page>("overview");
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSite, setSelectedSite] = useState<Site>();
  const [range, setRange] = useState<Range>(90);
  const [dimension, setDimension] = useState<Dimension>("query");
  const [searchType, setSearchType] = useState<SearchType>("web");
  const [performanceFilter, setPerformanceFilter] = useState<PerformanceFilter>();
  const [performance, setPerformance] = useState<PerformanceData>();
  const [recommendations, setRecommendations] = useState<SearchRecommendation[]>([]);
  const [sitemaps, setSitemaps] = useState<Sitemap[]>([]);
  const [loadingSites, setLoadingSites] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [loadingRecommendations, setLoadingRecommendations] = useState(false);
  const [error, setError] = useState("");
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [needsKey, setNeedsKey] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const dates = useMemo(() => dateRange(range), [range]);

  const loadSites = useCallback(async () => {
    setLoadingSites(true);
    setError("");
    try {
      const hasKey = await invoke<boolean>("has_credentials");
      if (!hasKey) {
        setNeedsKey(true);
        setSites([]);
        setSelectedSite(undefined);
        return;
      }
      setNeedsKey(false);
      const result = await invoke<Site[]>("list_sites");
      setSites(result);
      setSelectedSite((current) => result.find((site) => site.siteUrl === current?.siteUrl) ?? result[0]);
      if (result.length === 0) setError("This service account does not have access to any Search Console properties.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoadingSites(false);
    }
  }, []);

  const handleImported = useCallback(async () => {
    setNeedsKey(false);
    await loadSites();
  }, [loadSites]);

  const loadPerformance = useCallback(async () => {
    if (!selectedSite) return;
    setLoadingData(true);
    setError("");
    try {
      const result = await invoke<PerformanceData>("get_performance", {
        siteUrl: selectedSite.siteUrl,
        startDate: dates.startDate,
        endDate: dates.endDate,
        dimension,
        searchType,
        filterDimension: performanceFilter?.dimension,
        filterOperator: performanceFilter?.operator,
        filterExpression: performanceFilter?.expression,
      });
      setPerformance(result);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoadingData(false);
    }
  }, [selectedSite, dates, dimension, searchType, performanceFilter]);

  const loadSitemaps = useCallback(async () => {
    if (!selectedSite) return;
    setLoadingData(true);
    setError("");
    try {
      setSitemaps(await invoke<Sitemap[]>("list_sitemaps", { siteUrl: selectedSite.siteUrl }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoadingData(false);
    }
  }, [selectedSite]);

  const loadRecommendations = useCallback(async () => {
    if (!selectedSite) return;
    setLoadingRecommendations(true);
    try {
      setRecommendations(await invoke<SearchRecommendation[]>("get_recommendations", {
        siteUrl: selectedSite.siteUrl,
        ...recommendationDateRanges(),
      }));
    } catch {
      setRecommendations([]);
    } finally {
      setLoadingRecommendations(false);
    }
  }, [selectedSite]);

  useEffect(() => { void loadSites(); }, [loadSites]);
  useEffect(() => {
    if (!selectedSite) return;
    if (page === "vitals" || page === "inspection" || page === "seoaudit" || page === "contentaudit") return;
    if (page === "sitemaps") void loadSitemaps();
    else {
      void loadPerformance();
      if (page === "overview") void loadRecommendations();
    }
  }, [page, selectedSite, loadPerformance, loadSitemaps, loadRecommendations]);

  const retry = page === "sitemaps" ? loadSitemaps : selectedSite ? loadPerformance : loadSites;
  const shellClass = "app-shell" + (sidebarOpen ? "" : " sidebar-collapsed");
  const toggleSidebar = () => setSidebarOpen((open) => !open);

  if (needsKey && !loadingSites) {
    return (
      <div className={shellClass}>
        <Header sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
        <main className="main onboarding-main">
          <NoCredentials onAdd={() => setAddAccountOpen(true)} />
        </main>
        {addAccountOpen && <AddAccountModal onClose={() => setAddAccountOpen(false)} onImported={handleImported} />}
      </div>
    );
  }

  return (
    <div className={shellClass}>
      <Header site={selectedSite} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} onInspect={() => setPage("inspection")} />
      <Sidebar page={page} sites={sites} selected={selectedSite} onSelect={setSelectedSite} onNavigate={setPage} onAddAccount={() => setAddAccountOpen(true)} />
      <main className="main">
        {loadingSites ? <div className="boot-loading"><Skeleton variant="boot" /></div> :
          !selectedSite ? <div className="boot-loading"><ErrorCard error={error} retry={loadSites} /></div> :
            page === "overview" ? <Overview data={performance} recommendations={recommendations} recommendationsLoading={loadingRecommendations} loading={loadingData} error={error} retry={retry} openPerformance={() => setPage("performance")} /> :
              page === "performance" ? <Performance data={performance} loading={loadingData} error={error} range={range} dimension={dimension} searchType={searchType} performanceFilter={performanceFilter} siteUrl={selectedSite.siteUrl} setRange={setRange} setDimension={setDimension} setSearchType={setSearchType} setPerformanceFilter={setPerformanceFilter} retry={retry} /> :
                page === "inspection" ? <UrlInspection siteUrl={selectedSite.siteUrl} /> :
                page === "seoaudit" ? <SeoAudit siteUrl={selectedSite.siteUrl} /> :
                page === "contentaudit" ? <ContentAudit siteUrl={selectedSite.siteUrl} /> :
                page === "vitals" ? <CoreWebVitals siteUrl={selectedSite.siteUrl} /> :
                <Sitemaps items={sitemaps} loading={loadingData} error={error} retry={retry} siteUrl={selectedSite.siteUrl} />}
      </main>
      {addAccountOpen && <AddAccountModal onClose={() => setAddAccountOpen(false)} onImported={handleImported} />}
    </div>
  );
}

export default App;
