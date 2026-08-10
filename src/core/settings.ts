import { z } from 'zod';

/**
 * Operator settings. The markup default is the confirmed business rule
 * (30% markup on cost).
 *
 * Tax handling declares HOW THE SUPPLIER QUOTES ITS COSTS, which is the one
 * fact the application cannot derive from the files. It ships unset, and an
 * unset value blocks export: the markup must be applied to a GST-exclusive
 * cost, so reading the supplier's basis wrongly moves every price by the GST
 * rate. The basis of each ServiceM8 price is NOT taken from here — it is read
 * per row from that row's own "Price Includes Taxes" column.
 */
export const TAX_HANDLING_OPTIONS = {
  'not-configured':
    "Not configured — pricing is blocked until the supplier's GST basis is confirmed",
  'prices-ex-gst': 'Supplier costs EXCLUDE GST — markup is applied to the listed cost',
  'prices-inc-gst': 'Supplier costs INCLUDE GST — GST is removed before the markup is applied',
} as const;
export type TaxHandling = keyof typeof TAX_HANDLING_OPTIONS;

/** Short label used in tables and audit lines. */
export const TAX_HANDLING_SHORT: Record<TaxHandling, string> = {
  'not-configured': 'Not configured',
  'prices-ex-gst': 'Supplier costs exclude GST',
  'prices-inc-gst': 'Supplier costs include GST',
};

export const SettingsSchema = z
  .object({
    markupPercent: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Markup must be a number between 30 and 999.99')
      .refine((value) => Number(value) >= 30, 'Markup must not be below the 30% minimum'),
    taxHandling: z.enum(['not-configured', 'prices-ex-gst', 'prices-inc-gst']),
    theme: z.enum(['light', 'dark']),
  })
  .strict();
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
