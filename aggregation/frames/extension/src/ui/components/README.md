# Wallet interface components

`onboarding/` contains wallet creation, import and recovery-phrase views.
`popup/` contains account, asset, approval and transaction views. `common/`
contains shared components used by both entry points.

Components read state through `src/ui/hooks` and use the design tokens in
`src/ui/styles/theme.css`. Routing starts in `src/popup/App.jsx` and
`src/onboarding/App.jsx`. Keep native frame signing and RPC behavior in the
transaction and native-frame modules rather than embedding it in components.
