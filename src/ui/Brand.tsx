import { SWL_LOGO_URL } from '../assets/swlLogo';

/** Exact supplied Stan Wootton logo, bundled locally with no remote dependency. */

export function BrandMark({ size = 32, title }: { size?: number; title?: string }) {
  return (
    <img
      className="brand-mark"
      width={size}
      height={Math.round((size * 103) / 124)}
      src={SWL_LOGO_URL}
      alt={title ?? ''}
      role={title === undefined ? 'presentation' : undefined}
      aria-hidden={title === undefined ? true : undefined}
    />
  );
}

/** Full lock-up: supplied logo plus the trading name and the product name. */
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
