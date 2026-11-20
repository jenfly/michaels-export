# Michaels order export

A bookmarklet that downloads your Michaels Canada order history as a CSV, either all orders or a date range. This is an unofficial tool, not made by Michaels.

**Install page:** https://jenfly.github.io/michaels-export/ (update this if the repo name is different)

## Files

| File | What it is |
| --- | --- |
| `index.html` | Install page with the drag-to-bookmarks button and instructions |
| `michaels-export.js` | The export script. The bookmarklet loads it from GitHub Pages each time it runs. |

## How it works

1. The bookmarklet adds a `<script>` tag that loads `michaels-export.js` from this site. It adds `?t=<timestamp>` so the browser doesn't use a cached old copy.
2. The script opens a panel on the page (inside a shadow DOM, so it's unaffected by Michaels' CSS) with these options:
   - All orders, or a date range with presets (last 7/30 days, this month, last month, this year) or custom dates
   - A progress bar and a Cancel button
   - If you're not logged in or you're on the wrong site, only a message with a link to the order history page
3. It reads the login token from `localStorage.MIK_AUTH_TOKEN`, which the Michaels site sets when you log in. It then calls the same APIs the site uses:
   - Order list: `GET https://www.michaels.com/api/moh/search/order/buyer/list/page?...&pageNum=N&pageSize=10`
   - Order detail: `GET https://www.michaels.com/api/moh/order/v5.1/buyer/parentOrderList/single?parentOrderNumber=...`
   - Headers: `Authorization: Bearer <token>`, `lang: en_CA`, `region: CA`
4. It builds one CSV row per item and downloads the file. Order numbers, SKUs and coupon codes are written as `="..."` so spreadsheets keep them as text. Without that, 16-digit order numbers lose digits and codes lose their leading zeros. Multiple coupons are joined with ` | `.

## Deploy

1. Push `index.html` and `michaels-export.js` to `main`.
2. Settings → Pages → Source: **Deploy from a branch**, Branch: `main`, folder `/ (root)`.
3. Open the Pages URL and drag the button to your bookmarks bar.

Updates to `michaels-export.js` reach users the next time they click the bookmark, so no reinstall is needed. GitHub Pages can take a minute or two to publish a change.

## Notes

- The Michaels page CSP only sets `frame-ancestors`, so loading an outside script works. If Michaels ever restricts `script-src`, the loader will fail. The fallback is to put the whole script inside the bookmark.
- Michaels replaces `console.log` on its pages, so the script logs through a clean console taken from a hidden iframe.
- Privacy: the script contains no credentials or personal data. It runs in the user's own browser with their own session and sends nothing anywhere except Michaels' own API.
