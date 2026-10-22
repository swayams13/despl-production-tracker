/**
 * J5c: a BOM re-release retires floor rows it no longer wants (never deletes them, invariant 6). Every read of
 * `components`, `component_operations` or `assembly_steps` that means "the work to do" spreads this into its `where`;
 * a read of history (done-today events, NCR relations, traceability) carries a `// j5c: history` marker instead.
 * The static guard `j5c-active-row-guard.test.ts` fails when a service does neither.
 */
export const activeRow = { retiredAt: null } as const;
