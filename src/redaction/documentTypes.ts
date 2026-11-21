/**
 * Owner decision (devdogfish/quantself#698, 2026-11-20): these types never leave the Vault, even redacted.
 * Anything not explicitly exportable is treated as Vault-only.
 */
export const vaultOnlyDocumentTypes = [
  'passport', 'drivers-licence', 'national-id', 'sin-ssn-card', 'pr-visa-document',
  'tax-return', 'tax-slip', 'tax-assessment',
  'medical-record', 'health-record'
] as const

export const exportableDocumentTypes = [
  'bank-statement', 'invoice', 'receipt', 'contract', 'lease', 'insurance-policy', 'utility-bill',
  'correspondence', 'employment-record', 'school-record', 'travel-booking'
] as const

export type DocumentType = typeof vaultOnlyDocumentTypes[number] | typeof exportableDocumentTypes[number]

const exportable: ReadonlySet<string> = new Set(exportableDocumentTypes)

export class VaultOnlyDocumentError extends Error {
  constructor() {
    super('This document type stays in the Vault and cannot be prepared for export.')
  }
}

/** Unknown, missing and Vault-only types all fail closed. */
export function isExportableDocumentType(value: unknown): value is typeof exportableDocumentTypes[number] {
  return typeof value === 'string' && exportable.has(value)
}
