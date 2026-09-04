import { describe, expect, it } from "vitest";
import { portfolioToSunburst } from "./_sunburst-data";
import type { Portfolio, PortfolioRow } from "@/lib/services/portfolio.read";

function row(overrides: Partial<PortfolioRow>): PortfolioRow {
  return {
    id: 1,
    jobNumber: "DE0001",
    projectName: null,
    familyName: "PRESSURE_VESSEL",
    status: "ACTIVE",
    committedDeliveryDate: null,
    forecastDispatch: null,
    forecastVarianceDays: null,
    equipmentCount: 1,
    unitCount: 1,
    totalPlans: 10,
    completePlans: 5,
    overduePlans: 0,
    percentComplete: 50,
    openHoldPoints: 0,
    lastActivityAt: null,
    unitRollup: [],
    health: "ON_TRACK",
    clientName: "Client",
    daysToPromise: null,
    verifiedLast24h: 0,
    newlyOverdueLast24h: 0,
    holdsOpenedLast24h: 0,
    ...overrides,
  };
}

function portfolio(rows: PortfolioRow[]): Portfolio {
  return {
    counts: { active: rows.length, ON_TRACK: 0, AT_RISK: 0, DELAYED: 0, ON_HOLD: 0, COMPLETED: 0, NOT_PLANNED: 0 },
    rows,
    cancelledCount: 0,
  };
}

describe("portfolioToSunburst", () => {
  it("groups jobs under their health, each with a stage-status breakdown", () => {
    const tree = portfolioToSunburst(
      portfolio([
        row({ jobNumber: "DE0001", health: "ON_TRACK", totalPlans: 10, completePlans: 6, overduePlans: 0 }),
        row({ jobNumber: "DE0002", health: "DELAYED", totalPlans: 8, completePlans: 2, overduePlans: 3 }),
      ]),
    );

    const onTrack = tree.find((n) => n.name === "On track")!;
    expect(onTrack.children).toHaveLength(1);
    expect(onTrack.children![0].name).toBe("DE0001");
    // 6 complete + 4 in-progress (10 - 6 - 0), no overdue leaf since overduePlans is 0.
    expect(onTrack.children![0].children).toEqual([
      { name: "Complete", value: 6, color: "var(--s-complete)" },
      { name: "In progress", value: 4, color: "var(--s-progress)" },
    ]);

    const delayed = tree.find((n) => n.name === "Delayed")!;
    expect(delayed.children![0].children).toEqual([
      { name: "Complete", value: 2, color: "var(--s-complete)" },
      { name: "Overdue", value: 3, color: "var(--s-overdue)" },
      { name: "In progress", value: 3, color: "var(--s-progress)" },
    ]);
  });

  it("floors an unscheduled job's value at 1 so it stays visible instead of vanishing", () => {
    const tree = portfolioToSunburst(portfolio([row({ health: "NOT_PLANNED", totalPlans: 0, completePlans: 0, overduePlans: 0 })]));
    const bucket = tree.find((n) => n.name === "Not planned")!;
    expect(bucket.value).toBe(1);
    expect(bucket.children![0].value).toBe(1);
  });

  it("drops health buckets with zero jobs entirely rather than rendering an empty ring segment", () => {
    const tree = portfolioToSunburst(portfolio([row({ health: "ON_TRACK" })]));
    expect(tree.map((n) => n.name)).toEqual(["On track"]);
  });

  it("returns an empty tree for an empty portfolio", () => {
    expect(portfolioToSunburst(portfolio([]))).toEqual([]);
  });
});
