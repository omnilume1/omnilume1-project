// Purple light and grain behind every page, so glass has something to frost.
// Static on purpose: moving light under backdrop-filter re-blurs every frame.
export default function AmbientBackground() {
  return (
    <div className="omni-ambient" aria-hidden="true">
      <span className="omni-orb omni-orb-1" />
      <span className="omni-orb omni-orb-2" />
      <span className="omni-orb omni-orb-3" />
      <span className="omni-orb omni-orb-4" />
    </div>
  );
}
