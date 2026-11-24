# NAKHREBAAZ Seller Hub

Seller dashboard for Meesho, Flipkart, Amazon and direct sales. This repository contains the Seller Hub.

## Run locally

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from the Seller Hub Supabase project in `.env.local`, then run:

```sh
npm ci
npm run dev
npm run build
```

## Purchase invoices

T-shirt, material and equipment purchases support multiple product or fee invoices. Enter actual cash or card payment independently of the invoices. Upload a PDF, JPG or PNG, or enter document details manually. The reader uses PDF text when available and runs Tesseract OCR in the browser for images and scanned pages. All OCR assets are served by the app. Review the extracted fields before saving. Automatic reading accepts files up to 10 MB and PDFs up to 20 pages. Unfamiliar layouts or low-quality scans can require manual entry.

Use **Add invoices** from an existing purchase to add documents without changing its stock quantity or unit price. Use **Verify** to complete a legacy invoice attachment whose totals were never recorded. The actual payment field is editable on that form. Legacy payments display the prior calculated amount as an estimate until confirmed.

| Status | Condition |
| --- | --- |
| Pending | No invoice amounts have been received |
| Partially received | Received invoices total less than the payment |
| Reconciled | Received invoices equal the payment |
| Mismatch | Received invoices exceed the payment |

Overview and Monthly Reports show purchase payments, invoice totals, documented GST, pending amounts and amounts above payment. The monthly figures are grouped by purchase date and update when invoices arrive. Historical recorded GST estimates are shown separately. Documented GST still requires review for input tax credit eligibility.

## Database rollout

Apply `supabase/migrations/20261124043313_smart_invoice_reconciliation.sql` to the existing Seller Hub Supabase schema before deploying this app version. The migration adds payment and revision columns and backfills duplicate detection from existing invoice metadata while preserving purchase records. It uses the existing purchase and material RLS policies and private `purchase-invoices` bucket. The production project uses email authentication and owner-scoped purchase data.

## Automated checks

```sh
npm test
npx playwright install chromium
npm run test:browser
npm run build
```

The browser tests use a mocked Supabase API and exercise the production build, PDF text extraction and local OCR. To test the migration on an empty, disposable PostgreSQL 17 database, apply these files in order with `psql -v ON_ERROR_STOP=1`:

1. `tests/invoice-migration-fixture.sql`
2. `supabase/migrations/20261124043313_smart_invoice_reconciliation.sql`
3. `tests/invoice-migration-test.sql`
