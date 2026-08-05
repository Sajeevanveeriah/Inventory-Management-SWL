import { useId } from 'react';

/**
 * Deterministic SVG charts, no chart library needed. Colours are CSS custom
 * properties (validated for light and dark surfaces and for colour-vision
 * deficiency): --chart-series-1 (blue), --chart-series-2 (orange). Identity is
 * never colour alone: every chart ships a legend, direct series labels and an
 * accessible text summary. Numbers use tabular figures via the .num class.
 */

export interface SeriesPoint {
  x: number;
  y: number;
}
export interface ChartSeries {
  label: string;
  points: SeriesPoint[];
}

const W = 560;
const H = 220;
const PAD = { top: 16, right: 96, bottom: 28, left: 56 };

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const span = max - min;
  const step = 10 ** Math.floor(Math.log10(span / count));
  const err = span / count / step;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const s = step * mult;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / s) * s; v <= max; v += s) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

/** Time series line chart: up to two series, direct-labelled, single y axis. */
export function LineChart({
  series,
  title,
  formatY,
  formatX,
}: {
  series: ChartSeries[];
  title: string;
  formatY: (y: number) => string;
  formatX: (x: number) => string;
}) {
  const titleId = useId();
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return null;
  const xMin = Math.min(...all.map((p) => p.x));
  const xMax = Math.max(...all.map((p) => p.x));
  const yMin = 0;
  const yMax = Math.max(...all.map((p) => p.y)) * 1.08;
  const sx = (x: number) =>
    PAD.left + ((x - xMin) / Math.max(1, xMax - xMin)) * (W - PAD.left - PAD.right);
  const sy = (y: number) =>
    H - PAD.bottom - ((y - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);
  const yTicks = niceTicks(yMin, yMax);
  const xTicks = [xMin, xMin + (xMax - xMin) / 2, xMax];
  const colours = ['var(--chart-series-1)', 'var(--chart-series-2)'];

  return (
    <figure className="chart" role="group" aria-labelledby={titleId}>
      <figcaption id={titleId}>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chartSummary(series, formatY)}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)} className="chart-grid" />
            <text x={PAD.left - 8} y={sy(t) + 4} textAnchor="end" className="chart-tick num">
              {formatY(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text
            key={t}
            x={sx(t)}
            y={H - PAD.bottom + 18}
            textAnchor="middle"
            className="chart-tick num"
          >
            {formatX(t)}
          </text>
        ))}
        {series.map((s, i) => {
          const sortedPoints = [...s.points].sort((a, b) => a.x - b.x);
          const d = sortedPoints
            .map((p, j) => `${j === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
            .join(' ');
          const last = sortedPoints[sortedPoints.length - 1];
          if (!last) return null;
          return (
            <g key={s.label}>
              <path d={d} fill="none" stroke={colours[i % 2]} strokeWidth={2} />
              {sortedPoints.map((p) => (
                <circle key={p.x} cx={sx(p.x)} cy={sy(p.y)} r={3} fill={colours[i % 2]} />
              ))}
              <text
                x={sx(last.x) + 8}
                y={sy(last.y) + 4}
                className="chart-series-label"
                fill={colours[i % 2]}
              >
                {s.label}
              </text>
            </g>
          );
        })}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          className="chart-axis"
        />
      </svg>
      <ul className="chart-legend">
        {series.map((s, i) => (
          <li key={s.label}>
            <span
              className="legend-swatch"
              style={{ background: colours[i % 2] }}
              aria-hidden="true"
            />
            {s.label}
            {': '}
            <span className="num">
              {s.points.length > 0 ? formatY(s.points[s.points.length - 1]?.y ?? 0) : 'no data'}
            </span>{' '}
            latest
          </li>
        ))}
      </ul>
    </figure>
  );
}

function chartSummary(series: ChartSeries[], formatY: (y: number) => string): string {
  return series
    .map((s) => {
      const first = s.points[0];
      const last = s.points[s.points.length - 1];
      if (!first || !last) return `${s.label}: no data`;
      return `${s.label} moved from ${formatY(first.y)} to ${formatY(last.y)} across ${s.points.length} points`;
    })
    .join('; ');
}

export interface Bucket {
  label: string;
  count: number;
}

/** Distribution bar chart: one hue, direct value labels, baseline-anchored bars. */
export function BarChart({
  buckets,
  title,
  unit,
}: {
  buckets: Bucket[];
  title: string;
  unit: string;
}) {
  const titleId = useId();
  if (buckets.length === 0) return null;
  const max = Math.max(...buckets.map((b) => b.count), 1);
  const innerW = W - PAD.left - PAD.right + 64;
  const barW = Math.min(64, (innerW / buckets.length) * 0.7);
  const step = innerW / buckets.length;
  const sy = (v: number) => H - PAD.bottom - (v / max) * (H - PAD.top - PAD.bottom);
  const summary = buckets.map((b) => `${b.label}: ${b.count} ${unit}`).join('; ');

  return (
    <figure className="chart" role="group" aria-labelledby={titleId}>
      <figcaption id={titleId}>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
        {buckets.map((b, i) => {
          const x = PAD.left + i * step + (step - barW) / 2;
          const y = sy(b.count);
          return (
            <g key={b.label}>
              <path
                d={`M${x},${H - PAD.bottom} L${x},${y + 4} Q${x},${y} ${x + 4},${y} L${x + barW - 4},${y} Q${x + barW},${y} ${x + barW},${y + 4} L${x + barW},${H - PAD.bottom} Z`}
                fill="var(--chart-series-1)"
              />
              <text x={x + barW / 2} y={y - 6} textAnchor="middle" className="chart-tick num">
                {b.count}
              </text>
              <text
                x={x + barW / 2}
                y={H - PAD.bottom + 18}
                textAnchor="middle"
                className="chart-tick"
              >
                {b.label}
              </text>
            </g>
          );
        })}
        <line
          x1={PAD.left}
          x2={W - PAD.right + 64}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          className="chart-axis"
        />
      </svg>
      <p className="chart-note">{unit} per bracket, direct-labelled.</p>
    </figure>
  );
}
