/**
 * Server-side conversion of ```chart-json fenced blocks to QuickChart image markdown.
 * Mirrors the client-side logic in ui/src/ui/views/quickchart-url.ts and
 * ui/src/ui/markdown.ts (preprocessChartJsonBlocks).
 */

const QUICKCHART_BASE = "https://quickchart.io/chart";

const PALETTE = [
  "rgba(100, 149, 237, 0.9)",
  "rgba(198, 40, 40, 0.85)",
  "rgba(21, 101, 192, 0.85)",
  "rgba(46, 125, 50, 0.85)",
  "rgba(106, 27, 154, 0.85)",
  "rgba(255, 165, 0, 0.85)",
  "rgba(60, 179, 113, 0.85)",
  "rgba(148, 0, 211, 0.85)",
];

type ChartJsonSpec = {
  type?: "bar" | "line" | "pie";
  title?: string;
  data?: {
    labels?: string[];
    datasets?: Array<{ label?: string; data?: number[] }>;
  };
};

function parseSpec(raw: unknown): ChartJsonSpec | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const data = o.data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.labels) || !Array.isArray(d.datasets)) return null;
  return raw as ChartJsonSpec;
}

function specToChartJsConfig(spec: ChartJsonSpec): Record<string, unknown> {
  const type = spec.type === "pie" || spec.type === "line" ? spec.type : "bar";
  const labels = spec.data?.labels ?? [];
  const datasets = (spec.data?.datasets ?? []).map((ds, i) => {
    const data = Array.isArray(ds.data) ? ds.data : [];
    const label = typeof ds.label === "string" ? ds.label : "Series";
    const backgroundColor =
      type === "pie" && data.length > 0
        ? PALETTE.slice(0, data.length)
        : PALETTE[i % PALETTE.length];
    return { label, data, backgroundColor };
  });
  const title = typeof spec.title === "string" ? spec.title : "Chart";
  return {
    type,
    data: { labels, datasets },
    options: {
      plugins: { title: { display: true, text: title } },
      scales:
        type !== "pie"
          ? {
              x: { stacked: type === "bar" && datasets.length > 1 },
              y: { beginAtZero: true, stacked: type === "bar" && datasets.length > 1 },
            }
          : undefined,
    },
  };
}

function buildUrl(config: Record<string, unknown>): string {
  const params = new URLSearchParams();
  params.set("chart", JSON.stringify(config));
  params.set("width", "500");
  params.set("height", "300");
  params.set("devicePixelRatio", "2");
  params.set("version", "4");
  params.set("backgroundColor", "transparent");
  return `${QUICKCHART_BASE}?${params.toString()}`;
}

/**
 * Replaces ```chart-json fenced blocks in `text` with markdown image links
 * pointing to QuickChart.  Invalid blocks are left untouched.
 */
export function replaceChartJsonBlocks(text: string): string {
  const re = /```chart-json\n([\s\S]*?)```/g;
  return text.replace(re, (_, raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return "```chart-json\n```";
    let spec: unknown;
    try {
      spec = JSON.parse(trimmed) as unknown;
    } catch {
      return "```chart-json\n" + raw + "```";
    }
    const parsed = parseSpec(spec);
    if (!parsed) return "```chart-json\n" + raw + "```";
    const config = specToChartJsConfig(parsed);
    const url = buildUrl(config);
    const title =
      typeof parsed.title === "string" ? parsed.title.replace(/]/g, "\\]") : "Chart";
    return `\n\n[${title}](${url})\n\n`;
  });
}
