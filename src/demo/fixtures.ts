/**
 * Synthetic demonstration data. Every product, code and price below is
 * FICTIONAL and clearly labelled as such — "Fictionville" products exist only
 * for evaluating this application before genuine exports are available.
 *
 * The demo deliberately exercises every status:
 *   FIC-001  unchanged
 *   FIC-002  supplier price increase
 *   FIC-003  supplier price decrease
 *   FIC-004  new item (absent from ServiceM8)
 *   FIC-900  missing from supplier (present only in ServiceM8)
 *   FIC-005  duplicate supplier identifier (two rows)
 *   FIC-006  ambiguous description match (near-identical description, new code)
 *   FIC-007  missing cost (invalid)
 *   FIC-008  invalid currency text (invalid)
 *   00123    identifier with leading zeroes (price change)
 *   FIC-010  potential formula injection in description (flagged + neutralised)
 *   ALIAS-11 matched only through the demo approved alias -> FIC-011
 *   FIC-012  price change the operator will typically exclude in the demo
 */

export const DEMO_SUPPLIER_CSV = `Product Code,Product Name,Trade Price
FIC-001,Fictionville Brass Padlock 40mm (DEMO),12.50
FIC-002,Fictionville Deadbolt Set Chrome (DEMO),48.00
FIC-003,Fictionville Key Blank K-77 (DEMO),1.80
FIC-004,Fictionville Smart Keypad Lock (DEMO),189.00
FIC-005,Fictionville Hinge Bolt Pair (DEMO),9.40
FIC-005,Fictionville Hinge Bolt Pair Bulk (DEMO),8.90
FIC-006,Fictionville Euro Cylinder 70mm Nickel (DEMO),24.60
FIC-007,Fictionville Door Closer Silver (DEMO),
FIC-008,Fictionville Window Latch White (DEMO),about $4
00123,Fictionville Padbolt Galvanised 150mm (DEMO),7.25
FIC-010,=HYPERLINK("https://example.invalid")+Fictionville Cam Lock (DEMO),5.10
ALIAS-11,Fictionville Rim Lock Antique (DEMO),33.00
FIC-012,Fictionville Mortice Lock 3-Lever (DEMO),27.80
`;

export const DEMO_SERVICEM8_CSV = `Item Number,Item Description,Cost,Sell Price
FIC-001,Fictionville Brass Padlock 40mm (DEMO),12.50,16.25
FIC-002,Fictionville Deadbolt Set Chrome (DEMO),45.00,58.50
FIC-003,Fictionville Key Blank K-77 (DEMO),2.10,2.73
FIC-011,Fictionville Rim Lock Antique (DEMO),30.00,39.00
00123,Fictionville Padbolt Galvanised 150mm (DEMO),6.80,8.84
FIC-060,Fictionville Euro Cylinder 70mm Nickel (DEMO),23.00,29.90
FIC-900,Fictionville Legacy Door Viewer (DEMO),4.20,5.46
FIC-012,Fictionville Mortice Lock 3-Lever (DEMO),25.00,32.50
`;

/** Demo alias approved "previously": supplier ALIAS-11 -> ServiceM8 FIC-011. */
export const DEMO_ALIAS = { supplierCode: 'ALIAS-11', itemNumber: 'FIC-011' };

export const DEMO_SUPPLIER_FILENAME = 'DEMO-fictionville-supplier-price-list.csv';
export const DEMO_SERVICEM8_FILENAME = 'DEMO-fictionville-servicem8-export.csv';
export const DEMO_PROFILE_NAME = 'Fictionville demo (synthetic data)';

export function demoSupplierFile(): File {
  return new File([DEMO_SUPPLIER_CSV], DEMO_SUPPLIER_FILENAME, { type: 'text/csv' });
}

export function demoServicem8File(): File {
  return new File([DEMO_SERVICEM8_CSV], DEMO_SERVICEM8_FILENAME, { type: 'text/csv' });
}
