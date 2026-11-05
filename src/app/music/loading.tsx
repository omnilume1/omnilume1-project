export default function MusicLoading() {
  return (
    <div className="mu-skeleton" role="status" aria-label="Loading">
      <span className="mu-skel is-title" />
      <span className="mu-skel is-heading" />
      <div className="mu-skel-row">{Array.from({ length: 6 }, (_, i) => <span key={i} className="mu-skel is-square" />)}</div>
    </div>
  );
}
