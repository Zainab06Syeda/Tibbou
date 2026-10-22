// Shapes API rows into what the charts draw. Pure functions so they can be
// tested without a browser (test/chartData.test.js). All totals are summed
// client-side from the same rows the tables below each chart show.

export const OTHER_KEY = "other";
const DAY_MS = 24 * 60 * 60 * 1000;

function amount(snapshot) {
  const value = Number(snapshot.cost_amount || 0);
  return Number.isFinite(value) ? value : 0;
}

function datasetName(datasetsById, datasetId) {
  return datasetsById[datasetId]?.name || "Unknown dataset";
}

// Monthly buckets once the history spans more than about two months,
// otherwise daily, so a short history still draws more than one bar.
export function chooseGranularity(dates) {
  const times = dates.map((value) => new Date(value).getTime()).filter(Number.isFinite);
  if (times.length === 0) return "month";
  return Math.max(...times) - Math.min(...times) > 62 * DAY_MS ? "month" : "day";
}

function bucketKey(value, granularity) {
  const iso = new Date(value).toISOString();
  return granularity === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
}

export function bucketLabel(key) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day || 1));
  return date.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    ...(day ? { day: "numeric" } : { year: "numeric" }),
  });
}

function fillBuckets(keys, granularity) {
  if (keys.length === 0) return [];
  const sorted = [...keys].sort();
  const all = [];
  const cursor = new Date(`${sorted[0]}${granularity === "month" ? "-01" : ""}T00:00:00Z`);
  const last = sorted[sorted.length - 1];
  // Guard against a malformed date producing an endless loop.
  for (let i = 0; i < 1000; i += 1) {
    const key = bucketKey(cursor, granularity);
    all.push(key);
    if (key >= last) break;
    if (granularity === "month") cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return all;
}

export function costByDataset(snapshots, datasetsById) {
  const totals = new Map();
  for (const snapshot of snapshots) {
    totals.set(snapshot.dataset_id, (totals.get(snapshot.dataset_id) || 0) + amount(snapshot));
  }
  return [...totals.entries()]
    .map(([datasetId, total]) => ({
      datasetId,
      datasetName: datasetName(datasetsById, datasetId),
      system: datasetsById[datasetId]?.system || "unknown",
      total,
    }))
    .sort((left, right) => right.total - left.total);
}

// One row per period, with the top datasets as their own series and the
// rest summed into "Other", ready for a stacked bar chart. Empty periods
// between the first and last are filled with zeros so gaps are visible.
export function costOverTime(snapshots, datasetsById, topCount = 4) {
  if (snapshots.length === 0) return { granularity: "month", rows: [], series: [] };

  const granularity = chooseGranularity(snapshots.map((snapshot) => snapshot.period_start));
  const ranked = costByDataset(snapshots, datasetsById);
  const top = ranked.slice(0, topCount);
  const topIds = new Set(top.map((item) => item.datasetId));
  const series = top.map((item, index) => ({ key: `d${index}`, datasetId: item.datasetId, label: item.datasetName }));
  if (ranked.length > topCount) series.push({ key: OTHER_KEY, label: "Other datasets" });
  const keyForDataset = Object.fromEntries(series.filter((item) => item.datasetId).map((item) => [item.datasetId, item.key]));

  const byBucket = new Map();
  for (const snapshot of snapshots) {
    const bucket = bucketKey(snapshot.period_start, granularity);
    const row = byBucket.get(bucket) || {};
    const key = topIds.has(snapshot.dataset_id) ? keyForDataset[snapshot.dataset_id] : OTHER_KEY;
    row[key] = (row[key] || 0) + amount(snapshot);
    byBucket.set(bucket, row);
  }

  const rows = fillBuckets([...byBucket.keys()], granularity).map((bucket) => {
    const values = byBucket.get(bucket) || {};
    const row = { bucket, label: bucketLabel(bucket), total: 0 };
    for (const item of series) {
      row[item.key] = values[item.key] || 0;
      row.total += row[item.key];
    }
    return row;
  });

  return { granularity, rows, series };
}

// Groups rows by a label (for example a dataset's dbt project), keeping the
// largest groups and summing the rest into "Other", for a donut chart.
export function topGroups(entries, maxGroups = 5) {
  const totals = new Map();
  for (const { label, value } of entries) {
    totals.set(label, (totals.get(label) || 0) + value);
  }
  const ranked = [...totals.entries()]
    .map(([label, value]) => ({ label, value }))
    .filter((item) => item.value > 0)
    .sort((left, right) => right.value - left.value);
  if (ranked.length <= maxGroups) return ranked;
  const kept = ranked.slice(0, maxGroups - 1);
  const rest = ranked.slice(maxGroups - 1).reduce((sum, item) => sum + item.value, 0);
  return [...kept, { label: "Other", value: rest }];
}

export function projectLabel(dataset) {
  return dataset?.namespace || dataset?.system || "No project";
}

export function costByProject(snapshots, datasetsById) {
  return topGroups(
    snapshots.map((snapshot) => ({ label: projectLabel(datasetsById[snapshot.dataset_id]), value: amount(snapshot) }))
  );
}

export function datasetsByGroup(datasets, labelFor, maxGroups = 5) {
  return topGroups(datasets.map((dataset) => ({ label: labelFor(dataset), value: 1 })), maxGroups);
}

export function creditsByDataset(summaries, limit = 8) {
  return summaries
    .map((row) => ({
      datasetName: row.dataset_name,
      compute: Number(row.total_credits_attributed_compute || 0),
      acceleration: Number(row.total_credits_used_query_acceleration || 0),
      queries: row.attributed_query_count || 0,
    }))
    .map((row) => ({ ...row, total: row.compute + row.acceleration }))
    .filter((row) => row.total > 0 || row.queries > 0)
    .sort((left, right) => right.total - left.total)
    .slice(0, limit);
}

// Running count of tracked datasets by the day (or month) they were added.
export function datasetsOverTime(datasets) {
  const dates = datasets.map((dataset) => dataset.created_at).filter(Boolean);
  if (dates.length === 0) return [];
  const granularity = chooseGranularity(dates);
  const added = new Map();
  for (const value of dates) {
    const bucket = bucketKey(value, granularity);
    added.set(bucket, (added.get(bucket) || 0) + 1);
  }
  let running = 0;
  return fillBuckets([...added.keys()], granularity).map((bucket) => {
    running += added.get(bucket) || 0;
    return { bucket, label: bucketLabel(bucket), added: added.get(bucket) || 0, total: running };
  });
}
