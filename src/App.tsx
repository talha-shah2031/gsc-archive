import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { AppIcon, type IconName } from "./Icons";
import "./App.css";

type Page = "overview" | "performance" | "sitemaps";
type Dimension = "query" | "page" | "country" | "device" | "searchAppearance" | "date";
type Range = 1 | 7 | 28 | 90 | 180 | 365 | 480;
type SearchType = "web" | "image" | "video" | "news" | "discover" | "googleNews";
type MetricKey = "clicks" | "impressions" | "ctr" | "position";

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

function Header({ site, sidebarOpen = true, onToggleSidebar }: { site?: Site; sidebarOpen?: boolean; onToggleSidebar?: () => void }) {
  return (
    <header className="topbar">
      <button
        className="icon-button menu-button"
        aria-label={sidebarOpen ? "Hide navigation" : "Show navigation"}
        aria-expanded={sidebarOpen}
        onClick={onToggleSidebar}
      >☰</button>
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
  const height = overview ? 220 : 330;
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
            <text x={pad.left} y={height - 6}>{formatDate(rows[0].keys[0]).replace(/, \d{4}/, "")}</text>
            <text x={width - pad.right} y={height - 6} textAnchor="end">{formatDate(rows[rows.length - 1]?.keys[0]).replace(/, \d{4}/, "")}</text>
          </>
        )}
      </svg>
    </div>
  );
}

