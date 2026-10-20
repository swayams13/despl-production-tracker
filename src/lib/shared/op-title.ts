/**
 * A part's route can use one canonical operation more than once: a dished end is "Pressing / Spinning" then
 * "Trimming", both FORMING; a flange has three MACHINING steps. The row has no label of its own (only the
 * operation), so the floor saw the same title repeated. This numbers the repeats: " (1 of 2)", " (2 of 2)".
 * A name used once gets nothing. `group` is the part (component) the steps belong to; order is by `seq`.
 */
export function repeatedOpSuffixes<K extends string | number>(
  ops: ReadonlyArray<{ key: K; group: string | number; name: string; seq: number }>,
): Map<K, string> {
  const byName = new Map<string, Array<{ key: K; seq: number }>>();
  for (const o of ops) {
    const id = `${o.group}\u0000${o.name}`;
    const list = byName.get(id);
    if (list) list.push(o);
    else byName.set(id, [o]);
  }
  const out = new Map<K, string>();
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.seq - b.seq).forEach((o, i) => out.set(o.key, ` (${i + 1} of ${list.length})`));
  }
  return out;
}
