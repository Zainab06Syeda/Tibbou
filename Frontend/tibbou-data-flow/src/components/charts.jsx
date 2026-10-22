import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Colours come from the --chart-* tokens in index.css so charts follow the
// app theme. The sixth is a neutral used for "Other".
export const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-5))",
  "hsl(var(--chart-2))",
  "hsl(var(--muted-foreground))",
];

const AXIS_TICK = { fill: "hsl(var(--muted-foreground))", fontSize: 12 };
const GRID_STROKE = "hsl(var(--border))";
const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--popover))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "0.75rem",
  color: "hsl(var(--foreground))",
  fontSize: 12,
};
const LEGEND_STYLE = { fontSize: 12, color: "hsl(var(--muted-foreground))" };

export function colorFor(label, index) {
  return label === "Other" || label === "Other datasets" ? CHART_COLORS[5] : CHART_COLORS[index % 5];
}

function truncate(value, length = 18) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

// `responsive` wraps a single Recharts chart so it fills the card; pass
// false for children that lay themselves out (like Donut).
export function ChartCard({ title, description, isEmpty, emptyText, height = 280, responsive = true, children, className = "" }) {
  return (
    <article className={`min-w-0 rounded-2xl border border-border bg-card p-5 ${className}`}>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
      <div
        className={responsive || isEmpty ? "mt-4" : "mt-4 flex items-center"}
        style={responsive || isEmpty ? { height } : { minHeight: height }}
      >
        {isEmpty ? (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border px-6 text-center text-sm text-muted-foreground">
            {emptyText}
          </div>
        ) : responsive ? (
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        ) : (
          children
        )}
      </div>
    </article>
  );
}

// ResponsiveContainer measures the card and passes width/height to its
// child; the chart components below forward them as `size`.

// Vertical stacked bars, one stack per period.
export function StackedBars({ data, series, valueFormatter, xKey = "label", ...size }) {
  return (
    <BarChart {...size} data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
      <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey={xKey} tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={12} />
      <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={valueFormatter} width={64} />
      <Tooltip
        cursor={{ fill: "hsl(var(--secondary) / 0.4)" }}
        contentStyle={TOOLTIP_STYLE}
        formatter={(value, name) => [valueFormatter(value), name]}
      />
      <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={8} />
      {series.map((item, index) => (
        <Bar
          key={item.key}
          dataKey={item.key}
          name={item.label}
          stackId="total"
          fill={colorFor(item.label, index)}
          radius={index === series.length - 1 ? [4, 4, 0, 0] : 0}
          maxBarSize={48}
        />
      ))}
    </BarChart>
  );
}

// Horizontal bars for ranking, with long names truncated on the axis and
// shown in full in the tooltip.
export function RankedBars({ data, bars, labelKey, valueFormatter, stacked = false, ...size }) {
  return (
    <BarChart {...size} data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} accessibilityLayer>
      <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" horizontal={false} />
      <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={valueFormatter} />
      <YAxis
        type="category"
        dataKey={labelKey}
        tick={AXIS_TICK}
        tickLine={false}
        axisLine={false}
        width={128}
        tickFormatter={(value) => truncate(value)}
      />
      <Tooltip
        cursor={{ fill: "hsl(var(--secondary) / 0.4)" }}
        contentStyle={TOOLTIP_STYLE}
        formatter={(value, name) => [valueFormatter(value), name]}
      />
      {bars.length > 1 ? <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={8} /> : null}
      {bars.map((bar, index) => (
        <Bar
          key={bar.key}
          dataKey={bar.key}
          name={bar.label}
          stackId={stacked ? "total" : undefined}
          fill={CHART_COLORS[index]}
          radius={!stacked || index === bars.length - 1 ? [0, 4, 4, 0] : 0}
          maxBarSize={22}
        />
      ))}
    </BarChart>
  );
}

// Donut with the total in the middle and a legend listing each slice's
// value and share. Laid out in HTML so it stacks on narrow screens.
export function Donut({ data, valueFormatter, centerLabel }) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  return (
    <div className="grid w-full items-center gap-4 sm:grid-cols-[180px,minmax(0,1fr)]">
      <div className="relative mx-auto h-[180px] w-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart accessibilityLayer>
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value, name) => [valueFormatter(value), name]} />
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={data.length > 1 ? 2 : 0}
              stroke="hsl(var(--card))"
            >
              {data.map((item, index) => (
                <Cell key={item.label} fill={colorFor(item.label, index)} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold text-foreground">{valueFormatter(total)}</span>
          <span className="text-[11px] text-muted-foreground">{centerLabel}</span>
        </div>
      </div>
      <ul className="min-w-0 space-y-2">
        {data.map((item, index) => (
          <li key={item.label} className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colorFor(item.label, index) }} />
            <span className="min-w-0 flex-1 truncate text-foreground" title={item.label}>{item.label}</span>
            <span className="text-muted-foreground">{valueFormatter(item.value)}</span>
            <span className="w-10 text-right text-muted-foreground">
              {total > 0 ? `${Math.round((item.value / total) * 100)}%` : "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TrendArea({ data, dataKey, name, valueFormatter, color = CHART_COLORS[0], ...size }) {
  const gradientId = `trend-${dataKey}`;
  return (
    <AreaChart {...size} data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={16} />
      <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={valueFormatter} width={64} allowDecimals={false} />
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value) => [valueFormatter(value), name]} />
      <Area
        type="monotone"
        dataKey={dataKey}
        name={name}
        stroke={color}
        strokeWidth={2}
        fill={`url(#${gradientId})`}
        // A line needs two points; show the dots so a short history is still visible.
        dot={data.length < 3 ? { r: 4, fill: color, strokeWidth: 0 } : false}
      />
    </AreaChart>
  );
}
