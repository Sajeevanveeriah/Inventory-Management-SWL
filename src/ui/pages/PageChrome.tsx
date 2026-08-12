import type { ReactNode } from 'react';

/** Shared page frame: one route heading and an optional primary action. */
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
          <h1 tabIndex={-1}>{title}</h1>
        </div>
        {primary && <div className="page-primary">{primary}</div>}
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

/** Consistent teaching empty state: says what the surface is for and what to do next. */
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
