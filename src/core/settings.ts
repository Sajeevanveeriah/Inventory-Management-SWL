import { z } from 'zod';

/**
 * Operator settings. The markup default is the confirmed business rule
 * (30% markup on cost). Tax handling ships DISABLED: no GST transformation is
 * ever applied until the operator explicitly selects and confirms one.
 */
export const TAX_HANDLING_OPTIONS = {
  'not-configured': 'Not configured — no tax transformation is applied',
  'prices-ex-gst': 'Treat all values as GST-exclusive (no transformation applied)',
  'prices-inc-gst': 'Treat all values as GST-inclusive (no transformation applied)',
} as const;
export type TaxHandling = keyof typeof TAX_HANDLING_OPTIONS;

export const SettingsSchema = z.object({
  markupPercent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Markup must be a number between 0 and 999.99'),
  taxHandling: z.enum(['not-configured', 'prices-ex-gst', 'prices-inc-gst']),
  theme: z.enum(['light', 'dark']),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  markupPercent: '30',
  taxHandling: 'not-configured',
  theme: 'light',
};

export interface SettingsChangeLogEntry {
  at: string;
  change: string;
}
