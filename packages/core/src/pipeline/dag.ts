export interface DagNode {
  id: string;
  deps: string[];
}

/**
 * Kahn's algorithm. Returns nodes in dependency-safe order.
 * Throws on unknown dep references and on cycles — a broken DAG must
 * never reach the executor.
 */
export function topoOrder<T extends DagNode>(nodes: T[]): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!byId.has(d)) {
        throw new Error(`task "${n.id}" depends on unknown task "${d}"`);
      }
    }
  }

  const indegree = new Map<string, number>(nodes.map((n) => [n.id, n.deps.length]));
  const ready = nodes.filter((n) => n.deps.length === 0).map((n) => n.id);
  const ordered: T[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const n of nodes) {
      if (!n.deps.includes(id)) continue;
      const remaining = indegree.get(id) === undefined ? 0 : (indegree.get(n.id)! - 1);
      indegree.set(n.id, remaining);
      if (remaining === 0) ready.push(n.id);
    }
  }

  if (ordered.length !== nodes.length) {
    const stuck = nodes.filter((n) => !ordered.includes(n)).map((n) => n.id);
    throw new Error(`cycle detected among tasks: ${stuck.join(", ")}`);
  }
  return ordered;
}
