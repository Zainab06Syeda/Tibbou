// Graph logic for the lineage view, kept free of React so it can be tested
// (test/lineageLayout.test.js).

export function adjacency(edges) {
  const incoming = new Map();
  const outgoing = new Map();
  const ids = new Set();
  for (const edge of edges) {
    const from = edge.upstream_dataset_id;
    const to = edge.downstream_dataset_id;
    ids.add(from);
    ids.add(to);
    if (!outgoing.has(from)) outgoing.set(from, []);
    if (!incoming.has(to)) incoming.set(to, []);
    outgoing.get(from).push(to);
    incoming.get(to).push(from);
  }
  return { ids, incoming, outgoing };
}

function walk(startIds, next) {
  const seen = new Set();
  const queue = [...startIds];
  while (queue.length) {
    const id = queue.shift();
    for (const neighbour of next.get(id) || []) {
      if (!seen.has(neighbour)) {
        seen.add(neighbour);
        queue.push(neighbour);
      }
    }
  }
  return seen;
}

// Everything that feeds into, and everything that depends on, the given
// datasets, however many steps away.
export function upstreamOf(ids, incoming) {
  return walk(ids, incoming);
}

export function downstreamOf(ids, outgoing) {
  return walk(ids, outgoing);
}

export function lineageClosure(edges, seedIds) {
  const { incoming, outgoing } = adjacency(edges);
  return new Set([...seedIds, ...upstreamOf(seedIds, incoming), ...downstreamOf(seedIds, outgoing)]);
}

// A dataset with nothing upstream is a Source, one with nothing downstream
// is a Destination, anything else is a Transformation.
export function classifyRole(id, incoming, outgoing) {
  if (!(incoming.get(id) || []).length) return "source";
  if (!(outgoing.get(id) || []).length) return "destination";
  return "transformation";
}

// Column = longest path from a source, so every arrow points to a later
// column. Datasets caught in a cycle (which dbt doesn't allow, but the API
// does) are placed one column after their placed parents.
function columns(ids, incoming, outgoing) {
  const remaining = new Map([...ids].map((id) => [id, (incoming.get(id) || []).length]));
  const column = new Map();
  const queue = [...ids].filter((id) => remaining.get(id) === 0);
  queue.forEach((id) => column.set(id, 0));
  while (queue.length) {
    const id = queue.shift();
    for (const child of outgoing.get(id) || []) {
      column.set(child, Math.max(column.get(child) ?? 0, column.get(id) + 1));
      remaining.set(child, remaining.get(child) - 1);
      if (remaining.get(child) === 0) queue.push(child);
    }
  }
  for (const id of ids) {
    if (!column.has(id) || remaining.get(id) > 0) {
      const placedParents = (incoming.get(id) || []).filter((parent) => remaining.get(parent) === 0);
      column.set(id, Math.max(0, ...placedParents.map((parent) => column.get(parent) + 1)));
    }
  }
  return column;
}

function components(ids, incoming, outgoing) {
  const componentOf = new Map();
  const groups = [];
  for (const id of ids) {
    if (componentOf.has(id)) continue;
    const members = [id];
    componentOf.set(id, groups.length);
    for (let i = 0; i < members.length; i += 1) {
      for (const next of [...(incoming.get(members[i]) || []), ...(outgoing.get(members[i]) || [])]) {
        if (!componentOf.has(next)) {
          componentOf.set(next, groups.length);
          members.push(next);
        }
      }
    }
    groups.push(members);
  }
  return groups;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

// Lays the graph out left to right. Each connected group of datasets gets
// its own horizontal band (largest first) so separate projects don't
// interleave, and within a band each column is ordered by the average row
// of its parents, then of its children, to cut down on crossing lines.
export function layoutLineage(edges, { nameOf = (id) => id } = {}) {
  const { ids, incoming, outgoing } = adjacency(edges);
  const column = columns(ids, incoming, outgoing);
  const groups = components(ids, incoming, outgoing).sort(
    (left, right) => right.length - left.length || nameOf(left[0]).localeCompare(nameOf(right[0]))
  );

  const placed = new Map();
  let bandStart = 0;
  let columnCount = 0;
  for (const members of groups) {
    const byColumn = new Map();
    for (const id of members) {
      const index = column.get(id);
      if (!byColumn.has(index)) byColumn.set(index, []);
      byColumn.get(index).push(id);
    }
    const columnIndexes = [...byColumn.keys()].sort((left, right) => left - right);
    const row = new Map();
    const order = (list, neighbours) => {
      const keyed = list.map((id, index) => ({
        id,
        key: average((neighbours.get(id) || []).filter((other) => row.has(other)).map((other) => row.get(other))) ?? index,
      }));
      keyed.sort((left, right) => left.key - right.key || nameOf(left.id).localeCompare(nameOf(right.id)));
      keyed.forEach((item, index) => row.set(item.id, index));
      return keyed.map((item) => item.id);
    };
    for (const index of columnIndexes) {
      byColumn.set(index, [...byColumn.get(index)].sort((left, right) => nameOf(left).localeCompare(nameOf(right))));
      byColumn.get(index).forEach((id, position) => row.set(id, position));
    }
    for (const index of columnIndexes.slice(1)) byColumn.set(index, order(byColumn.get(index), incoming));
    for (const index of [...columnIndexes].reverse().slice(1)) byColumn.set(index, order(byColumn.get(index), outgoing));

    let bandHeight = 0;
    for (const index of columnIndexes) {
      byColumn.get(index).forEach((id, position) => {
        placed.set(id, {
          id,
          column: index,
          row: bandStart + position,
          role: classifyRole(id, incoming, outgoing),
        });
      });
      bandHeight = Math.max(bandHeight, byColumn.get(index).length);
      columnCount = Math.max(columnCount, index + 1);
    }
    bandStart += bandHeight;
  }

  return { nodes: placed, incoming, outgoing, rowCount: bandStart, columnCount };
}
