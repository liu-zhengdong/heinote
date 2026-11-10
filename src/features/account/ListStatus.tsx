export function ListStatus({ loading, error, retry, empty, emptyText }: {
  loading: boolean; error: string; retry(): void; empty: boolean; emptyText: string;
}) {
  return <>
    {loading ? <p className="account-muted" role="status">正在加载…</p> : null}
    {error ? <div className="account-status"><p className="account-error" role="alert">{error}</p><button type="button" className="btn" disabled={loading} onClick={retry}>重试</button></div> : null}
    {!loading && !error && empty ? <p className="account-empty">{emptyText}</p> : null}
  </>;
}
