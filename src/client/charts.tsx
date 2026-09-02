import { useEffect, useRef, useState } from "react";
import type { ReportBucket } from "../shared/domain.js";
import {
  formatDate,
  formatMoney,
  isNegativeMoney,
  isPositiveMoney,
  moneyExtent,
  moneyFromUnits,
  moneyScalePercent,
  moneyUnits,
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
  bucket: ReportBucket;
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
  return count <= 1 ? VIEW.width / 2 : PADDING + (index / (count - 1)) * plot;
};

/**
 * The values to put gridlines and labels at, as exact decimal money.
 *
 * Round numbers rather than four equal slices of the range: an axis reading
 * 1,247.83 / 2,495.66 / 3,743.49 is arithmetically honest and tells nobody
 * anything. So the step is rounded out to one, two or five times a power of ten,
 * which is what makes an axis scannable.
 *
 * All of it in scaled BigInt, like every other sum here. A step worked out in
 * floating point would land ticks a hair off the round numbers they are printed
 * as, and the gridline would sit visibly beside its own label.
 */
const NICE_MULTIPLES = [1n, 2n, 5n, 10n];

export function niceTicks(low: string, high: string, count = 4): string[] {
  const lowUnits = moneyUnits(low);
  const highUnits = moneyUnits(high);
  if (lowUnits === null || highUnits === null) return [];
  // A flat series. One line, at the value it holds, rather than an axis that
  // implies a range it does not have.
  if (highUnits === lowUnits) return [moneyFromUnits(lowUnits)];

  const span = highUnits - lowUnits;
  const rough = span / BigInt(count);
  if (rough <= 0n) return [moneyFromUnits(lowUnits), moneyFromUnits(highUnits)];
  // floor(log10(rough)) by digit count, which is exact for a positive BigInt
  // and needs no logarithm.
  const magnitude = 10n ** BigInt(rough.toString().length - 1);
  // The candidate closest to the ideal step, not the first one above it.
  // Rounding up always overshoots — a range of 4,991 wants a step of 1,000 and
  // rounding up gives 2,000, which is three gridlines for a chart that asked
  // for five. Compared as `|span - count * candidate|`, which is the same
  // ordering as `|span / count - candidate|` and needs no division.
  const distance = (candidate: bigint) => {
    const difference = span - BigInt(count) * candidate;
    return difference < 0n ? -difference : difference;
  };
  const step = NICE_MULTIPLES.map((multiple) => multiple * magnitude).reduce((best, candidate) =>
    distance(candidate) < distance(best) ? candidate : best,
  );

  // The first multiple of the step at or above the low bound. Because every
  // tick is a multiple of the step, zero is one of them whenever zero is in
  // range, which is the line a chart of money most needs.
  const offset = ((lowUnits % step) + step) % step;
  const ticks: string[] = [];
  for (
    let tick = offset === 0n ? lowUnits : lowUnits + (step - offset);
    tick <= highUnits;
    tick += step
  ) {
    ticks.push(moneyFromUnits(tick));
  }
  return ticks.length >= 2 ? ticks : [moneyFromUnits(lowUnits), moneyFromUnits(highUnits)];
}

/**
 * Which buckets get a label under them.
 *
 * A report may have up to six hundred columns, and six hundred dates under a
 * chart is a grey smear. Thinned by a fixed stride rather than by spreading a
 * fixed number of labels across the range: spreading twelve months over seven
 * slots rounded to 0, 1, 2, 4, 5, 6, 7 and skipped April on its own, which
 * reads as a chart missing a month rather than as an axis showing every other
 * one. A stride is even by construction.
 */
const MAX_TIME_LABELS = 12;

export function labelledBuckets(count: number, budget = MAX_TIME_LABELS): number[] {
  if (count <= 0) return [];
  const stride = Math.ceil(count / Math.max(budget, 1));
  const labelled: number[] = [];
  for (let index = 0; index < count; index += stride) labelled.push(index);
  return labelled;
}

/**
 * How many dates will fit under a chart this wide.
 *
 * Twelve reads well across a panel and is a grey smear across a phone, so the
 * budget comes from the width rather than from a constant. Roughly the room one
 * label needs with a gap either side; two is the floor, because an axis naming
 * one date says less than no axis at all.
 */
