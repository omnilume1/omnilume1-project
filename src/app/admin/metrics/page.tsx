import { notFound } from 'next/navigation';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import {
  GATE_METRICS, formatGate, gateValue, parseSince, verdict, type GateMetricsData, type GateVerdict,
} from '@/lib/gate-metrics';
import { createClient } from '@/utils/supabase/server';

const CHIPS: Record<GateVerdict, { label: string; className: string }> = {
  go: { label: 'Go', className: 'form-success' },
  miss: { label: 'Miss', className: 'form-error' },
  none: { label: 'No data', className: 'rounded-[10px] border border-neutral-800 px-3 py-2.5 text-xs text-neutral-500' },
};

const FUNNEL_COLUMNS = ['share_completed', 'join_viewed', 'joined', 'guest_joined', 'room_created'] as const;

// Site owners only, like /admin/recovery: everyone else gets the standard 404,
// and get_gate_metrics refuses them in the database as well. The function
// returns counts and ratios only: no room ids, no user ids.
export default async function AdminMetricsPage({ searchParams }: { searchParams: Promise<{ since?: string | string[] }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data: isSiteOwner, error: ownerError } = await supabase.rpc('is_site_owner', { p_user_id: user.id });
  if (ownerError || isSiteOwner !== true) notFound();

  const since = parseSince((await searchParams).since);
  const { data, error } = await supabase.rpc('get_gate_metrics', { p_since: since });
  const metrics = error ? null : (data as GateMetricsData | null);

  return (
    <div className="omni-internal">
      <InternalTopbar
        eyebrow="Site owner"
        title="Gate board"
        description={`Nights from ${since} on. A night runs 6 am to 6 am IST; an activated night has 3 or more ticks (about 20 minutes with 2 or more people).`}
      />
      <main className="omni-main-content space-y-5">
        {!metrics ? (
          <p role="alert" className="form-error">Unable to load the gate metrics.</p>
        ) : (
          <>
            <section className="glass-card-ambient overflow-x-auto p-5" aria-labelledby="gate-heading">
              <h2 id="gate-heading" className="text-lg font-semibold text-white">Gates</h2>
              <p className="text-xs text-neutral-400">
                {metrics.activated_nights} activated night{metrics.activated_nights === 1 ? '' : 's'}, {metrics.hostel_proof_nights} hostel-proof, {metrics.g_w4_eligible} group{metrics.g_w4_eligible === 1 ? '' : 's'} old enough for week 4.
              </p>
              <table className="mt-4 w-full text-left text-sm text-neutral-200">
                <thead className="text-xs text-neutral-500">
                  <tr><th scope="col" className="py-2 pr-4 font-medium">Metric</th><th scope="col" className="py-2 pr-4 font-medium">Value</th><th scope="col" className="py-2 pr-4 font-medium">Threshold</th><th scope="col" className="py-2 font-medium">Gate</th></tr>
                </thead>
                <tbody>
                  {GATE_METRICS.map((metric) => {
                    const value = gateValue(metrics, metric.key);
                    const chip = CHIPS[verdict(metric.key, value)];
                    return (
                      <tr key={metric.key} className="border-t border-neutral-800">
                        <th scope="row" className="py-2.5 pr-4 font-normal">{metric.label}</th>
                        <td className="mono py-2.5 pr-4">{formatGate(metric.unit, value)}</td>
                        <td className="mono py-2.5 pr-4 text-neutral-400">≥ {formatGate(metric.unit, metric.threshold)}</td>
                        <td className="py-2.5"><span className={`inline-block !py-1 ${chip.className}`}>{chip.label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            <section className="glass-card-ambient overflow-x-auto p-5" aria-labelledby="funnel-heading">
              <h2 id="funnel-heading" className="text-lg font-semibold text-white">Funnel by ref</h2>
              <p className="text-xs text-neutral-400">
                Landing A/B: lp-a {metrics.ab.lp_a.rooms} room{metrics.ab.lp_a.rooms === 1 ? '' : 's'} and {metrics.ab.lp_a.joins} join{metrics.ab.lp_a.joins === 1 ? '' : 's'}; lp-b {metrics.ab.lp_b.rooms} room{metrics.ab.lp_b.rooms === 1 ? '' : 's'} and {metrics.ab.lp_b.joins} join{metrics.ab.lp_b.joins === 1 ? '' : 's'}.
              </p>
              {metrics.funnel.length === 0 ? (
                <p className="mt-4 rounded-xl border border-dashed border-neutral-800 px-4 py-8 text-center text-sm text-neutral-500">No funnel events in this window yet.</p>
              ) : (
                <table className="mt-4 w-full text-left text-sm text-neutral-200">
                  <thead className="text-xs text-neutral-500">
                    <tr><th scope="col" className="py-2 pr-4 font-medium">Ref</th>{FUNNEL_COLUMNS.map((column) => <th key={column} scope="col" className="py-2 pr-4 font-medium">{column.replace('_', ' ')}</th>)}</tr>
                  </thead>
                  <tbody>
                    {metrics.funnel.map((row) => (
                      <tr key={row.ref} className="border-t border-neutral-800">
                        <th scope="row" className="mono py-2.5 pr-4 font-normal">{row.ref}</th>
                        {FUNNEL_COLUMNS.map((column) => <td key={column} className="mono py-2.5 pr-4">{row[column]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </main>
      <FloatingDock />
    </div>
  );
}
