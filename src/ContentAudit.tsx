import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppIcon } from "./Icons";

type AuditSearchType = "web" | "image" | "video" | "news";
type Priority = "high" | "medium" | "low";

interface AuditMetricRow {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface ContentOverview {
  current: AuditMetricRow;
  previous: AuditMetricRow;
  clicksChange: number;
  impressionsChange: number;
  ctrChange: number;
  positionChange: number;
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

interface ContentStrikingItem {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
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

interface ContentGapItem {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface ContentGroupRow {
  group: string;
  pages: number;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  issue: string;
}

interface FormatPageRow {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  missedClicks: number;
}

interface FormatAudit {
  format: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  pages: FormatPageRow[];
}

interface TopContentRow {
  page: string;
  clicks: number;
  previousClicks: number;
  clicksChange: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface ContentHealthItem {
  url: string;
  indexed: boolean;
  coverageState: string;
  lastCrawlTime?: string;
  canonicalMismatch: boolean;
  mobileIssues: number;
  richIssues: number;
  issue: string;
}

interface ContentHealth {
  sampled: number;
  inspected: number;
  failed: number;
  items: ContentHealthItem[];
  errors: string[];
}

interface ContentAuditReport {
  generatedAt: number;
  dataStart: string;
  dataEnd: string;
  previousStart: string;
  previousEnd: string;
  searchType: string;
  minImpressions: number;
  inspectLimit: number;
  overview: ContentOverview;
  declining: DecliningItem[];
  ctrOpportunities: CtrOpportunity[];
  strikingDistance: ContentStrikingItem[];
  cannibalization: CannibalizationItem[];
  contentGaps: ContentGapItem[];
  contentGroups: ContentGroupRow[];
  formats: FormatAudit[];
  formatErrors: string[];
  topContent: TopContentRow[];
  health: ContentHealth;
}

interface PriorityItem {
  id: string;
  priority: Priority;
  action: string;
  target: string;
  detail: string;
  impact: number;
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

function buildPriorityQueue(report: ContentAuditReport): PriorityItem[] {
  const items: PriorityItem[] = [];

  for (const item of report.declining) {
    const lost = Math.max(0, item.previousClicks - item.clicks);
    if (lost < 3) continue;
    items.push({
      id: `refresh-${item.key}`,
      priority: item.clicksChange <= -40 ? "high" : "medium",
      action: "Refresh or rewrite",
      target: item.key,
      detail: `Lost ${formatCompact(lost)} clicks (${changeLabel(item.clicksChange)}) versus the previous period.${
        item.previousPosition > 0 && item.position > item.previousPosition
          ? ` Average position slipped from ${formatPosition(item.previousPosition)} to ${formatPosition(item.position)}.`
          : ""
      }`,
      impact: lost,
    });
  }

  for (const item of report.ctrOpportunities) {
    if (item.missedClicks < 10) continue;
    items.push({
      id: `snippet-${item.key}`,
      priority: item.missedClicks >= 50 ? "high" : "medium",
      action: "Rewrite title & meta description",
      target: item.key,
      detail: `CTR is ${formatPercent(item.ctr)} against ${formatPercent(item.benchmarkCtr)} for position ${formatPosition(
        item.position,
      )}. About ${formatCompact(item.missedClicks)} clicks are left on the table.`,
      impact: item.missedClicks,
    });
  }

  for (const item of report.strikingDistance) {
    if (item.impressions < 100) continue;
    items.push({
      id: `improve-${item.query}`,
      priority: "medium",
      action: "Improve content depth & internal links",
      target: item.query,
      detail: `Ranks at ${formatPosition(item.position)} with ${formatCompact(item.impressions)} impressions. Strengthen the page below to reach the top five.`,
      impact: item.impressions / 4,
    });
  }

  for (const item of report.cannibalization) {
    items.push({
      id: `consolidate-${item.query}`,
      priority: "medium",
      action: "Consolidate competing pages",
      target: item.query,
      detail: `${item.pages.length} pages compete for this query (${item.pages
        .slice(0, 2)
        .map((page) => page.page)
        .join(", ")}). Merge or differentiate them.`,
      impact: item.impressions / 6,
    });
  }

  for (const item of report.contentGaps) {
    if (item.impressions < 200) continue;
    items.push({
      id: `create-${item.query}`,
      priority: "low",
      action: "Create or expand content",
      target: item.query,
      detail: `Average position ${formatPosition(item.position)} with ${formatCompact(
        item.impressions,
      )} impressions. The page is not competitive yet.`,
      impact: item.impressions / 10,
    });
  }

  const seen = new Set<string>();
  return items
    .sort((left, right) => right.impact - left.impact)
    .filter((item) => {
      const key = `${item.action}:${item.target.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
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

export default function ContentAudit({ siteUrl }: { siteUrl: string }) {
  const [range, setRange] = useState(28);
  const [searchType, setSearchType] = useState<AuditSearchType>("web");
  const [minImpressions, setMinImpressions] = useState(100);
  const [inspectLimit, setInspectLimit] = useState(10);
  const [report, setReport] = useState<ContentAuditReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    setReport(undefined);
    setError("");
    setLoading(false);
  }, [siteUrl]);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => {
      setProgress((current) => Math.min(97, Math.round(current + 2 + Math.random() * 2)));
    }, 250);
    return () => window.clearInterval(timer);
  }, [loading]);

  async function runAudit() {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const result = await invoke<ContentAuditReport>("run_content_audit", {
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
      if (id === requestId.current) {
        setProgress(100);
        setLoading(false);
      }
    }
  }

  const queue = report ? buildPriorityQueue(report) : [];
  const highPriority = queue.filter((item) => item.priority === "high").length;
  const summaryStatus =
    highPriority > 0
      ? "fail"
      : report &&
          (report.declining.length > 0 ||
            report.ctrOpportunities.length > 0 ||
            report.strikingDistance.length > 0 ||
            report.cannibalization.length > 0 ||
            report.contentGaps.length > 0 ||
            report.health.items.some((item) => item.issue))
        ? "warn"
        : "pass";

  const healthIssues = report?.health.items.filter((item) => item.issue) ?? [];
  const indexedCount = report?.health.items.filter((item) => item.indexed).length ?? 0;
  const activeFormats = report?.formats.filter((format) => format.impressions > 0) ?? [];

  return (
    <>
      <div className="page-title">
        <h1>Content audit</h1>
        {report && !loading && <button className="seo-rerun" onClick={() => void runAudit()}>↻　RE-RUN AUDIT</button>}
      </div>
      <div className="seo-content">
        <section className="card seo-runner">
          <div className="seo-runner-top">
            <div>
              <span>Editorial audit</span>
              <h2>Find content that needs work</h2>
            </div>
          </div>
          <p>
            Focuses on content opportunities instead of technical indexing: pages losing traffic, weak snippets, near-miss
            rankings, competing pages and under-served query topics. Uses Search Console performance data and Google's indexed
            version of important pages.
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
                <option value={0}>Skip inspection</option>
                <option value={10}>10 pages</option>
                <option value={25}>25 pages</option>
              </select>
            </label>
            <button className="seo-run" disabled={loading} onClick={() => void runAudit()}>
              {loading ? "Running audit…" : report ? "Re-run audit" : "Run content audit"}
            </button>
          </div>
          <small>
            Uses finalized Search Console data, so the comparison ends three days before today. The optional inspection sample
            checks indexing, canonical and rich result health for the pages this audit flags (about 2,000 URL Inspection queries
            per day per property). Results are cached for one hour.
          </small>
        </section>

        {loading ? (
          <div className="seo-loading" aria-busy="true">
            <section className="card seo-loading-note">
              <span className="seo-loader" />
              <div className="seo-loading-text">
                <b>Running content audit…</b>
                <p>
                  Comparing content performance with the previous period
                  {inspectLimit > 0 ? ` and inspecting up to ${inspectLimit} pages` : ""}. This can take a moment.
                </p>
                <div className="seo-progress-track" aria-hidden="true">
                  <div className="seo-progress-bar" style={{ width: `${progress}%` }} />
                </div>
                <span className="seo-progress-label">{Math.round(progress)}%</span>
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
            <b>The content audit couldn't be completed</b>
            <p>{error}</p>
            <button onClick={() => void runAudit()}>Try again</button>
          </div>
        ) : !report ? (
          <section className="card seo-empty">
            <div className="seo-empty-icon"><AppIcon name="pages" /></div>
            <h2>Run your first content audit</h2>
            <p>Choose a date range and start the audit. You will get a prioritized editorial to-do list built from real search data.</p>
            <ul>
              <li>Priority queue of content actions</li>
              <li>Pages and queries losing clicks or impressions</li>
              <li>Weak title and description snippets</li>
              <li>Near-miss rankings with the best page to improve</li>
              <li>Competing pages and uncovered query topics</li>
              <li>Section performance, formats and top content</li>
            </ul>
          </section>
        ) : (
          <>
            <section className={`card seo-summary ${summaryStatus}`}>
              <div className="seo-summary-icon">{summaryStatus === "pass" ? "✓" : "!"}</div>
              <div>
                <span>
                  Content audit · {searchTypes.find((type) => type.key === report.searchType)?.label ?? report.searchType}
                </span>
                <h2>
                  {queue.length > 0
                    ? `${queue.length} content action${queue.length === 1 ? "" : "s"} prioritized`
                    : "No pressing content actions found"}
                </h2>
                <p>
                  {highPriority} high priority · {report.declining.length} declining · {report.strikingDistance.length} near-miss
                  queries · {report.contentGaps.length} content gaps
                </p>
                <small>
                  Data {report.dataStart} to {report.dataEnd} · compared with {report.previousStart} to {report.previousEnd} ·{" "}
                  {report.health.inspected} of {report.health.sampled} pages inspected · generated {formatGenerated(report.generatedAt)}
                </small>
              </div>
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Performance</h2><span>Current vs previous period</span></div>
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
              <div className="seo-panel-heading"><h2>Priority queue</h2><span>Ordered by estimated impact</span></div>
              {queue.length > 0 ? (
                <div className="ca-priority-list">
                  {queue.map((item) => (
                    <article className={`ca-priority ${item.priority}`} key={item.id}>
                      <span className="ca-priority-dot" />
                      <div className="ca-priority-body">
                        <div className="ca-priority-head">
                          <b>{item.action}</b>
                          <span className={`seo-badge ${item.priority === "high" ? "error" : item.priority === "medium" ? "warning" : "info"}`}>
                            {item.priority}
                          </span>
                        </div>
                        <p className="ca-priority-target" title={item.target}>{item.target}</p>
                        <p>{item.detail}</p>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="seo-empty-row">No content actions crossed the thresholds for this period.</p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Declining content</h2><span>Lost clicks or impressions</span></div>
              {report.declining.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead>
                      <tr><th>Page</th><th>Position</th><th>Clicks (previous → now)</th><th>Impressions (previous → now)</th><th>Change</th></tr>
                    </thead>
                    <tbody>
                      {report.declining.map((item) => (
                        <tr key={item.key}>
                          <td className="url strong" title={item.key}>{item.key}</td>
                          <td className="muted">{formatPosition(item.previousPosition)} → {formatPosition(item.position)}</td>
                          <td>{formatCompact(item.previousClicks)} → {formatCompact(item.clicks)}</td>
                          <td>{formatCompact(item.previousImpressions)} → {formatCompact(item.impressions)}</td>
                          <td>
                            <span className={`seo-change ${changeTone(item.clicksChange)}`}>{changeLabel(item.clicksChange)} clicks</span>
                            <span className={`seo-change ${changeTone(item.impressionsChange)}`}>{changeLabel(item.impressionsChange)} impr.</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="seo-empty-row">No pages lost at least 20% of clicks or impressions versus the previous period.</p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Title & meta opportunities</h2><span>Low CTR for the ranking position</span></div>
              {report.ctrOpportunities.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead>
                      <tr><th>Page</th><th>Position</th><th>Impressions</th><th>CTR</th><th>Site average</th><th>Missed clicks</th></tr>
                    </thead>
                    <tbody>
                      {report.ctrOpportunities.map((item) => (
                        <tr key={item.key}>
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
                <p className="seo-empty-row">No pages earn significantly less CTR than others ranking in the same position range.</p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Striking distance</h2><span>Best page per query · positions 5–20</span></div>
              {report.strikingDistance.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead><tr><th>Query</th><th>Best page</th><th>Position</th><th>Impressions</th><th>Clicks</th><th>CTR</th></tr></thead>
                    <tbody>
                      {report.strikingDistance.map((item) => (
                        <tr key={item.query}>
                          <td className="strong">{item.query}</td>
                          <td className="url" title={item.page}>{item.page}</td>
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
              <div className="seo-panel-heading"><h2>Competing pages</h2><span>Same query, multiple pages</span></div>
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
              <div className="seo-panel-heading"><h2>Content gaps</h2><span>High impressions, position below 20</span></div>
              {report.contentGaps.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead><tr><th>Query</th><th>Position</th><th>Impressions</th><th>Clicks</th><th>CTR</th></tr></thead>
                    <tbody>
                      {report.contentGaps.map((item) => (
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
                <p className="seo-empty-row">No high-impression queries currently sit outside the top 20.</p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Sections</h2><span>Grouped by first path segment</span></div>
              {report.contentGroups.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead><tr><th>Section</th><th>Pages</th><th>Clicks</th><th>Impressions</th><th>CTR</th><th>Avg. position</th><th>Signal</th></tr></thead>
                    <tbody>
                      {report.contentGroups.map((group) => (
                        <tr key={group.group}>
                          <td className="strong">{group.group}</td>
                          <td>{group.pages}</td>
                          <td>{formatCompact(group.clicks)}</td>
                          <td>{formatCompact(group.impressions)}</td>
                          <td>{formatPercent(group.ctr)}</td>
                          <td>{formatPosition(group.position)}</td>
                          <td>{group.issue ? <span className="seo-badge warning">{group.issue}</span> : <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="seo-empty-row">No page-level data was returned for this period.</p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Search formats</h2><span>Image, video, news and Discover</span></div>
              {activeFormats.length > 0 ? (
                <div className="ca-format-grid">
                  {activeFormats.map((format) => (
                    <article className="ca-format" key={format.format}>
                      <header>
                        <b>{format.format}</b>
                        <span>{formatCompact(format.impressions)} impressions</span>
                      </header>
                      <div className="ca-format-stats">
                        <Stat label="Clicks" value={formatCompact(format.clicks)} />
                        <Stat label="CTR" value={formatPercent(format.ctr)} />
                        <Stat label="Position" value={formatPosition(format.position)} />
                      </div>
                      {format.pages.length > 0 ? (
                        <ul>
                          {format.pages.map((page) => (
                            <li key={page.page}>
                              <span title={page.page}>{page.page}</span>
                              <em>{formatPercent(page.ctr)} · ~{formatCompact(page.missedClicks)} missed</em>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="ca-format-empty">No weak pages for this format.</p>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="seo-empty-row">This property received no image, video, news or Discover impressions in the selected period.</p>
              )}
              {report.formatErrors.length > 0 && (
                <p className="seo-tech-note">
                  Some formats could not be loaded: {report.formatErrors.join(" · ")}
                </p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Top performers</h2><span>Most clicks this period</span></div>
              {report.topContent.length > 0 ? (
                <div className="seo-table-wrap">
                  <table className="seo-table">
                    <thead>
                      <tr><th>Page</th><th>Clicks</th><th>Change</th><th>Impressions</th><th>CTR</th><th>Position</th></tr>
                    </thead>
                    <tbody>
                      {report.topContent.map((item) => (
                        <tr key={item.page}>
                          <td className="url strong" title={item.page}>{item.page}</td>
                          <td>{formatCompact(item.clicks)}</td>
                          <td><span className={`seo-change ${changeTone(item.clicksChange)}`}>{changeLabel(item.clicksChange)}</span></td>
                          <td>{formatCompact(item.impressions)}</td>
                          <td>{formatPercent(item.ctr)}</td>
                          <td>{formatPosition(item.position)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="seo-empty-row">No pages earned clicks in the selected period.</p>
              )}
            </section>

            <section className="card seo-panel">
              <div className="seo-panel-heading"><h2>Content health</h2><span>Indexed version of flagged pages</span></div>
              {report.inspectLimit === 0 ? (
                <p className="seo-empty-row">Page inspection was skipped for this audit.</p>
              ) : report.health.sampled === 0 ? (
                <p className="seo-empty-row">No pages were available to inspect for this period.</p>
              ) : (
                <>
                  <div className="seo-stat-row">
                    <Stat label="Sampled" value={report.health.sampled} />
                    <Stat label="Inspected" value={report.health.inspected} />
                    <Stat label="Indexed" value={indexedCount} tone={indexedCount > 0 ? "good" : ""} />
                    <Stat label="With issues" value={healthIssues.length} tone={healthIssues.length > 0 ? "warn" : ""} />
                    <Stat label="Canonical mismatch" value={healthIssues.filter((item) => item.canonicalMismatch).length} />
                    <Stat label="Inspection failed" value={report.health.failed} tone={report.health.failed > 0 ? "bad" : ""} />
                  </div>
                  {healthIssues.length > 0 ? (
                    <div className="seo-table-wrap">
                      <table className="seo-table">
                        <thead><tr><th>Page</th><th>Indexing</th><th>Last crawl</th><th>Issue</th></tr></thead>
                        <tbody>
                          {healthIssues.map((item) => (
                            <tr key={item.url}>
                              <td className="url strong" title={item.url}>{item.url}</td>
                              <td>
                                <span className={`seo-badge ${item.indexed ? "good" : "bad"}`}>
                                  {item.indexed ? "Indexed" : item.coverageState}
                                </span>
                              </td>
                              <td className="muted">{formatDate(item.lastCrawlTime)}</td>
                              <td>{item.issue}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="seo-empty-row">All inspected pages are indexed without canonical, mobile or rich result issues.</p>
                  )}
                  {report.health.failed > 0 && (
                    <div className="seo-inline-error">
                      {report.health.failed} page inspection{report.health.failed === 1 ? "" : "s"} failed.
                      {report.health.errors.length > 0 && <span> {report.health.errors[0]}</span>}
                    </div>
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
