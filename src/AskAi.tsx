import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

interface AiSettings {
  configured: boolean;
  model: string;
  keyHint: string;
}

interface AiModel {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: number;
  completionPrice: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface StreamPayload {
  requestId: string;
  delta: string;
}

const SUGGESTIONS = [
  "Summarize my performance for this period",
  "Which queries have the biggest opportunity?",
  "Which pages lost the most impressions?",
  "What should I fix first?",
];

function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function previousWindow(startDate: string, endDate: string) {
  const length = Math.max(
    1,
    Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1,
  );
  const previousEnd = shiftDate(startDate, -1);
  return { previousStart: shiftDate(previousEnd, -(length - 1)), previousEnd };
}

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function renderInline(value: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  let lastIndex = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) nodes.push(value.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("**")) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < value.length) nodes.push(value.slice(lastIndex));
  return nodes;
}

interface AiMetric {
  label: string;
  value: string;
  detail?: string;
  trend?: "up" | "down" | "neutral";
}

interface AiChartSeries {
  name: string;
  values: number[];
}

interface AiChartData {
  type?: "line" | "bar";
  title?: string;
  labels: string[];
  series: AiChartSeries[];
}

function MetricCards({ value }: { value: unknown }) {
  if (!Array.isArray(value)) return null;
  const metrics = value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      label: String(item.label ?? ""),
      value: String(item.value ?? ""),
      detail: item.detail ? String(item.detail) : undefined,
      trend: ["up", "down", "neutral"].includes(String(item.trend))
        ? (String(item.trend) as AiMetric["trend"])
        : "neutral",
    }))
    .filter((item) => item.label && item.value)
    .slice(0, 6);
  if (!metrics.length) return null;

  return (
    <div className="ai-metric-grid">
      {metrics.map((metric, index) => (
        <article className="ai-metric-card" key={`${metric.label}-${index}`}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
          {metric.detail && <small className={metric.trend}>{metric.detail}</small>}
        </article>
      ))}
    </div>
  );
}

