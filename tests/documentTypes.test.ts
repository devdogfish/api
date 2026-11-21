import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputeAdmission } from '../src/computeAdmission'
import { exportableDocumentTypes, isExportableDocumentType, vaultOnlyDocumentTypes, VaultOnlyDocumentError } from '../src/redaction/documentTypes'
import { createPrivatePdfReview } from '../src/redaction/privatePdfReview'

describe('Vault-only document types', () => {
  test('only explicitly exportable types may leave the Vault', () => {
    for (const type of exportableDocumentTypes) expect(isExportableDocumentType(type)).toBe(true)
    for (const type of vaultOnlyDocumentTypes) expect(isExportableDocumentType(type)).toBe(false)
    for (const type of [undefined, null, '', 'other', 'unknown', 'Bank-Statement', 'tax_return', 7]) {
      expect(isExportableDocumentType(type)).toBe(false)
    }
  })

  test('the two lists do not overlap', () => {
    const vaultOnly = new Set<string>(vaultOnlyDocumentTypes)
    expect(exportableDocumentTypes.filter(type => vaultOnly.has(type))).toEqual([])
  })

  test('review refuses Vault-only and unknown types before any work', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'girke-doc-types-'))
    const review = createPrivatePdfReview(new ComputeAdmission(), scratch, '/nonexistent/python')
    const base = { pdf: new Uint8Array([37, 80, 68, 70]), identifiers: ['Fictional Anchor'], safeTextByPage: [['public']] }
    for (const documentType of ['tax-return', 'medical-record', 'passport', 'mystery']) {
      await expect(review.prepare({ ...base, documentType } as never)).rejects.toBeInstanceOf(VaultOnlyDocumentError)
    }
    expect(await readdir(scratch)).toEqual([])
  })
})
