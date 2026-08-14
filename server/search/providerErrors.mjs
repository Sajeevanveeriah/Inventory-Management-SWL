export class ProviderTimeoutError extends Error {
  constructor() {
    super('Provider request timed out');
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderQuotaError extends Error {
  constructor() {
    super('Provider quota exhausted');
    this.name = 'ProviderQuotaError';
  }
}

export class ProviderRequestError extends Error {
  constructor(detail) {
    super(`Provider request failed: ${detail}`);
    this.name = 'ProviderRequestError';
  }
}

export class ProviderSelectionExpiredError extends Error {
  constructor() {
    super('The selected product is no longer available in this search session');
    this.name = 'ProviderSelectionExpiredError';
  }
}