const MIN_LABEL_WIDTH = 84;

export function labelBudget(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return MAX_TIME_LABELS;
  return Math.max(2, Math.min(MAX_TIME_LABELS, Math.floor(width / MIN_LABEL_WIDTH)));
}

/**
 * The measured width of the drawing, for deciding that budget.
 *
 * Measured rather than guessed at from a media query, because what matters is
 * the panel the chart landed in and not the viewport: the same chart is wide on
 * a report page and narrow inside a phone's card, at the same breakpoint. Falls
 * back to the full budget where there is nothing to measure with, which is how
 * it behaves under jsdom.
 */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured !== undefined) setWidth(measured);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/**
 * How to write a bucket's date under the chart.
 *
 * Short enough that a year of months fits without collapsing to every other
 * one: the column header in the table beside it carries the full date, so the
 * axis only has to say which period this is. A quarter is named as one rather
 * than by the day it starts, which is a date nobody picked.
 */
export function bucketLabel(start: string, bucket: ReportBucket): string {
  const [year, month] = start.split("-");
  if (bucket === "year") return year ?? start;
  if (bucket === "quarter") {
    const quarter = Math.floor((Number(month) - 1) / 3) + 1;
    return Number.isFinite(quarter) ? `Q${quarter} ${year}` : formatDate(start);
  }
  if (bucket === "month") {
    const named = new Date(`${start.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(named.getTime())) return formatDate(start);
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(named);
  }
  // A week, or an ungrouped range: the day is the thing that identifies it, and
  // the year is already on the caption under the chart.
  const day = new Date(`${start.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return formatDate(start);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(day);
}

/**
 * The plot, with a value axis beside it and a time axis under it.
 *
 * The axis text is HTML rather than SVG `<text>`, which is the whole reason this
 * is laid out with a grid instead of drawn. The viewBox is scaled uniformly to
 * whatever width the panel gives it, so anything inside it scales too: a
 * twelve-unit label reads as twelve pixels on a desktop and four on a phone,
 * which is an axis nobody can read on the device most likely to need it. In HTML
 * the labels keep one size and the grid keeps them lined up with the geometry.
 *
 * The gridlines stay in the SVG, because a line is the one thing that should
 * scale with the drawing.
 */
function ChartFrame({
  title,
  children,
  zeroAt,
  ticks,
  currency,
  timeLabels,
  plotRef,
}: {
  title: string;
  children: React.ReactNode;
  zeroAt: number | null;
  ticks: { value: string; at: number }[];
  currency: string;
  timeLabels: { key: string; text: string; at: number; edge: "start" | "end" | null }[];
  plotRef: React.Ref<HTMLDivElement>;
}) {
  return (
    // Hidden from assistive technology as a whole: read linearly, an axis is a
    // run of bare numbers with nothing to attach them to. The chart carries its
    // own accessible name, and the table beside it holds every figure as text.
    <div className="chart-plot" ref={plotRef}>
      <div className="chart-axis-y" aria-hidden="true">
        {/* An absolutely positioned child contributes nothing to an `auto`
            grid column, so without this the column collapsed to nothing and
            every value hung off the left of the panel. One label in flow,
            hidden, is what reserves exactly the width the widest one needs. */}
        <span className="chart-axis-sizer">
          {ticks.reduce((widest, tick) => {
            const label = formatMoney(tick.value, currency);
            return label.length > widest.length ? label : widest;
          }, "")}
        </span>
        {ticks.map((tick) => (
          <span key={tick.value} className="chart-axis-value" style={{ top: `${tick.at}%` }}>
            {formatMoney(tick.value, currency)}
          </span>
        ))}
      </div>
      <svg
        className="chart"
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        role="img"
        aria-label={title}
      >
        <title>{title}</title>
        {ticks.map((tick) => (
          <line
            key={tick.value}
            className={
              zeroAt !== null && Math.abs(zeroAt - (tick.at / 100) * VIEW.height) < 0.5
                ? "chart-zero"
                : "chart-grid"
            }
            x1={0}
            x2={VIEW.width}
            y1={(tick.at / 100) * VIEW.height}
            y2={(tick.at / 100) * VIEW.height}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* Only when no tick already landed on it, so the zero line is not
            drawn twice at different weights. */}
        {zeroAt !== null &&
        !ticks.some((tick) => Math.abs(zeroAt - (tick.at / 100) * VIEW.height) < 0.5) ? (
          <line
            className="chart-zero"
            x1={0}
            x2={VIEW.width}
            y1={zeroAt}
            y2={zeroAt}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {children}
      </svg>
      <div className="chart-axis-x" aria-hidden="true">
        {timeLabels.map((label) => (
          <span
            key={label.key}
            className={
              label.edge === "start" ? "at-start" : label.edge === "end" ? "at-end" : undefined
            }
            style={
              label.edge === "start"
                ? { left: 0 }
                : label.edge === "end"
                  ? { right: 0 }
                  : { left: `${label.at}%` }
            }
          >
            {label.text}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Where each gridline sits, as a percentage down the drawing's own box. */
const tickPositions = (values: string[], low: string, high: string) =>
  values.map((value) => ({
    value,
    at: (y(value, low, high) / VIEW.height) * 100,
  }));

export function LineChart({ buckets, series, currency, title, bucket }: ChartProps) {
  const plot = useMeasuredWidth();
  const { low, high } = bounds(series);
  const zeroAt = !isPositiveMoney(low) && !isNegativeMoney(high) ? y("0", low, high) : null;
  const ticks = tickPositions(niceTicks(low, high), low, high);
  // A point sits at the centre of its column, so its label goes there too.
  // `edge` marks the labels that really sit at the ends of the axis: pinning
  // "the last label in the list" to the right edge misplaced it by up to a
  // whole stride whenever thinning stopped short of the final bucket.
  const timeLabels = labelledBuckets(buckets.length, labelBudget(plot.width)).map((index) => ({
    key: buckets[index]!.start,
    text: bucketLabel(buckets[index]!.start, bucket),
    at: (columnCentre(index, buckets.length) / VIEW.width) * 100,
    edge: index === 0 ? ("start" as const) : index === buckets.length - 1 ? ("end" as const) : null,
  }));

  return (
    <figure className="chart-figure">
      <ChartFrame
        title={title}
        zeroAt={zeroAt}
        ticks={ticks}
        currency={currency}
        timeLabels={timeLabels}
        plotRef={plot.ref}
      >
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

export function BarChart({ buckets, series, currency, title, bucket }: ChartProps) {
  const plot = useMeasuredWidth();
  const { low, high } = bounds(series);
  const baseline = y("0", low, high);
  const groupWidth = VIEW.width / Math.max(buckets.length, 1);
  const barWidth = (groupWidth * 0.7) / Math.max(series.length, 1);
  const ticks = tickPositions(niceTicks(low, high), low, high);
  // A group of bars fills its own slice of the width rather than sitting on a
  // point, so the label goes under the middle of the slice. `edge` as above:
  // only a label whose bucket really is first or last sits on the frame edge.
  const timeLabels = labelledBuckets(buckets.length, labelBudget(plot.width)).map((index) => ({
    key: buckets[index]!.start,
    text: bucketLabel(buckets[index]!.start, bucket),
    at: ((index * groupWidth + groupWidth / 2) / VIEW.width) * 100,
    edge: index === 0 ? ("start" as const) : index === buckets.length - 1 ? ("end" as const) : null,
  }));

  return (
    <figure className="chart-figure">
      <ChartFrame
        title={title}
        zeroAt={baseline}
        ticks={ticks}
        currency={currency}
        timeLabels={timeLabels}
        plotRef={plot.ref}
      >
        {buckets.map((bucket, position) =>
          series.map((entry, index) => {
            const value = entry.values[position] ?? "0";
            const top = y(value, low, high);
            const height = Math.abs(top - baseline);
            return (
              <rect
                key={`${bucket.start}-${entry.key}`}
                className={`chart-bar ${seriesClass(index)}`}
                x={position * groupWidth + groupWidth * 0.15 + index * barWidth}
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
