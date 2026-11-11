// Gate board (hostel roadmap phase 15): the thresholds from the Gates table
// and the K-factor week-4 targets, beside what get_gate_metrics returns.
// Pure, so the verdicts are unit-tested.

export type GateVerdict = 'go' | 'miss' | 'none';
export type GateUnit = 'percent' | 'minutes' | 'count' | 'ratio';

type KInput = 'i' | 'o' | 'j' | 'h' | 'r' | 'd';

// The jsonb object public.get_gate_metrics(p_since) returns. Ratios are null
// when their divisor is 0.
export interface GateMetricsData {
  since: string;
  activated_nights: number;
  activated_groups: number;
  hostel_proof_nights: number;
  hostel_proof_rate: number | null;
  g_d7: number | null;
  g_w4: number | null;
  g_w4_eligible: number;
  median_minutes: number | null;
  card_shares_per_night: number | null;
  spots_per_night: number | null;
  funnel: Array<{ ref: string; share_completed: number; join_viewed: number; joined: number; guest_joined: number; room_created: number }>;
  ab: Record<'lp_a' | 'lp_b', { rooms: number; joins: number }>;
  k: Record<KInput, number | null>;
}

// The dogfood night: the first night the gates are measured from.
export const GATE_DEFAULT_SINCE = '2026-11-15';

export const GATE_METRICS = [
  { key: 'j', label: 'Join rate (j): joins per link view', threshold: 0.4, unit: 'percent' },
  { key: 'activated_groups', label: 'Activated groups', threshold: 10, unit: 'count' },
  { key: 'hostel_proof_rate', label: 'Hostel-proof nights', threshold: 0.4, unit: 'percent' },
  { key: 'g_d7', label: 'G-D7: groups back within 7 days', threshold: 0.3, unit: 'percent' },
  { key: 'g_w4', label: 'G-W4: groups back in week 4', threshold: 0.25, unit: 'percent' },
  { key: 'median_minutes', label: 'Median minutes together', threshold: 60, unit: 'minutes' },
  { key: 'card_shares_per_night', label: 'Card shares per night', threshold: 0.3, unit: 'ratio' },
  { key: 'spots_per_night', label: 'Spots used per night', threshold: 2, unit: 'ratio' },
  { key: 'i', label: 'i: link shares per activated night', threshold: 2, unit: 'ratio' },
  { key: 'o', label: 'o: link views per share', threshold: 0.6, unit: 'percent' },
  { key: 'h', label: 'h: joiners who open their own room', threshold: 0.15, unit: 'percent' },
  { key: 'r', label: 'r: recap shares per night', threshold: 0.3, unit: 'ratio' },
  { key: 'd', label: 'd: nights with a drop-in', threshold: 0.4, unit: 'percent' },
] as const satisfies ReadonlyArray<{ key: string; label: string; threshold: number; unit: GateUnit }>;

export type GateMetricKey = (typeof GATE_METRICS)[number]['key'];

// K inputs sit under `k`; everything else is a top-level field.
export function gateValue(data: GateMetricsData, key: GateMetricKey): number | null {
  const raw = ({ ...data, ...data.k } as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

// At or above the threshold is a go. No data (null) is neither.
export function verdict(metric: GateMetricKey, value: number | null | undefined): GateVerdict {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'none';
  const threshold = GATE_METRICS.find((item) => item.key === metric)?.threshold;
  if (threshold === undefined) return 'none';
  return value >= threshold ? 'go' : 'miss';
}

export function formatGate(unit: GateUnit, value: number | null): string {
  if (value === null) return 'No data';
  if (unit === 'percent') return `${Math.round(value * 1000) / 10}%`;
  if (unit === 'minutes') return `${Math.round(value)} min`;
  if (unit === 'count') return String(value);
  return String(Math.round(value * 100) / 100);
}

// ?since=YYYY-MM-DD, only when it is a real calendar date.
export function parseSince(value: string | string[] | undefined, fallback: string = GATE_DEFAULT_SINCE): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? fallback : value;
}
