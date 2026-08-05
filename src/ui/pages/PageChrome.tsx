import type { ReactNode } from 'react';

/** Shared page frame: breadcrumb, heading and optional primary action. */
export function Page({
  title,
  primary,
  children,
}: {
  title: string;
  primary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="page-head">
        <div>
          <p className="breadcrumbs">SWL / {title}</p>
          <h1>{title}</h1>
        </div>
        {primary}
      </div>
      {children}
    </>
  );
}

export function OperationalList({ items }: { items: string[] }) {
  return (
    <section className="card">
      <ul className="operational-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/** Consistent empty state used when no comparison data is loaded yet. */
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <section className="card empty-state">
      <h2>{title}</h2>
      <p>{detail}</p>
      {action}
    </section>
  );
}
