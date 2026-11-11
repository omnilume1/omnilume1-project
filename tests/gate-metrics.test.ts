import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GATE_DEFAULT_SINCE, GATE_METRICS, formatGate, gateValue, parseSince, verdict, type GateMetricsData,
} from '../src/lib/gate-metrics.js';

const data: GateMetricsData = {
  since: '2026-11-15',
  activated_nights: 3,
  activated_groups: 2,
  hostel_proof_nights: 1,
  hostel_proof_rate: 0.3333,
  g_d7: 0.5,
  g_w4: null,
  g_w4_eligible: 0,
  median_minutes: 30,
  card_shares_per_night: 0,
  spots_per_night: 2.3333,
  funnel: [],
  ab: { lp_a: { rooms: 1, joins: 1 }, lp_b: { rooms: 1, joins: 0 } },
  k: { i: 0.6667, o: 1.5, j: 0.6667, h: 0, r: 0, d: 0.3333 },
};

test('gate thresholds match the roadmap gates and week-4 targets', () => {
  assert.deepEqual(Object.fromEntries(GATE_METRICS.map((metric) => [metric.key, metric.threshold])), {
    j: 0.4, activated_groups: 10, hostel_proof_rate: 0.4, g_d7: 0.3, g_w4: 0.25, median_minutes: 60,
    card_shares_per_night: 0.3, spots_per_night: 2, i: 2, o: 0.6, h: 0.15, r: 0.3, d: 0.4,
  });
});

test('verdict is none when there is no data', () => {
  assert.equal(verdict('j', null), 'none');
  assert.equal(verdict('j', undefined), 'none');
  assert.equal(verdict('median_minutes', Number.NaN), 'none');
});

test('verdict is go at the threshold and miss just under it, for every metric', () => {
  for (const metric of GATE_METRICS) {
    assert.equal(verdict(metric.key, metric.threshold), 'go', `${metric.key} at the threshold`);
    assert.equal(verdict(metric.key, metric.threshold - 0.0001), 'miss', `${metric.key} just under`);
    assert.equal(verdict(metric.key, metric.threshold + 1), 'go', `${metric.key} above`);
  }
  assert.equal(verdict('h', 0), 'miss');
});

test('gateValue reads K inputs from k and the rest from the top level', () => {
  assert.equal(gateValue(data, 'j'), 0.6667);
  assert.equal(gateValue(data, 'd'), 0.3333);
  assert.equal(gateValue(data, 'activated_groups'), 2);
  assert.equal(gateValue(data, 'g_w4'), null);
  assert.equal(verdict('g_w4', gateValue(data, 'g_w4')), 'none');
  assert.equal(verdict('j', gateValue(data, 'j')), 'go');
  assert.equal(verdict('activated_groups', gateValue(data, 'activated_groups')), 'miss');
});

test('formatGate shows percent, minutes, counts and ratios', () => {
  assert.equal(formatGate('percent', 0.6667), '66.7%');
  assert.equal(formatGate('percent', 1.5), '150%');
  assert.equal(formatGate('minutes', 30), '30 min');
  assert.equal(formatGate('count', 2), '2');
  assert.equal(formatGate('ratio', 2.3333), '2.33');
  assert.equal(formatGate('ratio', null), 'No data');
});

test('parseSince keeps a real date and falls back otherwise', () => {
  assert.equal(parseSince('2026-12-06'), '2026-12-06');
  assert.equal(parseSince(undefined), GATE_DEFAULT_SINCE);
  assert.equal(parseSince('garbage'), GATE_DEFAULT_SINCE);
  assert.equal(parseSince('2026-02-30'), GATE_DEFAULT_SINCE);
  assert.equal(parseSince('2026-11-15; DROP'), GATE_DEFAULT_SINCE);
  assert.equal(parseSince(['2026-12-06', '2026-12-07']), GATE_DEFAULT_SINCE);
  assert.equal(GATE_DEFAULT_SINCE, '2026-11-15');
});
