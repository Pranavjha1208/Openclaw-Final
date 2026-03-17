/**
 * Build QuickChart image URLs for embedding charts without client-side Chart.js.
 * @see https://quickchart.io/documentation/
 * @see https://github.com/typpo/quickchart
 */
export const QUICKCHART_CHART_BASE = "https://quickchart.io/chart";

export type QuickChartUrlOptions = {
  width?: number;
  height?: number;
  devicePixelRatio?: number;
  backgroundColor?: string;
  /** Chart.js major version; QuickChart defaults to 2, v4 recommended for modern config */
  version?: string;
};

/**
 * Returns a URL that renders the given Chart.js config as a PNG (default) image.
 * Safe for <img src="...">; config must be JSON-serializable (no functions).
 */
export function buildQuickChartImageUrl(
  chart: Record<string, unknown>,
  options: QuickChartUrlOptions = {},
): string {
  const params = new URLSearchParams();
  params.set("chart", JSON.stringify(chart));
  if (options.width != null) {
    params.set("width", String(options.width));
  }
  if (options.height != null) {
    params.set("height", String(options.height));
  }
  if (options.devicePixelRatio != null) {
    params.set("devicePixelRatio", String(options.devicePixelRatio));
  }
  if (options.backgroundColor != null) {
    params.set("backgroundColor", options.backgroundColor);
  }
  if (options.version != null) {
    params.set("version", options.version);
  }
  return `${QUICKCHART_CHART_BASE}?${params.toString()}`;
}

/** Palette aligned with usage CSS (--output / input / cache segments). */
export const QUICKCHART_USAGE_COLORS = {
  output: "rgba(198, 40, 40, 0.85)",
  input: "rgba(21, 101, 192, 0.85)",
  cacheWrite: "rgba(106, 27, 154, 0.85)",
  cacheRead: "rgba(46, 125, 50, 0.85)",
  total: "rgba(100, 149, 237, 0.9)",
} as const;

/** Default segment colors for pie/bar charts (agent chart-json). */
const CHART_JSON_PALETTE = [
  "rgba(100, 149, 237, 0.9)",
  "rgba(198, 40, 40, 0.85)",
  "rgba(21, 101, 192, 0.85)",
  "rgba(46, 125, 50, 0.85)",
  "rgba(106, 27, 154, 0.85)",
  "rgba(255, 165, 0, 0.85)",
  "rgba(60, 179, 113, 0.85)",
  "rgba(148, 0, 211, 0.85)",
];

/**
 * Agent chart-json spec (from fenced ```chart-json block).
 * type, title optional; data.labels and data.datasets required.
 */
type ChartJsonSpec = {
  type?: "bar" | "line" | "pie";
  title?: string;
  data?: {
    labels?: string[];
    datasets?: Array<{ label?: string; data?: number[] }>;
  };
};

function parseChartJsonSpec(raw: unknown): ChartJsonSpec | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const data = o.data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.labels) || !Array.isArray(d.datasets)) return null;
  return raw as ChartJsonSpec;
}

/**
 * Converts agent chart-json spec to a Chart.js config for QuickChart.
 */
function chartJsonSpecToChartJsConfig(spec: ChartJsonSpec): Record<string, unknown> {
  const type = spec.type === "pie" || spec.type === "line" ? spec.type : "bar";
  const labels = spec.data?.labels ?? [];
  const datasets = spec.data?.datasets ?? [];
  const title = typeof spec.title === "string" ? spec.title : "Chart";

  const datasetsWithColors = datasets.map((ds, i) => {
    const data = Array.isArray(ds.data) ? ds.data : [];
    const label = typeof ds.label === "string" ? ds.label : "Series";
    if (type === "pie" && data.length > 0) {
      return {
        label,
        data,
        backgroundColor: CHART_JSON_PALETTE.slice(0, data.length),
      };
    }
    return {
      label,
      data,
      backgroundColor: CHART_JSON_PALETTE[i % CHART_JSON_PALETTE.length],
    };
  });

  const config: Record<string, unknown> = {
    type,
    data: { labels, datasets: datasetsWithColors },
    options: {
      plugins: {
        title: { display: true, text: title },
      },
      scales:
        type !== "pie"
          ? { x: { stacked: type === "bar" && datasets.length > 1 }, y: { beginAtZero: true, stacked: type === "bar" && datasets.length > 1 } }
          : undefined,
    },
  };
  return config;
}

/**
 * Builds a QuickChart image URL from an agent chart-json spec (object).
 * Returns null if the spec is invalid.
 */
export function buildQuickChartUrlFromChartJsonSpec(spec: unknown): string | null {
  const parsed = parseChartJsonSpec(spec);
  if (!parsed) return null;
  const config = chartJsonSpecToChartJsConfig(parsed);
  return buildQuickChartImageUrl(config, {
    width: 500,
    height: 300,
    devicePixelRatio: 2,
    version: "4",
    backgroundColor: "transparent",
  });
}
