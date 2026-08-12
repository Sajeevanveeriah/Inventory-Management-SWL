import type { AppearanceTheme } from '../core/settings';

const OPTIONS: ReadonlyArray<{
  value: AppearanceTheme;
  label: string;
}> = [
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
];

function AppearanceIcon({ value }: { value: AppearanceTheme }) {
  return (
    <svg
      viewBox="0 0 18 18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {value === 'light' && (
        <>
          <circle cx="9" cy="9" r="3" />
          <path d="M9 1.6v1.7M9 14.7v1.7M1.6 9h1.7M14.7 9h1.7M3.8 3.8 5 5M13 13l1.2 1.2M14.2 3.8 13 5M5 13l-1.2 1.2" />
        </>
      )}
      {value === 'system' && (
        <>
          <rect x="2.2" y="2.5" width="13.6" height="9.6" rx="2" />
          <path d="M6.2 15.3h5.6M9 12.1v3.2" />
        </>
      )}
      {value === 'dark' && <path d="M15.1 10.5A6.3 6.3 0 0 1 7.5 2.9a6.3 6.3 0 1 0 7.6 7.6z" />}
    </svg>
  );
}

export function AppearanceControl({
  value,
  disabled = false,
  onChange,
}: {
  value: AppearanceTheme;
  disabled?: boolean;
  onChange: (value: AppearanceTheme) => void;
}) {
  return (
    <div className="appearance-control" role="group" aria-label="Appearance mode">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-label={`${option.label} appearance`}
          title={option.label}
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          <AppearanceIcon value={option.value} />
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