function DataChart({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AiChartData>;
  if (!Array.isArray(candidate.labels) || !Array.isArray(candidate.series)) return null;

  const labels = candidate.labels.map(String).slice(0, 16);
  const series = candidate.series
    .filter(
      (item): item is AiChartSeries =>
        Boolean(item) &&
        typeof item.name === "string" &&
        Array.isArray(item.values),
    )
    .map((item) => ({
      name: item.name,
      values: item.values.slice(0, labels.length).map((number) => Number(number) || 0),
    }))
    .filter((item) => item.values.length)
    .slice(0, 4);
  if (labels.length < 2 || !series.length) return null;

  const width = 900;
  const height = 270;
  const pad = { left: 52, right: 18, top: 24, bottom: 48 };
  const values = series.flatMap((item) => item.values);
  const maximum = Math.max(1, ...values);
  const colors = ["#3c4043", "#1a73e8", "#188038", "#a142f4"];
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const x = (index: number) =>
    pad.left + (index / Math.max(1, labels.length - 1)) * plotWidth;
  const y = (number: number) => pad.top + (1 - number / maximum) * plotHeight;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const isBar = candidate.type === "bar";
  const groupWidth = plotWidth / labels.length;
  const barWidth = Math.max(3, Math.min(24, (groupWidth * 0.72) / series.length));

  return (
    <figure className="ai-chart">
      {candidate.title && <figcaption>{candidate.title}</figcaption>}
      <div className="ai-chart-legend">
        {series.map((item, index) => (
          <span key={item.name}>
            <i style={{ backgroundColor: colors[index] }} />
            {item.name}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={candidate.title || "GSC data chart"}>
        {ticks.map((tick) => {
          const tickY = pad.top + tick * plotHeight;
          const number = maximum * (1 - tick);
          return (
            <g key={tick}>
              <line x1={pad.left} x2={width - pad.right} y1={tickY} y2={tickY} />
              <text x={pad.left - 9} y={tickY + 4} textAnchor="end">
                {number >= 1000 ? `${(number / 1000).toFixed(number >= 10_000 ? 0 : 1)}k` : Math.round(number)}
              </text>
            </g>
          );
        })}

        {isBar
          ? series.flatMap((item, seriesIndex) =>
              item.values.map((number, index) => {
                const barX =
                  pad.left +
                  index * groupWidth +
                  (groupWidth - barWidth * series.length) / 2 +
                  seriesIndex * barWidth;
                return (
                  <rect
                    key={`${item.name}-${index}`}
                    x={barX}
                    y={y(number)}
                    width={barWidth}
                    height={Math.max(0, pad.top + plotHeight - y(number))}
                    rx="2"
                    fill={colors[seriesIndex]}
                  >
                    <title>{`${labels[index]} · ${item.name}: ${number.toLocaleString()}`}</title>
                  </rect>
                );
              }),
            )
          : series.map((item, seriesIndex) => (
              <g className="ai-chart-line" key={item.name}>
                <polyline
                  points={item.values.map((number, index) => `${x(index)},${y(number)}`).join(" ")}
                  stroke={colors[seriesIndex]}
                />
                {item.values.map((number, index) => (
                  <circle key={index} cx={x(index)} cy={y(number)} r="3" fill={colors[seriesIndex]}>
                    <title>{`${labels[index]} · ${item.name}: ${number.toLocaleString()}`}</title>
                  </circle>
                ))}
              </g>
            ))}

        {labels.map((label, index) => {
          const labelX = isBar ? pad.left + index * groupWidth + groupWidth / 2 : x(index);
          const show = labels.length <= 8 || index % Math.ceil(labels.length / 8) === 0 || index === labels.length - 1;
          return show ? (
            <text className="ai-chart-label" key={`${label}-${index}`} x={labelX} y={height - 18} textAnchor="middle">
              {label.length > 13 ? `${label.slice(0, 12)}…` : label}
            </text>
          ) : null;
        })}
      </svg>
    </figure>
  );
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().startsWith("```")) {
      const language = line.trim().slice(3).trim().toLowerCase();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      if (language === "metrics" || language === "chart") {
        try {
          const parsed: unknown = JSON.parse(code.join("\n"));
          const visualization =
            language === "metrics" ? <MetricCards value={parsed} /> : <DataChart value={parsed} />;
          blocks.push(<div className="ai-visual" key={key++}>{visualization}</div>);
          continue;
        } catch {
          // Fall back to a code block if a model returns incomplete JSON.
        }
      }
      blocks.push(
        <pre className="ai-code" key={key++}>
          {code.join("\n")}
        </pre>,
      );
      continue;
    }

    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        const cells = lines[index]
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim());
        if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) rows.push(cells);
        index += 1;
      }
      if (rows.length) {
        const [head, ...body] = rows;
        blocks.push(
          <div className="ai-table-wrap" key={key++}>
            <table>
              <thead>
                <tr>
                  {head.map((cell, cellIndex) => (
                    <th key={cellIndex}>{renderInline(cell, `th${key}-${cellIndex}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{renderInline(cell, `td${key}-${rowIndex}-${cellIndex}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
      }
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push(
        <div className={`ai-h ai-h${heading[1].length}`} key={key++}>
          {renderInline(heading[2], `h${key}`)}
        </div>,
      );
      index += 1;
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*+]\s+(.*)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `ul${key}-${itemIndex}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.*)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ol key={key++}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `ol${key}-${itemIndex}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[index]) &&
      !lines[index].trim().startsWith("|") &&
      !lines[index].trim().startsWith("```") &&
      !/^#{1,4}\s/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={key++}>{renderInline(paragraph.join(" "), `p${key}`)}</p>);
  }

  return <div className="ai-markdown">{blocks}</div>;
}

export default function AskAi({
  siteUrl,
  siteLabel,
  startDate,
  endDate,
}: {
  siteUrl?: string;
  siteLabel?: string;
  startDate: string;
  endDate: string;
}) {
  const storageKey = `gsc-ai-chat:${siteUrl ?? "none"}`;
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const raw = localStorage.getItem(`gsc-ai-chat:${siteUrl ?? "none"}`);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.filter(
            (message: ChatMessage) =>
              message &&
              (message.role === "user" || message.role === "assistant") &&
              typeof message.content === "string" &&
              message.content.trim().length > 0,
          )
        : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<AiSettings>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState<AiModel[]>([]);
  const [keyDraft, setKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("openrouter/auto");
  const [savingKey, setSavingKey] = useState(false);
  const [keyMessage, setKeyMessage] = useState<{ kind: "error" | "success"; text: string }>();
  const logRef = useRef<HTMLDivElement>(null);
  const activeRequest = useRef<string | null>(null);

  const comparison = useMemo(
    () => previousWindow(startDate, endDate),
    [startDate, endDate],
  );

  const refreshSettings = useCallback(async () => {
    try {
      const view = await invoke<AiSettings>("get_ai_settings");
      setSettings(view);
      setModelDraft(view.model);
    } catch {
      setSettings({ configured: false, model: "openrouter/auto", keyHint: "" });
    }
  }, []);

  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<StreamPayload>("ai-stream", (event) => {
      if (event.payload.requestId !== activeRequest.current) return;
      setMessages((current) => {
        const last = current[current.length - 1];
        if (!last || last.role !== "assistant") return current;
        const updated = current.slice();
        updated[updated.length - 1] = { ...last, content: last.content + event.payload.delta };
        return updated;
      });
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (models.length) return;
    void invoke<AiModel[]>("list_ai_models")
      .then(setModels)
      .catch(() => setModels([]));
  }, [models.length]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (sending) return;
    const persistable = messages.filter((message) => message.content.trim()).slice(-40);
    try {
      localStorage.setItem(storageKey, JSON.stringify(persistable));
    } catch {
      /* storage is optional */
    }
  }, [messages, sending, storageKey]);

  const send = async (question?: string) => {
    const text = (question ?? input).trim();
    if (!text || sending) return;
    if (!siteUrl) {
      setError("Select a Search Console property first.");
      return;
    }
    if (!settings?.configured) {
      setSettingsOpen(true);
      setError("Add your OpenRouter API key to start chatting.");
      return;
    }

    const userMessage: ChatMessage = { id: newId(), role: "user", content: text };
    const assistantMessage: ChatMessage = { id: newId(), role: "assistant", content: "" };
    const history = [...messages, userMessage];
    setMessages([...history, assistantMessage]);
    setInput("");
    setError("");
    setKeyMessage(undefined);
    setSending(true);

    const requestId = newId();
    activeRequest.current = requestId;
    try {
      await invoke<string>("ai_chat", {
        requestId,
        siteUrl,
        startDate,
        endDate,
        previousStart: comparison.previousStart,
        previousEnd: comparison.previousEnd,
        model: modelDraft || settings.model || "openrouter/auto",
        messages: history.map(({ role, content }) => ({ role, content })),
      });
    } catch (reason) {
      setError(String(reason));
      setMessages((current) =>
        current.filter((message) => message.id !== assistantMessage.id || message.content.trim()),
      );
    } finally {
      activeRequest.current = null;
      setSending(false);
    }
  };

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key) return;
    setSavingKey(true);
    setKeyMessage(undefined);
    try {
      const view = await invoke<AiSettings>("save_ai_key", {
        key,
        model: modelDraft.trim() || undefined,
      });
      setSettings(view);
      setModelDraft(view.model);
      setKeyDraft("");
      setSettingsOpen(false);
      setKeyMessage({ kind: "success", text: "OpenRouter key saved securely." });
      setError("");
    } catch (reason) {
      setKeyMessage({ kind: "error", text: String(reason) });
    } finally {
      setSavingKey(false);
    }
  };

  const uploadEnv = async () => {
    setKeyMessage(undefined);
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: "Select your .env file with OPENROUTER_API_KEY",
      });
      if (!selected) return;
      setSavingKey(true);
      const view = await invoke<AiSettings>("import_ai_key_file", {
        path: selected,
        model: modelDraft.trim() || undefined,
      });
      setSettings(view);
      setModelDraft(view.model);
      setSettingsOpen(false);
      setKeyMessage({ kind: "success", text: "OpenRouter key imported from your env file." });
      setError("");
    } catch (reason) {
      setKeyMessage({ kind: "error", text: String(reason) });
    } finally {
      setSavingKey(false);
    }
  };

  const applyModel = async () => {
    const model = modelDraft.trim();
    if (!model || model === settings?.model) return;
    setKeyMessage(undefined);
    try {
      const view = await invoke<AiSettings>("set_ai_model", { model });
      setSettings(view);
      setModelDraft(view.model);
      setKeyMessage({ kind: "success", text: `Model set to ${view.model}` });
    } catch (reason) {
      setKeyMessage({ kind: "error", text: String(reason) });
    }
  };

  const disconnect = async () => {
    setKeyMessage(undefined);
    try {
      const view = await invoke<AiSettings>("clear_ai_key");
      setSettings(view);
      setKeyDraft("");
      setMessages([]);
      setSettingsOpen(true);
      setKeyMessage({ kind: "success", text: "OpenRouter key removed from this device." });
    } catch (reason) {
      setKeyMessage({ kind: "error", text: String(reason) });
    }
  };

  const modelOptions = models.slice(0, 400);

  const settingsForm = (
    <div className="ai-settings-form">
      <label className="ai-field">
        <span>OpenRouter API key</span>
        <input
          type="password"
          value={keyDraft}
          autoComplete="off"
          spellCheck={false}
          placeholder={settings?.configured ? `Saved key ${settings.keyHint || ""}` : "sk-or-v1-…"}
          onChange={(event) => setKeyDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveKey();
            }
          }}
        />
      </label>

      <div className="ai-setup-actions">
        <button
          type="button"
          className="ai-primary"
          onClick={() => void saveKey()}
          disabled={!keyDraft.trim() || savingKey}
        >
          {savingKey ? "Saving…" : "Save key"}
        </button>
        <button type="button" className="ai-secondary" onClick={() => void uploadEnv()} disabled={savingKey}>
          Upload .env
        </button>
        {settings?.configured && (
          <button type="button" className="ai-link" onClick={() => void disconnect()}>
            Disconnect key
          </button>
        )}
      </div>

      <label className="ai-field">
        <span>Model</span>
        <input
          list="ai-model-options"
          value={modelDraft}
          spellCheck={false}
          onChange={(event) => setModelDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void applyModel();
            }
          }}
        />
        <datalist id="ai-model-options">
          {modelOptions.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </datalist>
      </label>
      <div className="ai-setup-actions">
        <button
          type="button"
          className="ai-secondary"
          onClick={() => void applyModel()}
          disabled={!modelDraft.trim() || modelDraft.trim() === settings?.model}
        >
          Apply model
        </button>
        <span className="ai-hint-inline">
          {models.length ? `${models.length} OpenRouter models available` : "Using OpenRouter's default routing"}
        </span>
      </div>

      <p className="ai-hint">
        The key is encrypted with Windows DPAPI for your Windows account and is only sent to OpenRouter. You can
        also set <code>OPENROUTER_API_KEY</code> in your environment.
      </p>
      {keyMessage && <div className={`ai-note ${keyMessage.kind}`}>{keyMessage.text}</div>}
    </div>
  );

  return (
    <>
      <div className="page-title ai-page-title">
        <h1>Ask AI</h1>
        <div className="ai-page-meta">
          <span className="ai-meta-site">{siteLabel ?? "No property selected"}</span>
          <span className="ai-meta-range">{startDate} → {endDate}</span>
          {settings?.configured && (
            <>
              <button
                type="button"
                onClick={() => {
                  setMessages([]);
                  setError("");
                  setKeyMessage(undefined);
                }}
                disabled={messages.length === 0 && !error}
              >
                New chat
              </button>
              <button
                type="button"
                className={settingsOpen ? "active" : ""}
                onClick={() => setSettingsOpen((open) => !open)}
              >
                {settingsOpen ? "Close settings" : "Settings"}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="ai-page">
        {!settings ? (
          <section className="card ai-connect">
            <p className="ai-setup-lead">Loading AI settings…</p>
          </section>
        ) : !settings.configured ? (
          <div className="ai-connect-wrap">
            <section className="card ai-connect">
              <div className="ai-connect-head">
                <div>
                  <h2>Connect OpenRouter</h2>
                  <p>
                    Add your OpenRouter API key once. It stays encrypted on this device, and the assistant only
                    receives Search Console data for this property.
                  </p>
                </div>
              </div>
              {settingsForm}
            </section>
          </div>
        ) : (
          <section className="card ai-chat-page">
            {settingsOpen ? (
              <div className="ai-settings-panel">
                <div className="ai-settings-heading">
                  <h3>OpenRouter settings</h3>
                  <button type="button" className="ai-link" onClick={() => setSettingsOpen(false)}>
                    Back to chat
                  </button>
                </div>
                {settingsForm}
              </div>
            ) : (
              <>
                {keyMessage && (
                  <div className={`ai-note ${keyMessage.kind} ai-note-banner`}>{keyMessage.text}</div>
                )}
                <div className="ai-chat-log" ref={logRef}>
                  {messages.length === 0 ? (
                    <div className="ai-welcome">
                      <h2>Ask about your Search Console data</h2>
                      <p>
                        I analyze the live GSC metrics for <b>{siteLabel ?? "this property"}</b> between{" "}
                        {startDate} and {endDate}. Ask about queries, pages, countries, devices, CTR, rankings or
                        sitemaps. Questions outside Search Console and SEO are out of scope.
                      </p>
                      <div className="ai-suggestions">
                        {SUGGESTIONS.map((suggestion) => (
                          <button
                            key={suggestion}
                            type="button"
                            onClick={() => void send(suggestion)}
                            disabled={sending || !siteUrl}
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    messages.map((message) => (
                      <div key={message.id} className={`ai-msg ${message.role}`}>
                        <div className="ai-msg-body">
                          {message.content ? (
                            message.role === "assistant" ? (
                              <Markdown text={message.content} />
                            ) : (
                              <p>{message.content}</p>
                            )
                          ) : (
                            <span className="ai-typing">
                              <i />
                              <i />
                              <i />
                            </span>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {error && <div className="ai-chat-error">{error}</div>}

                <form
                  className="ai-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                >
                  <textarea
                    rows={2}
                    value={input}
                    placeholder={siteUrl ? "Ask about queries, pages, clicks, CTR, rankings…" : "Select a property first"}
                    disabled={!siteUrl}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="ai-composer-row">
                    <span className="ai-scope">Search Console data only</span>
                    <span className="ai-composer-hint">Enter to send · Shift + Enter for a new line</span>
                    <button
                      type="submit"
                      className="ai-send"
                      disabled={!input.trim() || sending || !siteUrl}
                      aria-label="Send question"
                    >
                      {sending ? <span className="ai-send-spinner" /> : "↑"}
                    </button>
                  </div>
                </form>
              </>
            )}
          </section>
        )}
      </div>
    </>
  );
}
