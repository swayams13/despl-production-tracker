/**
 * Small tunables that DESIGN_SPEC calls out as "config, not hardcoded" so a
 * later change never means hunting through component code for a magic number.
 */

/** §4.7: a welder's NDT repair rate above this draws a red flag chip. */
export const NDT_REPAIR_RATE_ALERT_PCT = 6;

/** §6: a hold point open longer than this notifies QC + Production Head. */
export const HOLD_POINT_AGE_ALERT_DAYS = 5;

/** D32: nudgeQc's own cooldown, per (plan, actor), derived server-side from the last NUDGE Notification row — never client state. */
export const NUDGE_COOLDOWN_MINUTES = 30;

/** L1.4: late-reason reminders start at this IST hour, on working days only. */
export const LATE_REASON_REMINDER_HOUR_IST = 10;

/** L1.4: hours after a plan's first reminder before the Production Head is told it still has no reason. */
export const LATE_REASON_ESCALATE_HOURS = 24;
