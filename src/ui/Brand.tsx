/**
 * Stan Wootton Locksmiths brand assets.
 *
 * The monogram is drawn as geometry rather than text so it renders identically
 * on every machine, including a fresh Windows install with no extra fonts and
 * a desktop Content Security Policy that forbids remote fonts entirely.
 */

export function BrandMark({ size = 32, title }: { size?: number; title?: string }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      role={title === undefined ? 'presentation' : 'img'}
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
    >
      {title !== undefined && <title>{title}</title>}
      <rect width="256" height="256" rx="52" fill="#D81E24" />
      <g fill="none" stroke="#ffffff" strokeWidth="23" strokeLinecap="butt" strokeLinejoin="miter">
        <path d="M99 100c0-13-12-21-27-21s-27 8-27 20 11 18 27 21 27 9 27 23-12 24-27 24-27-9-28-21" />
        <polyline points="126,79 150,167 174,107 198,167 222,79" />
      </g>
    </svg>
  );
}

/** Full lock-up: monogram plus the trading name and the product name. */
export function BrandLockup({ productName }: { productName: string }) {
  return (
    <div className="brand-lockup">
      <BrandMark size={38} title="Stan Wootton Locksmiths" />
      <span className="brand-text">
        <span className="brand-name">Stan Wootton</span>
        <span className="brand-product">{productName}</span>
      </span>
    </div>
  );
}

/** Greeting appropriate to the operator's local time of day. */
export function timeOfDayGreeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
