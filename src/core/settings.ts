import { z } from 'zod';

/**
 * Operator settings. The markup default is the confirmed business rule
 * (30% markup on cost).
 *
 * Tax handling declares HOW THE SUPPLIER QUOTES ITS COSTS, which is the one
 * fact the application cannot derive from the files. It ships unset, and an
 * unset value blocks export: the markup must be applied to a GST-exclusive
 * cost, so reading the supplier's basis wrongly moves every price by the GST
 * rate. The basis of each ServiceM8 price is NOT taken from here: it is read
 * per row from that row's own "Price Includes Taxes" column.
 */
export const TAX_HANDLING_OPTIONS = {
  'not-configured':
    "Not configured: pricing is blocked until the supplier's GST basis is confirmed",
  'prices-ex-gst': 'Supplier costs EXCLUDE GST: markup is applied to the listed cost',
  'prices-inc-gst': 'Supplier costs INCLUDE GST: GST is removed before the markup is applied',
} as const;
export type TaxHandling = keyof typeof TAX_HANDLING_OPTIONS;

/** Short label used in tables and audit lines. */
export const TAX_HANDLING_SHORT: Record<TaxHandling, string> = {
  'not-configured': 'Not configured',
  'prices-ex-gst': 'Supplier costs exclude GST',
  'prices-inc-gst': 'Supplier costs include GST',
};

export const APPEARANCE_THEME_OPTIONS = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
} as const;
export type AppearanceTheme = keyof typeof APPEARANCE_THEME_OPTIONS;

export const GLASS_TINT_OPTIONS = {
  clear: 'Clear glass',
  tinted: 'Blue tinted glass',
} as const;
export type GlassTint = keyof typeof GLASS_TINT_OPTIONS;

/**
 * One authoritative definition for every adjustable global setting.
 *
 * Runtime validation, defaults and the settings UI all consume this object.
 * Product and brand markup overrides intentionally do not appear here: they
 * are typed catalogue rules with the fixed product > brand > global order.
 */
export const SETTING_DEFINITIONS = {
  markupPercent: {
    key: 'markupPercent',
    name: 'Global markup',
    help: 'Used only when a product and its brand do not have their own markup.',
    group: 'Pricing',
    control: 'decimal',
    unit: '%',
    min: 30,
    max: 999.99,
    step: 0.01,
    defaultValue: '30',
    consequential: true,
    schema: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Markup must be a number between 30 and 999.99')
      .refine((value) => Number(value) >= 30, 'Markup must not be below the 30% minimum'),
  },
  taxHandling: {
    key: 'taxHandling',
    name: 'Supplier cost GST basis',
    help: 'States whether supplier purchase costs include GST before markup is applied.',
    group: 'Pricing',
    control: 'select',
    options: TAX_HANDLING_OPTIONS,
    defaultValue: 'not-configured',
    consequential: true,
    schema: z.enum(['not-configured', 'prices-ex-gst', 'prices-inc-gst']),
  },
  theme: {
    key: 'theme',
    name: 'Theme',
    help: 'System follows the current Windows light or dark appearance.',
    group: 'Appearance',
    control: 'select',
    options: APPEARANCE_THEME_OPTIONS,
    defaultValue: 'system',
    consequential: false,
    schema: z.enum(['system', 'light', 'dark']),
  },
  glassTint: {
    key: 'glassTint',
    name: 'Glass finish',
    help: 'Changes the interface material only and never changes status colours or prices.',
    group: 'Appearance',
    control: 'select',
    options: GLASS_TINT_OPTIONS,
    defaultValue: 'clear',
    consequential: false,
    // Defaulting this one field migrates valid settings saved before the
    // appearance finish was introduced while strict mode still rejects drift.
    schema: z.enum(['clear', 'tinted']).default('clear'),
  },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export const SETTING_DEFINITION_LIST = Object.values(SETTING_DEFINITIONS);

export const SettingsSchema = z
  .object({
    markupPercent: SETTING_DEFINITIONS.markupPercent.schema,
    taxHandling: SETTING_DEFINITIONS.taxHandling.schema,
    theme: SETTING_DEFINITIONS.theme.schema,
    glassTint: SETTING_DEFINITIONS.glassTint.schema,
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse(
  Object.fromEntries(
    SETTING_DEFINITION_LIST.map((definition) => [definition.key, definition.defaultValue]),
  ),
);

export interface SettingsChangeLogEntry {
  at: string;
  change: string;
}
