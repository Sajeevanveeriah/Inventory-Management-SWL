/**
 * Synthetic demonstration data. Every product, code and price below is
 * FICTIONAL and clearly labelled as such - "Fictionville" products exist only
 * for evaluating this application before genuine exports are available.
 *
 * Both files mirror the SHAPE of the real thing: the supplier side carries
 * currency-formatted prices, a barcode column and a price-on-application
 * marker; the ServiceM8 side is the genuine nine-column Materials & Services
 * contract, including its per-row tax basis. Working through the demo
 * therefore rehearses the real import exactly.
 *
 * The demo deliberately exercises every status and hazard:
 *   FIC-001  unchanged (proposed price already correct)
 *   FIC-002  price change on a GST-EXCLUSIVE ServiceM8 row
 *   FIC-003  price change on a GST-INCLUSIVE ServiceM8 row
 *   FIC-004  new item (absent from ServiceM8)
 *   FIC-005  duplicate supplier rows that AGREE - folded into one proposal
 *   FIC-009  duplicate supplier rows that DISAGREE on cost - blocked
 *   FIC-006  ambiguous description match (near-identical description, new code)
 *   FIC-007  missing cost (invalid)
 *   FIC-008  invalid currency text (invalid)
 *   FIC-013  price on application (invalid, with its own explanation)
 *   00123    identifier with leading zeroes (price change)
 *   FIC-010  potential formula injection in description (flagged)
 *   ALIAS-11 matched only through the demo approved alias -> FIC-011
 *   FIC-012  price change the operator will typically exclude in the demo
 *   FIC-900  missing from supplier (present only in ServiceM8)
 *   9.4E+12  a ServiceM8 identifier already destroyed by a spreadsheet
 */

export const DEMO_SUPPLIER_CSV = `Product Code,Description,Brand Code,Category,Barcode,Item Price,Retail Price Incl GST
FIC-001,Fictionville Brass Padlock 40mm (DEMO),FV,Padlocks,9300000000017,$12.50,$21.95
FIC-002,Fictionville Deadbolt Set Chrome (DEMO),FV,Deadbolts,9300000000024,$48.00,$79.95
FIC-003,Fictionville Key Blank K-77 (DEMO),FV,Key Blanks,9300000000031,$1.80,$3.95
FIC-004,Fictionville Smart Keypad Lock (DEMO),FV,Electronic,9300000000048,$189.00,$349.00
FIC-005,Fictionville Hinge Bolt Pair (DEMO),FV,Door Hardware,9300000000055,$9.40,$17.95
FIC-005,Fictionville Hinge Bolt Pair (DEMO),FV,Security Hardware,9300000000055,$9.40,$17.95
FIC-009,Fictionville Sash Fastener (DEMO),FV,Window Hardware,9300000000093,$9.40,$17.95
FIC-009,Fictionville Sash Fastener Bulk (DEMO),FV,Window Hardware,9300000000093,$8.90,$16.95
FIC-006,Fictionville Euro Cylinder 70mm Nickel (DEMO),FV,Cylinders,9300000000062,$24.60,$44.95
FIC-007,Fictionville Door Closer Silver (DEMO),FV,Closers,9300000000079,,
FIC-008,Fictionville Window Latch White (DEMO),FV,Window Hardware,9300000000086,about $4,$8.95
FIC-013,Fictionville Restricted Master Key (DEMO),FV,Restricted,,P.O.A.,P.O.A.
00123,Fictionville Padbolt Galvanised 150mm (DEMO),FV,Bolts,9300000001236,$7.25,$13.95
FIC-010,"=HYPERLINK(""https://example.invalid"")+Fictionville Cam Lock (DEMO)",FV,Cam Locks,9300000000109,$5.10,$9.95
ALIAS-11,Fictionville Rim Lock Antique (DEMO),FV,Rim Locks,9300000000116,$33.00,$59.95
FIC-012,"Fictionville Mortice Lock, 3-Lever (DEMO)",FV,Mortice Locks,9300000000123,$27.80,$49.95
`;

export const DEMO_SERVICEM8_CSV = `Item Number,Name,Purchase Cost,Quantity In Stock,Price,Price Includes Taxes,Tax Rate,Item is Inventoried,Barcode
FIC-001,Fictionville Brass Padlock 40mm (DEMO),12.50,0,16.25,No,GST on Income,No,9300000000017
FIC-002,Fictionville Deadbolt Set Chrome (DEMO),0,0,58.50,No,GST on Income,No,
FIC-003,Fictionville Key Blank K-77 (DEMO),0,0,2.73,Yes,GST on Income,No,
FIC-005,Fictionville Hinge Bolt Pair (DEMO),0,0,12,No,GST on Income,No,
FIC-011,Fictionville Rim Lock Antique (DEMO),30.00,0,39,No,GST on Income,No,
00123,Fictionville Padbolt Galvanised 150mm (DEMO),6.80,0,8.84,No,GST on Income,No,
FIC-060,Fictionville Euro Cylinder 70mm Nickel (DEMO),23.00,0,29.90,No,GST on Income,No,
FIC-900,Fictionville Legacy Door Viewer (DEMO),4.20,0,5.46,Yes,,No,
FIC-012,"Fictionville Mortice Lock, 3-Lever (DEMO)",25.00,0,32.50,No,GST on Income,No,
9.4E+12,Fictionville Cabinet Lock (DEMO),0,0,11.95,No,GST on Income,No,9.3E+12
`;

/** Demo alias approved "previously": supplier ALIAS-11 -> ServiceM8 FIC-011. */
export const DEMO_ALIAS = { supplierCode: "ALIAS-11", itemNumber: "FIC-011" };

/** Column mapping matching DEMO_SUPPLIER_CSV. */
export const DEMO_SUPPLIER_MAPPING = {
  supplierCode: 0,
  supplierDescription: 1,
  supplierCategory: 3,
  supplierBarcode: 4,
  supplierCost: 5,
} as const;

/** Column mapping matching DEMO_SERVICEM8_CSV (the ServiceM8 contract order). */
export const DEMO_SERVICEM8_MAPPING = {
  itemNumber: 0,
  itemDescription: 1,
  existingCost: 2,
  quantityInStock: 3,
  existingSellPrice: 4,
  priceIncludesTaxes: 5,
  taxRate: 6,
  itemIsInventoried: 7,
  barcode: 8,
} as const;

export const DEMO_SUPPLIER_FILENAME =
  "DEMO-fictionville-supplier-price-list.csv";
export const DEMO_SERVICEM8_FILENAME = "DEMO-fictionville-servicem8-export.csv";
export const DEMO_PROFILE_NAME = "Fictionville demo (synthetic data)";

export function demoSupplierFile(): File {
  return new File([DEMO_SUPPLIER_CSV], DEMO_SUPPLIER_FILENAME, {
    type: "text/csv",
  });
}

export function demoServicem8File(): File {
  return new File([DEMO_SERVICEM8_CSV], DEMO_SERVICEM8_FILENAME, {
    type: "text/csv",
  });
}
