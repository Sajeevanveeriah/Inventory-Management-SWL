import { useMemo, useState } from 'react';
import { catalogueKindLabel, CATALOGUE_ITEM_KINDS, type ItemKind } from '../../core/catalogue';
import { centsToAud } from '../../core/liveSearch';
import { parseMoney } from '../../core/money';
import type {
  BrandRecord,
  CatalogueSupplier,
  PlatformError,
  SupplierOfferRecord,
} from '../../platform/contracts';
import { usePlatform } from '../../platform/context';
import { useAppDispatch, useAppState } from '../../state/store';
import { useActions } from '../../state/useActions';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState, Page } from './PageChrome';

type GstBasis = SupplierOfferRecord['gstBasis'];

function newId(prefix: string) {
  return prefix + '-' + globalThis.crypto.randomUUID();
}

function percentToHundredths(value: string): number | null | 'invalid' {
  if (value.trim() === '') return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) return 'invalid';
  const [whole = '0', decimal = ''] = value.split('.');
  const hundredths = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return hundredths <= 99_999 ? hundredths : 'invalid';
}

function hundredthsToPercent(value: number | null) {
  if (value === null) return '';
  const whole = Math.floor(value / 100);
  const decimal = String(value % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return decimal ? whole + '.' + decimal : String(whole);
}

function nowIso() {
  return new Date().toISOString();
}

export function SuppliersPage() {
  const state = useAppState();
  const platform = usePlatform();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const [message, setMessage] = useState('');
  const [productId, setProductId] = useState('');
  const [itemKind, setItemKind] = useState<ItemKind>('physical-product');
  const [productBrandId, setProductBrandId] = useState('');
  const [productMarkup, setProductMarkup] = useState('');
  const [productXeroReference, setProductXeroReference] = useState('');
  const [productServicem8Reference, setProductServicem8Reference] = useState('');
  const [productBarcodeGtin, setProductBarcodeGtin] = useState('');
  const [brandName, setBrandName] = useState('');
  const [brandMarkup, setBrandMarkup] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [supplierReference, setSupplierReference] = useState('');
  const [offerProductId, setOfferProductId] = useState('');
  const [offerSupplierId, setOfferSupplierId] = useState('');
  const [supplierSku, setSupplierSku] = useState('');
  const [offerCost, setOfferCost] = useState('');
  const [offerGstBasis, setOfferGstBasis] = useState<GstBasis>('unknown');
  const [validFrom, setValidFrom] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [preferred, setPreferred] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<SupplierOfferRecord | null>(null);

  const brandById = useMemo(
    () => new Map(state.brands.map((brand) => [brand.id, brand])),
    [state.brands],
  );
  const supplierById = useMemo(
    () => new Map(state.catalogueSuppliers.map((supplier) => [supplier.id, supplier])),
    [state.catalogueSuppliers],
  );
  const selectedOfferByProduct = useMemo(
    () =>
      new Map(state.offerSelections.map((selection) => [selection.productId, selection.offerId])),
    [state.offerSelections],
  );

  const refreshDomain = async () => {
    const [catalogue, brands, suppliers, offers, selections] = await Promise.all([
      platform.catalogue.list(),
      platform.brands.list(),
      platform.suppliers.list(),
      platform.offers.list(),
      platform.offers.listSelections(),
    ]);
    if (!catalogue.ok || !brands.ok || !suppliers.ok || !offers.ok || !selections.ok) {
      setMessage('The saved catalogue could not be refreshed.');
      return false;
    }
    dispatch({
      type: 'catalogue-domain-loaded',
      catalogueItems: catalogue.value,
      brands: brands.value,
      catalogueSuppliers: suppliers.value,
      supplierOffers: offers.value,
      offerSelections: selections.value,
      settingsAudit: state.settingsAudit,
      syncRuns: state.syncRuns,
      syncCheckpoints: state.syncCheckpoints,
      syncItemOutcomes: state.syncItemOutcomes,
    });
    return true;
  };

  const handleMutationFailure = async (error: PlatformError) => {
    if (error.code !== 'conflict') {
      setMessage(error.message);
      return;
    }
    if (await refreshDomain()) {
      const conflictMessage =
        'This record changed elsewhere. The latest saved version is shown. Review it before saving again.';
      setMessage(conflictMessage);
      actions.announce(conflictMessage);
    }
  };

  const chooseProduct = (id: string) => {
    setProductId(id);
    const item = state.catalogueItems.find((candidate) => candidate.id === id);
    if (!item) return;
    setItemKind(item.itemKind);
    setProductBrandId(item.brandId ?? '');
    setProductMarkup(item.markupOverridePercent ?? '');
    setProductXeroReference(item.xeroReference ?? '');
    setProductServicem8Reference(item.servicem8Reference ?? '');
    setProductBarcodeGtin(item.barcodeGtin ?? '');
  };

  const saveProduct = async () => {
    const item = state.catalogueItems.find((candidate) => candidate.id === productId);
    const parsedMarkup = percentToHundredths(productMarkup);
    if (!item || parsedMarkup === 'invalid') {
      setMessage('Choose a product and enter a markup from 0 to 999.99%.');
      return;
    }
    if (productBarcodeGtin !== '' && !/^\d{1,64}$/u.test(productBarcodeGtin)) {
      setMessage('Barcode or GTIN must contain 1 to 64 digits, or be left blank.');
      return;
    }
    const saved = await platform.productMetadata.update({
      productId: item.id,
      itemKind,
      brandId: productBrandId || null,
      markupOverridePercent: parsedMarkup === null ? null : hundredthsToPercent(parsedMarkup),
      xeroReference: productXeroReference.trim() || null,
      servicem8Reference: productServicem8Reference.trim() || null,
      barcodeGtin: productBarcodeGtin || null,
      updatedAt: nowIso(),
    });
    if (!saved.ok) {
      await handleMutationFailure(saved.error);
      return;
    }
    if (await refreshDomain()) {
      setMessage('Product rule saved. Product markup overrides brand and global markup.');
      actions.announce('Product pricing rule saved.');
    }
  };

  const saveBrand = async () => {
    const parsedMarkup = percentToHundredths(brandMarkup);
    if (brandName.trim().length < 2 || parsedMarkup === 'invalid') {
      setMessage('Enter a brand name and an optional markup from 0 to 999.99%.');
      return;
    }
    const existing = state.brands.find(
      (brand) => brand.name.toLocaleLowerCase() === brandName.trim().toLocaleLowerCase(),
    );
    const brand: BrandRecord = {
      id: existing?.id ?? newId('brand'),
      name: brandName.trim(),
      markupHundredths: parsedMarkup,
      updatedAt: nowIso(),
    };
    const saved = await platform.brands.save(brand);
    if (!saved.ok) {
      await handleMutationFailure(saved.error);
      return;
    }
    if (await refreshDomain()) {
      setBrandName('');
      setBrandMarkup('');
      setMessage('Brand saved. It applies only when a product has no markup of its own.');
      actions.announce('Brand saved.');
    }
  };

  const saveSupplier = async () => {
    if (supplierName.trim().length < 2) {
      setMessage('Enter a supplier name.');
      return;
    }
    const existing = state.catalogueSuppliers.find(
      (supplier) => supplier.name.toLocaleLowerCase() === supplierName.trim().toLocaleLowerCase(),
    );
    const supplier: CatalogueSupplier = {
      id: existing?.id ?? newId('supplier'),
      name: supplierName.trim(),
      active: true,
      externalReference: supplierReference.trim() || null,
      updatedAt: nowIso(),
    };
    const saved = await platform.suppliers.save(supplier);
    if (!saved.ok) {
      await handleMutationFailure(saved.error);
      return;
    }
    if (await refreshDomain()) {
      setSupplierName('');
      setSupplierReference('');
      setMessage('Supplier saved.');
      actions.announce('Supplier saved.');
    }
  };

  const saveOffer = async () => {
    const money = parseMoney(offerCost);
    if (!offerProductId || !offerSupplierId || supplierSku.trim() === '' || !money.ok) {
      setMessage(
        money.ok ? 'Choose a product and supplier and enter the supplier SKU.' : money.error,
      );
      return;
    }
    if (validFrom && validUntil && validUntil < validFrom) {
      setMessage('The offer end date cannot be before its start date.');
      return;
    }
    const existing = state.supplierOffers.find(
      (candidate) =>
        candidate.productId === offerProductId &&
        candidate.supplierId === offerSupplierId &&
        candidate.supplierSku === supplierSku.trim(),
    );
    const offer: SupplierOfferRecord = {
      id: existing?.id ?? newId('offer'),
      productId: offerProductId,
      supplierId: offerSupplierId,
      supplierSku: supplierSku.trim(),
      costCents: Number(money.amount.replace('.', '')),
      gstBasis: offerGstBasis,
      currency: 'AUD',
      active: true,
      isPreferred: preferred,
      validFrom: validFrom ? `${validFrom}T00:00:00.000Z` : null,
      validUntil: validUntil ? `${validUntil}T23:59:59.999Z` : null,
      provenanceType: 'manual',
      provenanceReference: null,
      observedAt: nowIso(),
    };
    const saved = await platform.offers.save(offer);
    if (!saved.ok) {
      await handleMutationFailure(saved.error);
      return;
    }
    if (await refreshDomain()) {
      setSupplierSku('');
      setOfferCost('');
      setValidFrom('');
      setValidUntil('');
      setPreferred(false);
      setMessage('Supplier offer saved. Select it explicitly before it is used for pricing.');
      actions.announce('Supplier offer saved.');
    }
  };

  const confirmSelection = async () => {
    if (!pendingSelection) return;
    const selected = await platform.offers.select({
      productId: pendingSelection.productId,
      offerId: pendingSelection.id,
      selectedBy: 'Operator',
      reason: 'Explicit selection in Products and suppliers',
      selectedAt: nowIso(),
    });
    if (!selected.ok) await handleMutationFailure(selected.error);
    else if (await refreshDomain()) {
      setMessage('Preferred offer selected for pricing. The supplier and SKU are recorded.');
      actions.announce('Preferred supplier offer selected.');
    }
    setPendingSelection(null);
  };

  const markupWarning =
    productMarkup !== '' &&
    percentToHundredths(productMarkup) !== 'invalid' &&
    Number(productMarkup) < 30;
  const brandMarkupWarning =
    brandMarkup !== '' &&
    percentToHundredths(brandMarkup) !== 'invalid' &&
    Number(brandMarkup) < 30;

  return (
    <Page
      title="Products and suppliers"
      lead="Keep product details, pricing rules and supplier offers together. Nothing is deleted here."
    >
      <section className="card">
        <h2>Product pricing rule</h2>
        {state.catalogueItems.length === 0 ? (
          <EmptyState
            title="No catalogue products yet"
            detail="Publish or migrate a catalogue item first. This page edits existing products and never creates an unpriced placeholder."
          />
        ) : (
          <>
            <div className="form-grid">
              <label>
                Product
                <select value={productId} onChange={(event) => chooseProduct(event.target.value)}>
                  <option value="">Choose a product</option>
                  {state.catalogueItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.itemNumber} - {item.description}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Item kind
                <select
                  value={itemKind}
                  onChange={(event) => setItemKind(event.target.value as ItemKind)}
                >
                  {CATALOGUE_ITEM_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {catalogueKindLabel(kind)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Brand
                <select
                  value={productBrandId}
                  onChange={(event) => setProductBrandId(event.target.value)}
                >
                  <option value="">No brand</option>
                  {state.brands.map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Product markup %
                <input
                  type="number"
                  min="0"
                  max="999.99"
                  step="0.01"
                  inputMode="decimal"
                  value={productMarkup}
                  onChange={(event) => setProductMarkup(event.target.value)}
                  placeholder={
                    'Blank uses brand, then global ' + state.settings.markupPercent + '%'
                  }
                />
              </label>
              <label>
                Xero item code
                <input
                  value={productXeroReference}
                  onChange={(event) => setProductXeroReference(event.target.value)}
                  maxLength={256}
                />
              </label>
              <label>
                ServiceM8 reference
                <input
                  value={productServicem8Reference}
                  onChange={(event) => setProductServicem8Reference(event.target.value)}
                  maxLength={256}
                />
              </label>
              <label>
                Barcode or GTIN
                <input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={productBarcodeGtin}
                  onChange={(event) => setProductBarcodeGtin(event.target.value)}
                  maxLength={64}
                />
              </label>
            </div>
            <p className="hint">
              Pricing order is exact: product markup, then brand markup, then global{' '}
              {state.settings.markupPercent}%. A typed 0% is preserved and is not treated as blank.
            </p>
            {markupWarning && (
              <p className="form-error" role="alert">
                This rule is below 30%. It can be saved, but the separate 30% publication floor
                still blocks an under-floor sell price.
              </p>
            )}
            <button type="button" className="btn btn-primary" onClick={() => void saveProduct()}>
              Save product rule
            </button>
            <div
              className="table-scroll"
              role="region"
              aria-label="Catalogue products"
              tabIndex={0}
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Brand</th>
                    <th scope="col">Markup source</th>
                    <th scope="col">Sell price GST basis</th>
                  </tr>
                </thead>
                <tbody>
                  {state.catalogueItems.map((item) => {
                    const brand = item.brandId ? brandById.get(item.brandId) : undefined;
                    const source =
                      item.markupOverridePercent !== null
                        ? 'Product ' + item.markupOverridePercent + '%'
                        : brand?.markupHundredths !== null && brand?.markupHundredths !== undefined
                          ? 'Brand ' + hundredthsToPercent(brand.markupHundredths) + '%'
                          : 'Global ' + state.settings.markupPercent + '%';
                    return (
                      <tr key={item.id}>
                        <td data-label="Product">
                          {item.itemNumber} - {item.description}
                        </td>
                        <td data-label="Kind">{catalogueKindLabel(item.itemKind)}</td>
                        <td data-label="Brand">{brand?.name ?? 'No brand'}</td>
                        <td data-label="Markup source">{source}</td>
                        <td data-label="Sell price GST basis">
                          {item.sellPriceGstBasis === 'inc-gst'
                            ? 'Includes GST'
                            : item.sellPriceGstBasis === 'ex-gst'
                              ? 'Excludes GST'
                              : 'Not confirmed'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>Brands</h2>
        <div className="form-grid">
          <label>
            Brand name
            <input value={brandName} onChange={(event) => setBrandName(event.target.value)} />
          </label>
          <label>
            Brand markup %
            <input
              type="number"
              min="0"
              max="999.99"
              step="0.01"
              inputMode="decimal"
              value={brandMarkup}
              onChange={(event) => setBrandMarkup(event.target.value)}
              placeholder={'Blank uses global ' + state.settings.markupPercent + '%'}
            />
          </label>
        </div>
        {brandMarkupWarning && (
          <p className="form-error" role="alert">
            This rule is below 30%. It remains explicit, while the separate publication floor
            remains 30%.
          </p>
        )}
        <button type="button" className="btn btn-primary" onClick={() => void saveBrand()}>
          Save brand
        </button>
        {state.brands.length > 0 && (
          <ul>
            {state.brands.map((brand) => (
              <li key={brand.id}>
                {brand.name}:{' '}
                {brand.markupHundredths === null
                  ? 'uses global markup'
                  : hundredthsToPercent(brand.markupHundredths) + '%'}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Suppliers</h2>
        <div className="form-grid">
          <label>
            Supplier name
            <input value={supplierName} onChange={(event) => setSupplierName(event.target.value)} />
          </label>
          <label>
            Supplier reference
            <input
              value={supplierReference}
              onChange={(event) => setSupplierReference(event.target.value)}
            />
          </label>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => void saveSupplier()}>
          Save supplier
        </button>
        {state.catalogueSuppliers.length > 0 && (
          <ul>
            {state.catalogueSuppliers.map((supplier) => (
              <li key={supplier.id}>
                {supplier.name}
                {supplier.externalReference ? ' - ' + supplier.externalReference : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Supplier offers</h2>
        <div className="form-grid">
          <label>
            Product
            <select
              value={offerProductId}
              onChange={(event) => setOfferProductId(event.target.value)}
            >
              <option value="">Choose a product</option>
              {state.catalogueItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.itemNumber} - {item.description}
                </option>
              ))}
            </select>
          </label>
          <label>
            Supplier
            <select
              value={offerSupplierId}
              onChange={(event) => setOfferSupplierId(event.target.value)}
            >
              <option value="">Choose a supplier</option>
              {state.catalogueSuppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Supplier SKU
            <input value={supplierSku} onChange={(event) => setSupplierSku(event.target.value)} />
          </label>
          <label>
            Cost (AUD)
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={offerCost}
              onChange={(event) => setOfferCost(event.target.value)}
            />
          </label>
          <label>
            Cost GST basis
            <select
              value={offerGstBasis}
              onChange={(event) => setOfferGstBasis(event.target.value as GstBasis)}
            >
              <option value="unknown">Not confirmed</option>
              <option value="ex-gst">Excludes GST</option>
              <option value="inc-gst">Includes GST</option>
            </select>
          </label>
          <label>
            Effective from
            <input
              type="date"
              value={validFrom}
              onChange={(event) => setValidFrom(event.target.value)}
            />
          </label>
          <label>
            Effective until
            <input
              type="date"
              value={validUntil}
              onChange={(event) => setValidUntil(event.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={preferred}
              onChange={(event) => setPreferred(event.target.checked)}
            />
            Supplier marks this as preferred
          </label>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => void saveOffer()}>
          Save offer
        </button>
      </section>

      {state.supplierOffers.length === 0 ? (
        <EmptyState
          title="No supplier offers"
          detail="Add an AUD offer with its supplier SKU, GST basis and effective dates. Pricing will not guess between offers."
        />
      ) : (
        <div className="table-scroll" role="region" aria-label="Supplier offers" tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Supplier</th>
                <th scope="col">Supplier SKU</th>
                <th scope="col">Cost</th>
                <th scope="col">GST basis</th>
                <th scope="col">Effective dates</th>
                <th scope="col">Pricing choice</th>
              </tr>
            </thead>
            <tbody>
              {state.supplierOffers.map((offer) => {
                const product = state.catalogueItems.find((item) => item.id === offer.productId);
                const selected = selectedOfferByProduct.get(offer.productId) === offer.id;
                return (
                  <tr key={offer.id}>
                    <td data-label="Product">{product?.itemNumber ?? offer.productId}</td>
                    <td data-label="Supplier">
                      {supplierById.get(offer.supplierId)?.name ?? offer.supplierId}
                    </td>
                    <td data-label="Supplier SKU">{offer.supplierSku}</td>
                    <td data-label="Cost">AUD {centsToAud(offer.costCents)}</td>
                    <td data-label="GST basis">
                      {offer.gstBasis === 'inc-gst'
                        ? 'Includes GST'
                        : offer.gstBasis === 'ex-gst'
                          ? 'Excludes GST'
                          : 'Not confirmed'}
                    </td>
                    <td data-label="Effective dates">
                      {offer.validFrom ?? 'Now'} to {offer.validUntil ?? 'No end date'}
                    </td>
                    <td data-label="Pricing choice">
                      {selected ? (
                        <span className="badge badge-unchanged">Selected</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setPendingSelection(offer)}
                        >
                          Select for pricing
                        </button>
                      )}
                      {offer.isPreferred && ' Supplier preferred'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {message && <p role="status">{message}</p>}

      <ConfirmDialog
        open={pendingSelection !== null}
        title="Select this supplier offer"
        body={
          pendingSelection
            ? 'Use ' +
              (supplierById.get(pendingSelection.supplierId)?.name ?? 'this supplier') +
              ' SKU ' +
              pendingSelection.supplierSku +
              ' at AUD ' +
              centsToAud(pendingSelection.costCents) +
              ' as the explicit pricing offer? This replaces the current selection and is recorded.'
            : ''
        }
        confirmLabel="Select offer"
        onConfirm={() => void confirmSelection()}
        onCancel={() => setPendingSelection(null)}
      />
    </Page>
  );
}
