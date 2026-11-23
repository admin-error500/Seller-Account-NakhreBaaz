# NAKHREBAAZ Seller Hub

Independent React/Vite seller dashboard for Meesho, Flipkart, Amazon and direct sales. The existing NAKHREBAAZ storefront is not connected or changed.

## Run

```bash
npm install
npm run dev
npm run build
```

## Deploy

Deploy as a separate Vite project to Vercel, Netlify or other static hosting. Set the custom domain to `seller.nakhrebaaz.com` and configure DNS according to the host's instructions. No deployment has been performed.

## Features

Manual SKU/size/color inventory, purchases, sales, sellable/damaged returns, raw materials, material purchases, blank-to-printed production, expenses, settlements, CSV exports, JSON backup/restore.

## Important

This is a localStorage-only prototype with **no server-side authentication, cloud database, marketplace API/CSV import or automated order synchronization**. Do not use it as a publicly exposed production accounting system or rely on the cash movement estimate as net profit. Back up your data frequently. Do not store secrets or marketplace credentials in the frontend.
