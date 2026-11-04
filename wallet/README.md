# Pocket Wallet

A mobile-first digital wallet in plain HTML, CSS and JavaScript, with no build step and no backend.

Open `wallet/index.html` through any static server, for example `python3 -m http.server` from the `wallet/` folder. On an iPhone, open it in Safari and choose **Share → Add to Home Screen** to run it full screen.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell: wallet view, empty state, the add, detail and edit sheets, confirmation dialog, toast and icon sprite |
| `styles.css` | Design tokens with light and dark themes, card visuals, sheets and controls |
| `app.js` | State, storage, validation, rendering, gestures and demo transactions |

## Features

- A horizontally swipeable card carousel with snap scrolling, depth scaling, page dots and arrow-key support.
- Card visuals with eight finishes, a chip, a contactless mark, the network mark (Visa, Mastercard, Amex, Discover, Diners, JCB, UnionPay), the cardholder, a masked number and the expiry date.
- An Add Card sheet:
  - live card preview that flips to the back while the CVV field has focus
  - brand detection and brand-specific formatting (Amex 4-6-5)
  - Luhn check, length, expiry and CVV validation, plus duplicate detection
- A card detail sheet that opens with a shared-element animation and has three tabs:
  - **Transactions:** searchable and grouped by day
  - **Card Info**
  - **Settings:** rename, colour, default card, remove
- An Edit Cards sheet for drag-to-reorder (or arrow keys on the handle) and choosing the default card.
- Card search by label, cardholder, network, colour or last 4 digits.
- Light and dark mode, safe-area aware, reduced-motion support, and layouts down to 320px wide.

## Security: demo mode

No payment provider is configured, so the app runs in a clearly labelled **demo mode**:

- **Full card number and CVV:** these exist only in the form inputs while you type. They are validated and then cleared. They are never saved, never added to the card object and never sent anywhere.
- **What gets saved:** only display metadata (`id, brand, last4, holder, exp, nickname, theme, addedAt`), in `localStorage` on this device. On load, stored data passes through a sanitizer that drops any other field.
- **Enrollment and payments:** no card is enrolled with an issuer and the app makes no payments. It does not claim NFC or Apple Pay support.
- **Transactions:** the history is generated sample data and is labelled as such.

### Going to production

To enroll real cards, collect card data in a PCI-compliant provider's hosted fields (for example Stripe Elements, Adyen or Braintree). Store only the token the provider returns, together with this same display metadata. Apple Pay provisioning needs Apple's In-App Provisioning entitlement and a native iOS app; a web page cannot add cards to Apple Wallet.