function Skeleton({ variant }: { variant: "boot" | "overview" | "performance" | "sitemaps" | "recommendations" }) {
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
  setRange: (range: Range) => void;
  setDimension: (dimension: Dimension) => void;
  setSearchType: (searchType: SearchType) => void;
  setPerformanceFilter: (filter?: PerformanceFilter) => void;
  retry: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchTypeOpen, setSearchTypeOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftFilter, setDraftFilter] = useState<PerformanceFilter>(
    performanceFilter ?? { dimension: "query", operator: "contains", expression: "" },
  );
  const [visibleMetrics, setVisibleMetrics] = useState<MetricKey[]>(["clicks", "impressions"]);
  const [tableSearchOpen, setTableSearchOpen] = useState(false);
  const [tableSearch, setTableSearch] = useState("");
  const [sort, setSort] = useState<{ key: MetricKey | "dimension"; direction: "asc" | "desc" }>({
    key: "clicks",
    direction: "desc",
  });
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [pageNumber, setPageNumber] = useState(1);

  const searchTypes: { key: SearchType; label: string }[] = [
    { key: "web", label: "Web" },
    { key: "image", label: "Image" },
    { key: "video", label: "Video" },
    { key: "news", label: "News" },
    { key: "discover", label: "Discover" },
    { key: "googleNews", label: "Google News" },
  ];
  const metricLabels: Record<MetricKey, string> = { clicks: "Clicks", impressions: "Impressions", ctr: "CTR", position: "Position" };
  const rangeLabel = (days: Range) => days === 1 ? "1 day" : days === 90 ? "3 months" : days === 180 ? "6 months" : days === 365 ? "12 months" : days === 480 ? "16 months" : `${days} days`;
  const activeSearchType = searchTypes.find((item) => item.key === searchType)?.label ?? "Web";
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
  const totalPages = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  const currentPage = Math.min(pageNumber, totalPages);
  const start = (currentPage - 1) * rowsPerPage;
  const pageRows = rows.slice(start, start + rowsPerPage);

  useEffect(() => setPageNumber(1), [dimension, rowsPerPage, tableSearch, data]);

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
      <div className="filter-bar">
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
        <div className="filter-menu-wrap">
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
          <button className="filter-chip active-filter" onClick={() => setFilterOpen(true)}>
            {performanceFilter.dimension}: {performanceFilter.expression}
            <span onClick={(event) => { event.stopPropagation(); setPerformanceFilter(undefined); }}>×</span>
          </button>
        )}
        <div className="filter-menu-wrap">
          <button className="filter-chip" onClick={() => setFilterOpen((open) => !open)}>＋　Add filter</button>
          {filterOpen && <div className="filter-panel">
            <label>Filter by
              <select value={draftFilter.dimension} onChange={(event) => setDraftFilter({ ...draftFilter, dimension: event.target.value as PerformanceFilter["dimension"] })}>
                {dimensions.filter((item) => item.key !== "date" && !((searchType === "discover" || searchType === "googleNews") && item.key === "query")).map((item) => <option key={item.key} value={item.key}>{item.column}</option>)}
              </select>
            </label>
            <label>Match
              <select value={draftFilter.operator} onChange={(event) => setDraftFilter({ ...draftFilter, operator: event.target.value as PerformanceFilter["operator"] })}>
                <option value="contains">Contains</option>
                <option value="equals">Exactly matches</option>
              </select>
            </label>
            <label>Value
              <input autoFocus value={draftFilter.expression} onChange={(event) => setDraftFilter({ ...draftFilter, expression: event.target.value })} onKeyDown={(event) => {
                if (event.key === "Enter" && draftFilter.expression.trim()) {
                  setPerformanceFilter({ ...draftFilter, expression: draftFilter.expression.trim() });
                  setFilterOpen(false);
                }
              }} />
            </label>
            <div><button onClick={() => setFilterOpen(false)}>Cancel</button><button disabled={!draftFilter.expression.trim()} onClick={() => {
              setPerformanceFilter({ ...draftFilter, expression: draftFilter.expression.trim() });
              setFilterOpen(false);
            }}>Apply</button></div>
          </div>}
        </div>
        <button className="filter-tune" title="Filter options" disabled={!performanceFilter} onClick={() => setPerformanceFilter(undefined)}>☷</button>
        {performanceFilter && <button className="reset-filters" onClick={() => setPerformanceFilter(undefined)}>Reset filters</button>}
        <span className="last-update">Final data through 3 days ago</span>
      </div>
      <div className="performance-content">
        {loading ? <Skeleton variant="performance" /> : error ? <ErrorCard error={error} retry={retry} /> : data && (
          <>
            <section className="card report-card">
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
              <LineChart rows={data.daily} visibleMetrics={visibleMetrics} />
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
  return (
    <>
      <div className="page-title"><h1>Sitemaps</h1></div>
      <div className="sitemap-content">
        <section className="card add-sitemap">
          <h2>Add a new sitemap</h2>
          <div><span>{prefix}</span><input placeholder="Enter sitemap URL" disabled /><button disabled>SUBMIT</button></div>
          <small>Submission is disabled because this app currently uses read-only access.</small>
        </section>
        {loading ? <Skeleton variant="sitemaps" /> : error ? <ErrorCard error={error} retry={retry} /> : (
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
      <Header site={selectedSite} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
      <Sidebar page={page} sites={sites} selected={selectedSite} onSelect={setSelectedSite} onNavigate={setPage} onAddAccount={() => setAddAccountOpen(true)} />
      <main className="main">
        {loadingSites ? <div className="boot-loading"><Skeleton variant="boot" /></div> :
          !selectedSite ? <div className="boot-loading"><ErrorCard error={error} retry={loadSites} /></div> :
            page === "overview" ? <Overview data={performance} recommendations={recommendations} recommendationsLoading={loadingRecommendations} loading={loadingData} error={error} retry={retry} openPerformance={() => setPage("performance")} /> :
              page === "performance" ? <Performance data={performance} loading={loadingData} error={error} range={range} dimension={dimension} searchType={searchType} performanceFilter={performanceFilter} setRange={setRange} setDimension={setDimension} setSearchType={setSearchType} setPerformanceFilter={setPerformanceFilter} retry={retry} /> :
                <Sitemaps items={sitemaps} loading={loadingData} error={error} retry={retry} siteUrl={selectedSite.siteUrl} />}
      </main>
      {addAccountOpen && <AddAccountModal onClose={() => setAddAccountOpen(false)} onImported={handleImported} />}
    </div>
  );
}

export default App;
