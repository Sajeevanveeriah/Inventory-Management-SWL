import type { HTMLAttributes, ReactNode } from 'react';
import { kickerForTitle } from '../routes';

/**
 * Shared page frame: the mono kicker, one route heading, one sentence of lead
 * copy and an optional primary action.
 *
 * The lead is deliberately a single sentence. Standing explanatory paragraphs
 * and the repeated privacy and boundary statements live in the privacy dialog
 * and on the Help page, not at the top of every screen.
 */
export function Page({
  title,
  kicker,
  lead,
  primary,
  children,
}: {
  title: string;
  kicker?: string;
  lead?: string;
  primary?: ReactNode;
  children: ReactNode;
}) {
  const resolvedKicker = kicker ?? kickerForTitle(title);
  return (
    <>
      <div className="page-head">
        <div>
          {resolvedKicker !== undefined && (
            <span className="page-kicker" aria-hidden="true">
              {resolvedKicker}
            </span>
          )}
          <h1 tabIndex={-1}>{title}</h1>
          {lead !== undefined && <p className="page-lead">{lead}</p>}
        </div>
        {primary && <div className="page-primary">{primary}</div>}
      </div>
      {children}
    </>
  );
}

/** A ruled panel: heading row, optional right-aligned mono meta, then a body. */
export function Panel({
  title,
  meta,
  headingLevel = 2,
  children,
  ...rest
}: {
  title: string;
  meta?: ReactNode;
  headingLevel?: 2 | 3;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'title'>) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className="card" {...rest}>
      <div className="panel-head">
        <Heading>{title}</Heading>
        {meta !== undefined && <span className="panel-meta">{meta}</span>}
      </div>
      {children}
    </section>
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
