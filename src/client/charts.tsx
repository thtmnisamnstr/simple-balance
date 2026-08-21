import {
  formatDate,
  formatMoney,
  isNegativeMoney,
  isPositiveMoney,
  moneyExtent,
  moneyScalePercent,
} from "./money.js";

type Series = {
  key: string;
  label: string;
  values: string[];
};

type ChartProps = {
  buckets: { start: string; end: string }[];
  series: Series[];
  currency: string;
  title: string;
};

/**
 * A wide viewBox scaled uniformly, rather than a square one stretched to fit.
 * Stretching scales a stroke by a different factor on each axis, which browsers
 * resolve along the path direction: a near-horizontal line renders many times
 * thicker than a steep one and tapers as it turns, and `non-scaling-stroke`
 * does not rescue it. Scaling uniformly keeps every stroke the same weight and
 * needs no measurement of the container.
 */
const VIEW = { width: 1000, height: 320 };

const bounds = (series: Series[]) => {
  const every = series.flatMap((entry) => entry.values);
  const extent = moneyExtent(every) ?? { low: "0", high: "0" };
  // A flat line at a non-zero value would otherwise plot on the top edge, and a
  // chart of money is easier to read against zero than against its own minimum.
  const low = isPositiveMoney(extent.low) ? "0" : extent.low;
  const high = isNegativeMoney(extent.high) ? "0" : extent.high;
  return { low, high };
};

const PADDING = 8;

/**
 * Which of the stylesheet's series colours this row gets.
 *
 * The count lives here as well as in the stylesheet, so a test asserts the two
 * agree: adding a colour to one and not the other would leave a series either
 * uncoloured or needlessly sharing.
 */
export const SERIES_COLOURS = 10;

const seriesClass = (index: number) => `chart-series-${index % SERIES_COLOURS}`;

const y = (value: string, low: string, high: string) => {
  const plot = VIEW.height - PADDING * 2;
  const fromBottom = (Number(moneyScalePercent(value, low, high)) / 100) * plot;
  return VIEW.height - PADDING - fromBottom;
};

const columnCentre = (index: number, count: number) => {
  const plot = VIEW.width - PADDING * 2;
  return count <= 1
    ? VIEW.width / 2
    : PADDING + (index / (count - 1)) * plot;
};

function ChartFrame({
  title,
  children,
  zeroAt,
}: {
  title: string;
  children: React.ReactNode;
  zeroAt: number | null;
}) {
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      {zeroAt === null ? null : (
        <line
          className="chart-zero"
          x1={0}
          x2={VIEW.width}
          y1={zeroAt}
          y2={zeroAt}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {children}
    </svg>
  );
}

export function LineChart({ buckets, series, currency, title }: ChartProps) {
  const { low, high } = bounds(series);
  const zeroAt =
    !isPositiveMoney(low) && !isNegativeMoney(high) ? y("0", low, high) : null;

  return (
    <figure className="chart-figure">
      <ChartFrame title={title} zeroAt={zeroAt}>
        {series.map((entry, index) => (
          <polyline
            key={entry.key}
            className={`chart-line ${seriesClass(index)}`}
            vectorEffect="non-scaling-stroke"
            points={entry.values
              .map(
                (value, position) =>
                  `${columnCentre(position, buckets.length)},${y(value, low, high)}`,
              )
              .join(" ")}
          />
        ))}
      </ChartFrame>
      <figcaption>
        {formatMoney(low, currency)} to {formatMoney(high, currency)}, from{" "}
        {formatDate(buckets[0]?.start ?? "")} to{" "}
        {formatDate(buckets[buckets.length - 1]?.end ?? "")}
      </figcaption>
    </figure>
  );
}

export function BarChart({ buckets, series, currency, title }: ChartProps) {
  const { low, high } = bounds(series);
  const baseline = y("0", low, high);
  const groupWidth = VIEW.width / Math.max(buckets.length, 1);
  const barWidth = (groupWidth * 0.7) / Math.max(series.length, 1);

  return (
    <figure className="chart-figure">
      <ChartFrame title={title} zeroAt={baseline}>
        {buckets.map((bucket, position) =>
          series.map((entry, index) => {
            const value = entry.values[position] ?? "0";
            const top = y(value, low, high);
            const height = Math.abs(top - baseline);
            return (
              <rect
                key={`${bucket.start}-${entry.key}`}
                className={`chart-bar ${seriesClass(index)}`}
                x={
                  position * groupWidth +
                  groupWidth * 0.15 +
                  index * barWidth
                }
                y={Math.min(top, baseline)}
                width={barWidth}
                height={height < 1 ? 1 : height}
              />
            );
          }),
        )}
      </ChartFrame>
      <figcaption>
        {formatMoney(low, currency)} to {formatMoney(high, currency)}, from{" "}
        {formatDate(buckets[0]?.start ?? "")} to{" "}
        {formatDate(buckets[buckets.length - 1]?.end ?? "")}
      </figcaption>
    </figure>
  );
}

export function ChartLegend({ series }: { series: Series[] }) {
  return (
    <ul className="chart-legend">
      {series.map((entry, index) => (
        <li key={entry.key}>
          <span className={`chart-swatch ${seriesClass(index)}`} aria-hidden="true" />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}
