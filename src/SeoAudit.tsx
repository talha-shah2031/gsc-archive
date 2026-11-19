import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppIcon } from "./Icons";

type AuditStatus = "pass" | "warn" | "fail" | "info";
type AuditSearchType = "web" | "image" | "video" | "news";
type AuditSource = "lighthouse" | "pagespeed";

interface AuditCheck {
  id: string;
  title: string;
  status: AuditStatus;
  count: number;
  description: string;
}

interface AuditMetricRow {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface SeoOverview {
  current: AuditMetricRow;
  previous: AuditMetricRow;
  clicksChange: number;
  impressionsChange: number;
  ctrChange: number;
  positionChange: number;
}

interface SitemapAuditIssue {
  path: string;
  issue: string;
  severity: string;
}

interface SitemapAudit {
  total: number;
  errors: number;
  warnings: number;
  pending: number;
  stale: number;
  zeroIndexed: number;
  submittedUrls: number;
  indexedUrls: number;
  issues: SitemapAuditIssue[];
}

interface CtrOpportunity {
  key: string;
  kind: "query" | "page";
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  benchmarkCtr: number;
  missedClicks: number;
}

interface StrikingDistance {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface DecliningItem {
  key: string;
  kind: "query" | "page";
  clicks: number;
  previousClicks: number;
  impressions: number;
  previousImpressions: number;
  clicksChange: number;
  impressionsChange: number;
  position: number;
  previousPosition: number;
}

interface CannibalPage {
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

interface CannibalizationItem {
  query: string;
  impressions: number;
  pages: CannibalPage[];
}

interface DeviceGapItem {
  page: string;
  mobilePosition: number;
  desktopPosition: number;
  gap: number;
  mobileImpressions: number;
  desktopImpressions: number;
}

interface SearchAppearanceRow {
  appearance: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface IndexingItem {
  url: string;
  verdict: string;
  coverageState: string;
  indexingState: string;
  lastCrawlTime?: string;
  pageFetchState: string;
  robotsTxtState: string;
  crawledAs?: string;
  userCanonical?: string;
  googleCanonical?: string;
  canonicalMismatch: boolean;
  sitemapCount: number;
  mobileIssues: number;
  richIssues: number;
  impressions: number;
  clicks: number;
  issue: string;
}

interface IndexingAudit {
  sampled: number;
  inspected: number;
  indexed: number;
  notIndexed: number;
  failed: number;
  stale: number;
  canonicalMismatches: number;
  robotsBlocked: number;
  fetchFailed: number;
  mobileIssuePages: number;
  richIssuePages: number;
  items: IndexingItem[];
  errors: string[];
}

interface SeoAuditReport {
  generatedAt: number;
  dataStart: string;
  dataEnd: string;
  previousStart: string;
  previousEnd: string;
  searchType: string;
  minImpressions: number;
  inspectLimit: number;
  overview: SeoOverview;
  checks: AuditCheck[];
  sitemaps: SitemapAudit;
  ctrOpportunities: CtrOpportunity[];
  strikingDistance: StrikingDistance[];
  declining: DecliningItem[];
  cannibalization: CannibalizationItem[];
  deviceGap: DeviceGapItem[];
  searchAppearance: SearchAppearanceRow[];
  indexing: IndexingAudit;
}

interface LighthouseCategory {
  id: string;
  title: string;
  score?: number | null;
}

interface LighthouseAudit {
  id: string;
  title: string;
  description: string;
  score?: number | null;
  displayValue?: string | null;
  category?: string | null;
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
  strategy: string;
  categories: LighthouseCategory[];
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

const searchTypes: { key: AuditSearchType; label: string }[] = [
  { key: "web", label: "Web" },
  { key: "image", label: "Image" },
  { key: "video", label: "Video" },
  { key: "news", label: "News" },
];

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function auditRanges(days: number) {
  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  const previousEnd = new Date(start);
  previousEnd.setDate(previousEnd.getDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setDate(previousStart.getDate() - days + 1);
  return {
    startDate: isoDate(start),
    endDate: isoDate(end),
    previousStart: isoDate(previousStart),
    previousEnd: isoDate(previousEnd),
  };
}

function siteOrigin(siteUrl: string) {
  const url = siteUrl.startsWith("sc-domain:") ? `https://${siteUrl.slice(10)}` : siteUrl;
  try {
    return new URL(url).origin;
  } catch {
    return siteUrl;
  }
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

function formatPercent(value: number, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function formatPosition(value: number) {
  return value > 0 ? value.toFixed(1) : "—";
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function appearanceLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatGenerated(value: number) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function changeLabel(value: number, suffix = "%") {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}${suffix}`;
}

function changeTone(value: number, goodWhenPositive = true) {
  if (Math.abs(value) < 0.05) return "neutral";
  return (value > 0) === goodWhenPositive ? "good" : "bad";
}

function statusSymbol(status: AuditStatus) {
  if (status === "pass") return "✓";
  if (status === "fail") return "!";
  if (status === "warn") return "!";
  return "i";
}

function scoreTone(score: number) {
  if (score >= 90) return "good";
  if (score >= 50) return "warn";
  return "bad";
}

function MetricTile({
  label,
  value,
  change,
  suffix = "%",
  goodWhenPositive = true,
}: {
  label: string;
  value: string;
  change: number;
  suffix?: string;
  goodWhenPositive?: boolean;
}) {
  return (
    <div className="seo-metric">
      <span>{label}</span>
      <b>{value}</b>
      <em className={changeTone(change, goodWhenPositive)}>{changeLabel(change, suffix)} vs previous</em>
    </div>
  );
}

function Stat({ label, value, tone = "" }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="seo-stat">
      <span>{label}</span>
      <b className={tone}>{value}</b>
    </div>
  );
}

export default function SeoAudit({ siteUrl }: { siteUrl: string }) {
  const [range, setRange] = useState(28);
  const [searchType, setSearchType] = useState<AuditSearchType>("web");
  const [minImpressions, setMinImpressions] = useState(100);
  const [inspectLimit, setInspectLimit] = useState(25);
  const [report, setReport] = useState<SeoAuditReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const [techUrl, setTechUrl] = useState(siteOrigin(siteUrl));
  const [techSource, setTechSource] = useState<AuditSource>("pagespeed");
  const [techEnvironment, setTechEnvironment] = useState<LighthouseEnvironment>();
  const [techReport, setTechReport] = useState<LighthouseReport>();
  const [techLoading, setTechLoading] = useState(false);
  const [techError, setTechError] = useState("");
  const techRequestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    techRequestId.current += 1;
    setReport(undefined);
    setError("");
    setLoading(false);
    setTechUrl(siteOrigin(siteUrl));
    setTechReport(undefined);
    setTechError("");
    setTechLoading(false);
  }, [siteUrl]);

  useEffect(() => {
    let active = true;
    void invoke<LighthouseEnvironment>("check_lighthouse_environment")
      .then((environment) => {
        if (!active) return;
        setTechEnvironment(environment);
        setTechSource(environment.localAvailable ? "lighthouse" : "pagespeed");
      })
      .catch(() => {
        if (active) setTechSource("pagespeed");
      });
    return () => {
      active = false;
    };
  }, []);

  async function runAudit() {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const result = await invoke<SeoAuditReport>("run_seo_audit", {
        siteUrl,
        ...auditRanges(range),
        searchType,
        minImpressions,
        inspectLimit,
      });
      if (id !== requestId.current) return;
      setReport(result);
    } catch (reason) {
      if (id !== requestId.current) return;
      setReport(undefined);
      setError(String(reason));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  async function runTechnicalAudit() {
    const target = techUrl.trim();
    if (!target) {
      setTechError("Enter a page URL to check.");
      return;
    }
    if (techSource === "lighthouse" && !techEnvironment?.localAvailable) {
      setTechError("Local Lighthouse is unavailable. Use PageSpeed Insights instead.");
      return;
    }
    const id = ++techRequestId.current;
    setTechLoading(true);
    setTechError("");
    try {
      const command = techSource === "lighthouse" ? "run_lighthouse" : "run_pagespeed";
      const result = await invoke<LighthouseReport>(command, {
        url: target,
        strategy: "mobile",
        force: false,
      });
      if (id !== techRequestId.current) return;
      setTechReport(result);
    } catch (reason) {
      if (id !== techRequestId.current) return;
      setTechReport(undefined);
      setTechError(String(reason));
    } finally {
      if (id === techRequestId.current) setTechLoading(false);
    }
  }

  const failures = report?.checks.filter((check) => check.status === "fail").length ?? 0;
  const warnings = report?.checks.filter((check) => check.status === "warn").length ?? 0;
  const passes = report?.checks.filter((check) => check.status === "pass").length ?? 0;
  const opportunities = report?.checks.filter((check) => check.status === "info").length ?? 0;
  const summaryStatus = failures > 0 ? "fail" : warnings > 0 ? "warn" : "pass";

  const problemItems = report?.indexing.items.filter((item) => item.issue) ?? [];
  const healthyItems = (report?.indexing.items.length ?? 0) - problemItems.length;

  const seoCategory = techReport?.categories.find((category) => category.id === "seo");
  const seoScore = typeof seoCategory?.score === "number" ? Math.round(seoCategory.score * 100) : undefined;
  const seoAudits = techReport?.audits.filter((audit) => audit.category === "seo") ?? [];
  const seoPassed = techReport?.passed.filter((audit) => audit.category === "seo") ?? [];

  return (
    <>
      <div className="page-title">
        <h1>SEO audit</h1>
        {report && !loading && <button className="seo-rerun" onClick={() => void runAudit()}>↻　RE-RUN AUDIT</button>}
      </div>
      <div className="seo-content">
        <section className="card seo-runner">
          <div className="seo-runner-top">
            <div>
              <span>Site-wide audit</span>
              <h2>Check your organic search health</h2>
            </div>
          </div>
          <p>
            Combines Search Console performance data, sitemap health and Google's indexed version of important pages.
            Nothing is fetched from your website; the audit only uses Google's API data.
          </p>
          <div className="seo-controls">
            <label>
              Date range
              <select value={range} onChange={(event) => setRange(Number(event.target.value))} disabled={loading}>
                <option value={28}>Last 28 days</option>
                <option value={90}>Last 90 days</option>
              </select>
            </label>
            <label>
              Search type
              <select value={searchType} onChange={(event) => setSearchType(event.target.value as AuditSearchType)} disabled={loading}>
                {searchTypes.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}
              </select>
            </label>
            <label>
              Minimum impressions
              <select value={minImpressions} onChange={(event) => setMinImpressions(Number(event.target.value))} disabled={loading}>
                {[50, 100, 250, 500, 1000].map((value) => <option key={value} value={value}>{formatCompact(value)}</option>)}
              </select>
            </label>
            <label>
              Pages to inspect
              <select value={inspectLimit} onChange={(event) => setInspectLimit(Number(event.target.value))} disabled={loading}>
                {[10, 25, 50].map((value) => <option key={value} value={value}>{value} pages</option>)}
              </select>
            </label>
            <button className="seo-run" disabled={loading} onClick={() => void runAudit()}>
              {loading ? "Running audit…" : report ? "Re-run audit" : "Run SEO audit"}
            </button>
          </div>
          <small>
            Uses finalized Search Console data, so the comparison ends three days before today. Index checks use the URL Inspection API
            (about 2,000 queries per day per property), and repeated URLs are cached for one hour.
          </small>
        </section>

        {loading ? (
          <div className="seo-loading" aria-busy="true">
            <section className="card seo-loading-note">
              <span className="seo-loader" />
              <div>
                <b>Running SEO audit…</b>
                <p>Collecting performance data, sitemap health and inspecting up to {inspectLimit} pages. This can take a moment.</p>
              </div>
            </section>
            <section className="card skeleton-table">
              <div className="skeleton-heading"><i /><i /></div>
              {[0, 1, 2, 3, 4].map((item) => <div className="skeleton-row" key={item}><i /><i /><i /></div>)}
            </section>
            <section className="card skeleton-table">
              <div className="skeleton-heading"><i /><i /></div>
              {[0, 1, 2, 3, 4].map((item) => <div className="skeleton-row" key={item}><i /><i /><i /></div>)}
            </section>
          </div>
        ) : error ? (
          <div className="error-card">
            <b>The SEO audit couldn't be completed</b>
            <p>{error}</p>
            <button onClick={() => void runAudit()}>Try again</button>
          </div>
        ) : !report ? (
          <section className="card seo-empty">
            <div className="seo-empty-icon"><AppIcon name="insights" /></div>
            <h2>Run your first SEO audit</h2>
            <p>Choose a date range and start the audit. You will get a prioritized view of indexing, sitemap, visibility and content issues.</p>
            <ul>
              <li>Indexing, canonical and robots checks on important pages</li>
              <li>Sitemap errors, warnings and indexed coverage</li>
              <li>CTR gaps against your site's own position benchmarks</li>
              <li>Striking-distance queries and declining pages</li>
              <li>Keyword cannibalization and mobile ranking gaps</li>
              <li>Single-page technical SEO checks with Lighthouse or PageSpeed</li>
            </ul>
          </section>
        ) : (
          <>
            <section className={`card seo-summary ${summaryStatus}`}>
              <div className="seo-summary-icon">{dataSummaryIcon(summaryStatus)}</div>
              <div>
                <span>SEO audit · {searchTypes.find((type) => type.key === report.searchType)?.label ?? report.searchType}</span>
                <h2>
                  {failures > 0
                    ? `${failures} issue${failures === 1 ? "" : "s"} need attention`
                    : warnings > 0
                      ? `${warnings} warning${warnings === 1 ? "" : "s"} to review`
                      : "No major issues found"}
                </h2>
                <p>
                  {passes} checks passed · {warnings} warnings · {failures} failures
                  {opportunities > 0 ? ` · ${opportunities} opportunit${opportunities === 1 ? "y" : "ies"}` : ""}
                </p>
                <small>
                  Data {report.dataStart} to {report.dataEnd} · compared with {report.previousStart} to {report.previousEnd} ·{" "}
                  {report.indexing.inspected} of {report.indexing.sampled} pages inspected · generated {formatGenerated(report.generatedAt)}
                </small>
              </div>
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Audit checks</h2><span>{report.checks.length} checks</span></div>
              <div className="seo-check-grid">
                {report.checks.map((check) => (
                  <div className={`seo-check ${check.status}`} key={check.id}>
                    <span className="seo-check-icon">{statusSymbol(check.status)}</span>
                    <div>
                      <b>{check.title}</b>
                      <p>{check.description}</p>
                    </div>
                    {check.count > 0 && <em>{check.count}</em>}
                  </div>
                ))}
              </div>
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Search visibility</h2><span>Current vs previous period</span></div>
              <div className="seo-metric-grid">
                <MetricTile label="Clicks" value={formatCompact(report.overview.current.clicks)} change={report.overview.clicksChange} />
                <MetricTile label="Impressions" value={formatCompact(report.overview.current.impressions)} change={report.overview.impressionsChange} />
                <MetricTile label="CTR" value={formatPercent(report.overview.current.ctr)} change={report.overview.ctrChange} suffix=" pp" />
                <MetricTile
                  label="Average position"
                  value={formatPosition(report.overview.current.position)}
                  change={report.overview.positionChange}
                  suffix=""
                  goodWhenPositive={false}
                />
              </div>
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Search appearance</h2><span>How results were shown</span></div>
              {report.searchAppearance.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead><tr><th>Appearance</th><th>Clicks</th><th>Impressions</th><th>CTR</th><th>Average position</th></tr></thead>
                    <tbody>
                      {report.searchAppearance.map((row) => (
                        <tr key={row.appearance}>
                          <td className="strong">{appearanceLabel(row.appearance)}</td>
                          <td>{formatCompact(row.clicks)}</td>
                          <td>{formatCompact(row.impressions)}</td>
                          <td>{formatPercent(row.ctr)}</td>
                          <td>{formatPosition(row.position)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="seo-empty-row">No search appearance data was returned for this period.</p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading">
                <h2>Indexing & crawl</h2>
                <span>Google's indexed version</span>
              </div>
              <div className="seo-stat-row">
                <Stat label="Sampled" value={report.indexing.sampled} />
                <Stat label="Inspected" value={report.indexing.inspected} />
                <Stat label="Indexed" value={report.indexing.indexed} tone={report.indexing.indexed > 0 ? "good" : ""} />
                <Stat label="Not indexed" value={report.indexing.notIndexed} tone={report.indexing.notIndexed > 0 ? "bad" : ""} />
                <Stat label="Canonical mismatch" value={report.indexing.canonicalMismatches} tone={report.indexing.canonicalMismatches > 0 ? "warn" : ""} />
                <Stat label="Robots blocked" value={report.indexing.robotsBlocked} tone={report.indexing.robotsBlocked > 0 ? "bad" : ""} />
              </div>
              {report.indexing.inspected === 0 ? (
                <p className="seo-empty-row">No pages could be inspected. Check the error below and try again.</p>
              ) : problemItems.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead>
                      <tr><th>Page</th><th>Coverage</th><th>Last crawl</th><th>Issue</th></tr>
                    </thead>
                    <tbody>
                      {problemItems.map((item) => (
                        <tr key={item.url}>
                          <td className="url strong" title={indexingDetails(item)}>{item.url}</td>
                          <td><span className={`seo-badge ${item.verdict === "PASS" ? "good" : "bad"}`}>{item.verdict === "PASS" ? "Indexed" : item.coverageState}</span></td>
                          <td className="muted">{formatDate(item.lastCrawlTime)}</td>
                          <td>{item.issue}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="seo-empty-row">All inspected pages are indexed without canonical, robots or fetch issues.</p>
              )}
              {healthyItems > 0 && problemItems.length > 0 && (
                <p className="seo-muted-note">{healthyItems} inspected page{healthyItems === 1 ? "" : "s"} had no issues.</p>
              )}
              {report.indexing.failed > 0 && (
                <div className="seo-inline-error">
                  {report.indexing.failed} page inspection{report.indexing.failed === 1 ? "" : "s"} failed.
                  {report.indexing.errors.length > 0 && <span> {report.indexing.errors[0]}</span>}
                </div>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Sitemaps</h2><span>{report.sitemaps.total} submitted</span></div>
              <div className="seo-stat-row">
                <Stat label="Errors" value={report.sitemaps.errors} tone={report.sitemaps.errors > 0 ? "bad" : ""} />
                <Stat label="Warnings" value={report.sitemaps.warnings} tone={report.sitemaps.warnings > 0 ? "warn" : ""} />
                <Stat label="Pending" value={report.sitemaps.pending} tone={report.sitemaps.pending > 0 ? "warn" : ""} />
                <Stat label="Stale" value={report.sitemaps.stale} tone={report.sitemaps.stale > 0 ? "warn" : ""} />
                <Stat label="Submitted URLs" value={formatCompact(report.sitemaps.submittedUrls)} />
                <Stat label="Indexed URLs" value={formatCompact(report.sitemaps.indexedUrls)} />
              </div>
              {report.sitemaps.issues.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead><tr><th>Sitemap</th><th>Issue</th><th>Severity</th></tr></thead>
                    <tbody>
                      {report.sitemaps.issues.map((issue) => (
                        <tr key={`${issue.path}-${issue.issue}`}>
                          <td className="url strong" title={issue.path}>{issue.path}</td>
                          <td>{issue.issue}</td>
                          <td><span className={`seo-badge ${issue.severity}`}>{issue.severity}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="seo-empty-row">No sitemap errors, warnings, pending submissions or stale downloads were found.</p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>CTR opportunities</h2><span>Benchmarked against your site</span></div>
              {report.ctrOpportunities.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead>
                      <tr><th>Type</th><th>Query or page</th><th>Position</th><th>Impressions</th><th>CTR</th><th>Site average</th><th>Missed clicks</th></tr>
                    </thead>
                    <tbody>
                      {report.ctrOpportunities.map((item) => (
                        <tr key={`${item.kind}-${item.key}`}>
                          <td><span className="seo-badge info">{item.kind}</span></td>
                          <td className="url strong" title={item.key}>{item.key}</td>
                          <td>{formatPosition(item.position)}</td>
                          <td>{formatCompact(item.impressions)}</td>
                          <td>{formatPercent(item.ctr)}</td>
                          <td className="muted">{formatPercent(item.benchmarkCtr)}</td>
                          <td className="strong">{formatCompact(item.missedClicks)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="seo-empty-row">No large CTR gaps were found for results on the first page.</p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Striking distance</h2><span>Positions 5–20</span></div>
              {report.strikingDistance.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead><tr><th>Query</th><th>Position</th><th>Impressions</th><th>Clicks</th><th>CTR</th></tr></thead>
                    <tbody>
                      {report.strikingDistance.map((item) => (
                        <tr key={item.query}>
                          <td className="strong">{item.query}</td>
                          <td>{formatPosition(item.position)}</td>
                          <td>{formatCompact(item.impressions)}</td>
                          <td>{formatCompact(item.clicks)}</td>
                          <td>{formatPercent(item.ctr)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="seo-empty-row">No queries above the volume threshold rank between positions 5 and 20.</p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Declining content</h2><span>Last period vs previous</span></div>
              {report.declining.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead>
                      <tr><th>Type</th><th>Query or page</th><th>Clicks (previous → now)</th><th>Impressions (previous → now)</th><th>Change</th></tr>
                    </thead>
                    <tbody>
                      {report.declining.map((item) => (
                        <tr key={`${item.kind}-${item.key}`}>
                          <td><span className="seo-badge info">{item.kind}</span></td>
                          <td className="url strong" title={item.key}>{item.key}</td>
                          <td>{formatCompact(item.previousClicks)} → {formatCompact(item.clicks)}</td>
                          <td>{formatCompact(item.previousImpressions)} → {formatCompact(item.impressions)}</td>
                          <td>
                            <span className={`seo-change ${changeTone(item.clicksChange)}`}>{changeLabel(item.clicksChange)}</span>
                            <span className={`seo-change ${changeTone(item.impressionsChange)}`}>{changeLabel(item.impressionsChange)} impr.</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="seo-empty-row">No pages or queries lost at least 20% of clicks or impressions.</p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Keyword cannibalization</h2><span>Same query, multiple pages</span></div>
              {report.cannibalization.length > 0 ? (
                <div className="seo-cannibal-list">
                  {report.cannibalization.map((item) => (
                    <article key={item.query}>
                      <div>
                        <b>{item.query}</b>
                        <span>{formatCompact(item.impressions)} impressions</span>
                      </div>
                      <ul>
                        {item.pages.map((page) => (
                          <li key={page.page}>
                            <span title={page.page}>{page.page}</span>
                            <em>#{formatPosition(page.position)} · {formatCompact(page.clicks)} clicks</em>
                          </li>
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="seo-empty-row">No queries with multiple competing pages were found.</p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Mobile vs desktop rankings</h2><span>Same page, same period</span></div>
              {report.deviceGap.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead><tr><th>Page</th><th>Mobile position</th><th>Desktop position</th><th>Gap</th><th>Mobile impressions</th></tr></thead>
                    <tbody>
                      {report.deviceGap.map((item) => (
                        <tr key={item.page}>
                          <td className="url strong" title={item.page}>{item.page}</td>
                          <td>{formatPosition(item.mobilePosition)}</td>
                          <td>{formatPosition(item.desktopPosition)}</td>
                          <td><span className="seo-badge warning">+{item.gap.toFixed(1)}</span></td>
                          <td>{formatCompact(item.mobileImpressions)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="seo-empty-row">Mobile and desktop positions are broadly aligned for pages above the volume threshold.</p>
              )}
            </section>

            <section className="card seo-panel seo-tech">
              <div className="seo-panel-heading">
                <h2>Technical SEO</h2>
                <span>Single-page lab check</span>
              </div>
              <p className="seo-tech-intro">
                Checks title, meta description, canonical, crawlable links, hreflang, image alt text and structured data for one page.
                This is not a site-wide crawl. Lighthouse runs locally, while PageSpeed Insights runs on Google's servers.
              </p>
              <div className="seo-tech-controls">
                <input
                  value={techUrl}
                  spellCheck={false}
                  placeholder="https://example.com/"
                  disabled={techLoading}
                  onChange={(event) => {
                    setTechUrl(event.target.value);
                    setTechReport(undefined);
                    setTechError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !techLoading) void runTechnicalAudit();
                  }}
                />
                <div className="seo-tech-source" role="group" aria-label="Technical audit source">
                  <button
                    className={techSource === "lighthouse" ? "selected" : ""}
                    disabled={!techEnvironment?.localAvailable || techLoading}
                    title={!techEnvironment?.localAvailable ? "Node.js and Chrome or Edge are required" : ""}
                    onClick={() => {
                      setTechSource("lighthouse");
                      setTechReport(undefined);
                      setTechError("");
                    }}
                  >
                    Lighthouse
                  </button>
                  <button
                    className={techSource === "pagespeed" ? "selected" : ""}
                    disabled={techLoading}
                    onClick={() => {
                      setTechSource("pagespeed");
                      setTechReport(undefined);
                      setTechError("");
                    }}
                  >
                    PageSpeed
                  </button>
                </div>
                <button className="seo-run" disabled={techLoading || !techUrl.trim()} onClick={() => void runTechnicalAudit()}>
                  {techLoading ? "Checking…" : techReport ? "Re-run check" : "Run technical check"}
                </button>
              </div>
              {techEnvironment && !techEnvironment.localAvailable && (
                <p className="seo-tech-note">
                  Local Lighthouse is unavailable. PageSpeed Insights will be used without a local Node.js or browser installation.
                </p>
              )}
              {techError && <div className="seo-inline-error">{techError}</div>}
              {techLoading && <p className="seo-tech-note">Running the technical audit. A Lighthouse run can take up to a minute.</p>}
              {techReport && !techLoading && (
                <>
                  <div className="seo-tech-summary">
                    <div className={`seo-score ${seoScore === undefined ? "" : scoreTone(seoScore)}`}>{seoScore ?? "—"}</div>
                    <div>
                      <b>SEO score</b>
                      <p>{seoAudits.length} failing audit{seoAudits.length === 1 ? "" : "s"} · {seoPassed.length} passed · {techReport.strategy} lab run</p>
                    </div>
                  </div>
                  {seoAudits.length > 0 ? (
                    <div className="seo-table-wrap seo-tech-table">
                      <table className="seo-table">
                        <thead><tr><th>Audit</th><th>Result</th><th>What to fix</th></tr></thead>
                        <tbody>
                          {seoAudits.map((audit) => (
                            <tr key={audit.id}>
                              <td className="strong">{audit.title}</td>
                              <td>{audit.displayValue || "Failed"}</td>
                              <td><p>{audit.description}</p></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="seo-empty-row">No failing SEO audits were reported for this page.</p>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}

function dataSummaryIcon(status: string) {
  if (status === "pass") return "✓";
  if (status === "warn") return "!";
  return "!";
}

function indexingDetails(item: IndexingItem) {
  return [
    item.userCanonical ? `User canonical: ${item.userCanonical}` : "",
    item.googleCanonical ? `Google canonical: ${item.googleCanonical}` : "",
    item.crawledAs ? `Crawled as: ${item.crawledAs}` : "",
    item.sitemapCount > 0 ? `${item.sitemapCount} referring sitemap(s)` : "",
  ].filter(Boolean).join("\n");
}
