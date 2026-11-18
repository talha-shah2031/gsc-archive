import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { AppIcon, type IconName } from "./Icons";
import "./App.css";

type Page = "overview" | "performance" | "sitemaps";
type Dimension = "query" | "page" | "country" | "device" | "searchAppearance" | "date";
type Range = 1 | 7 | 28 | 90;

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
  currentStart.setDate(currentStart.getDate() - 27);
  const previousEnd = new Date(currentStart);
  previousEnd.setDate(previousEnd.getDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setDate(previousStart.getDate() - 27);
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

function Header({ site }: { site?: Site }) {
  return (
    <header className="topbar">
      <button className="icon-button menu-button" aria-label="Menu">☰</button>
      <div className="brand"><Logo /><span>Google Search Console</span></div>
      <div className="inspect-search">
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
    if (key === "overview" || key === "performance" || key === "sitemaps") onNavigate(key);
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
                className={(page === key ? "active " : "") + (!["overview", "performance", "sitemaps"].includes(key) ? "disabled" : "")}
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

function LineChart({ rows, overview = false }: { rows: MetricRow[]; overview?: boolean }) {
  const width = 1100;
  const height = overview ? 220 : 280;
  const pad = { left: 42, right: 42, top: 18, bottom: 34 };
  const maxClicks = Math.max(1, ...rows.map((row) => row.clicks));
  const maxImpressions = Math.max(1, ...rows.map((row) => row.impressions));
  const points = (key: "clicks" | "impressions", max: number) =>
    rows.map((row, index) => {
      const x = pad.left + (index / Math.max(1, rows.length - 1)) * (width - pad.left - pad.right);
      const y = pad.top + (1 - row[key] / max) * (height - pad.top - pad.bottom);
      return `${x},${y}`;
    }).join(" ");
  const ticks = [0, 0.33, 0.66, 1];
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Search performance chart">
        {ticks.map((tick) => {
          const y = pad.top + tick * (height - pad.top - pad.bottom);
          return <line key={tick} x1={pad.left} x2={width - pad.right} y1={y} y2={y} className="grid-line" />;
        })}
        <polyline points={points("clicks", maxClicks)} className="click-line" />
        {!overview && <polyline points={points("impressions", maxImpressions)} className="impression-line" />}
        {rows.length > 0 && (
          <>
            <text x={pad.left} y={height - 6}>{formatDate(rows[0].keys[0]).replace(/, \d{4}/, "")}</text>
            <text x={width - pad.right} y={height - 6} textAnchor="end">{formatDate(rows[rows.length - 1]?.keys[0]).replace(/, \d{4}/, "")}</text>
          </>
        )}
      </svg>
    </div>
  );
}

function LoadingCard({ message = "Loading Search Console data…" }: { message?: string }) {
  return <div className="loading-card"><span className="spinner" />{message}</div>;
}

function ErrorCard({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="error-card">
      <b>Search Console data couldn't be loaded</b>
      <p>{error}</p>
      <button onClick={retry}>Try again</button>
    </div>
  );
}

function Overview({
  data,
  recommendations,
  loading,
  error,
  retry,
  openPerformance,
}: {
  data?: PerformanceData;
  recommendations: SearchRecommendation[];
  loading: boolean;
  error: string;
  retry: () => void;
  openPerformance: () => void;
}) {
  return (
    <>
      <div className="page-title"><h1>Overview</h1></div>
      <div className="overview-content">
        <div className="insight-strip"><span className="bulb">♧</span><span>Get insights into your site's Search performance</span><button>Explore your insights　›</button></div>
        {loading ? <LoadingCard /> : error ? <ErrorCard error={error} retry={retry} /> : data && (
          <section className="card overview-performance">
            <div className="card-heading">
              <h2>Performance</h2>
              <button onClick={openPerformance}>Full report　›</button>
            </div>
            <div className="chart-legend"><i />{formatCompact(data.summary.clicks)} total web search clicks</div>
            <LineChart rows={data.daily} overview />
          </section>
        )}
        {!loading && !error && recommendations.length > 0 && (
          <section className="recommendations">
            <div className="recommendations-heading">
              <h2>Recommendations <small>?</small></h2>
              <button>▣　Send feedback</button>
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
                    <span>♧　♤</span>
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
  setRange,
  setDimension,
  retry,
}: {
  data?: PerformanceData;
  loading: boolean;
  error: string;
  range: Range;
  dimension: Dimension;
  setRange: (range: Range) => void;
  setDimension: (dimension: Dimension) => void;
  retry: () => void;
}) {
  const exportCsv = () => {
    if (!data) return;
    const header = ["Dimension", "Clicks", "Impressions", "CTR", "Position"];
    const body = data.rows.map((row) => [row.keys[0], row.clicks, row.impressions, row.ctr, row.position]);
    const csv = [header, ...body].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = "search-console-performance.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <>
      <div className="page-title performance-title"><h1>Performance</h1><button onClick={exportCsv}>⬇　EXPORT</button></div>
      <div className="filter-bar">
        <div className="range-buttons">
          {([1, 7, 28, 90] as Range[]).map((days) => (
            <button key={days} className={range === days ? "selected" : ""} onClick={() => setRange(days)}>
              {range === days && "✓　"}{days === 1 ? "24 hours" : days === 90 ? "3 months" : `${days} days`}
            </button>
          ))}
          <button>More　<AppIcon name="chevron" className="caret-down" /></button>
        </div>
        <span className="filter-divider" />
        <button className="filter-chip">Search type: Web (text)　<AppIcon name="chevron" className="caret-down" /></button>
        <button className="filter-chip">＋　Add filter</button>
        <button className="filter-tune">☷</button>
        <span className="last-update">Final data through 3 days ago</span>
      </div>
      <div className="performance-content">
        {loading ? <LoadingCard /> : error ? <ErrorCard error={error} retry={retry} /> : data && (
          <>
            <section className="card report-card">
              <div className="metric-cards">
                <div className="metric clicks"><span>☑ Total clicks</span><strong>{formatCompact(data.summary.clicks)}</strong></div>
                <div className="metric impressions"><span>☑ Total impressions</span><strong>{formatCompact(data.summary.impressions)}</strong></div>
                <div className="metric"><span>□ Average CTR</span><strong>{(data.summary.ctr * 100).toFixed(1)}%</strong></div>
                <div className="metric"><span>□ Average position</span><strong>{data.summary.position.toFixed(1)}</strong></div>
              </div>
              <div className="chart-labels"><span>Clicks</span><span>Impressions</span></div>
              <LineChart rows={data.daily} />
            </section>
            <div className="ai-note">ⓘ　Get more details on your site's performance in generative AI features on Google Search <button>Open report　›</button></div>
            <section className="card data-table-card">
              <div className="tabs">
                {dimensions.map((item) => <button key={item.key} className={dimension === item.key ? "active" : ""} onClick={() => setDimension(item.key)}>{item.label}</button>)}
              </div>
              <div className="table-filter">≡</div>
              <table>
                <thead><tr><th>{dimensions.find((item) => item.key === dimension)?.column}</th><th>↓　Clicks</th><th>Impressions</th><th>CTR</th><th>Position</th></tr></thead>
                <tbody>
                  {data.rows.slice(0, 100).map((row, index) => (
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
              {data.rows.length === 0 && <div className="empty-state">No data was returned for this period.</div>}
              <div className="pagination">Rows per page:　10　<AppIcon name="chevron" className="caret-down" />　　 1–{Math.min(100, data.rows.length)} of {data.rows.length}　　‹　›</div>
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
  return (
    <>
      <div className="page-title"><h1>Sitemaps</h1></div>
      <div className="sitemap-content">
        <section className="card add-sitemap">
          <h2>Add a new sitemap</h2>
          <div><span>{prefix}</span><input placeholder="Enter sitemap URL" disabled /><button disabled>SUBMIT</button></div>
          <small>Submission is disabled because this app currently uses read-only access.</small>
        </section>
        {loading ? <LoadingCard /> : error ? <ErrorCard error={error} retry={retry} /> : (
          <section className="card sitemap-table">
            <div className="card-heading"><h2>Submitted sitemaps</h2><span>≡</span></div>
            <table>
              <thead><tr><th>Sitemap</th><th>Type</th><th>Submitted　↓</th><th>Last read</th><th>Status</th><th>Discovered pages</th><th>Discovered videos</th><th /></tr></thead>
              <tbody>
                {items.map((item) => {
                  const pages = item.contents.find((content) => content.type === "web")?.submitted ?? "0";
                  const videos = item.contents.find((content) => content.type === "video")?.submitted ?? "0";
                  const status = item.isPending ? "Pending" : Number(item.errors ?? 0) > 0 ? "Has errors" : "Success";
                  return (
                    <tr key={item.path}>
                      <td>{item.path.replace(prefix.replace(/\/$/, ""), "") || item.path}</td>
                      <td>{item.isSitemapsIndex ? "Sitemap index" : (item.type ?? "Sitemap")}</td>
                      <td>{formatDate(item.lastSubmitted)}</td>
                      <td>{formatDate(item.lastDownloaded)}</td>
                      <td className={status === "Success" ? "success" : "orange"}>{status}</td>
                      <td>{pages}</td><td>{videos}</td><td>⋮</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {items.length === 0 && <div className="empty-state">No submitted sitemaps found.</div>}
            <div className="pagination">Rows per page:　10　<AppIcon name="chevron" className="caret-down" />　　 1–{items.length} of {items.length}　　‹　›</div>
          </section>
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

function App() {
  const [page, setPage] = useState<Page>("overview");
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSite, setSelectedSite] = useState<Site>();
  const [range, setRange] = useState<Range>(90);
  const [dimension, setDimension] = useState<Dimension>("query");
  const [performance, setPerformance] = useState<PerformanceData>();
  const [recommendations, setRecommendations] = useState<SearchRecommendation[]>([]);
  const [sitemaps, setSitemaps] = useState<Sitemap[]>([]);
  const [loadingSites, setLoadingSites] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState("");
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [needsKey, setNeedsKey] = useState(false);

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
      });
      setPerformance(result);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoadingData(false);
    }
  }, [selectedSite, dates, dimension]);

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
    try {
      setRecommendations(await invoke<SearchRecommendation[]>("get_recommendations", {
        siteUrl: selectedSite.siteUrl,
        ...recommendationDateRanges(),
      }));
    } catch {
      setRecommendations([]);
    }
  }, [selectedSite]);

  useEffect(() => { void loadSites(); }, [loadSites]);
  useEffect(() => {
    if (!selectedSite) return;
    if (page === "sitemaps") void loadSitemaps();
    else {
      void loadPerformance();
      if (page === "overview") void loadRecommendations();
    }
  }, [page, selectedSite, loadPerformance, loadSitemaps, loadRecommendations]);

  const retry = page === "sitemaps" ? loadSitemaps : selectedSite ? loadPerformance : loadSites;

  if (needsKey && !loadingSites) {
    return (
      <div className="app-shell">
        <Header />
        <main className="main onboarding-main">
          <NoCredentials onAdd={() => setAddAccountOpen(true)} />
        </main>
        {addAccountOpen && <AddAccountModal onClose={() => setAddAccountOpen(false)} onImported={handleImported} />}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Header site={selectedSite} />
      <Sidebar page={page} sites={sites} selected={selectedSite} onSelect={setSelectedSite} onNavigate={setPage} onAddAccount={() => setAddAccountOpen(true)} />
      <main className="main">
        {loadingSites ? <div className="boot-loading"><LoadingCard message="Connecting to Google Search Console…" /></div> :
          !selectedSite ? <div className="boot-loading"><ErrorCard error={error} retry={loadSites} /></div> :
            page === "overview" ? <Overview data={performance} recommendations={recommendations} loading={loadingData} error={error} retry={retry} openPerformance={() => setPage("performance")} /> :
              page === "performance" ? <Performance data={performance} loading={loadingData} error={error} range={range} dimension={dimension} setRange={setRange} setDimension={setDimension} retry={retry} /> :
                <Sitemaps items={sitemaps} loading={loadingData} error={error} retry={retry} siteUrl={selectedSite.siteUrl} />}
      </main>
      {addAccountOpen && <AddAccountModal onClose={() => setAddAccountOpen(false)} onImported={handleImported} />}
    </div>
  );
}

export default App;
