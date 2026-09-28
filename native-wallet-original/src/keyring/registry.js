import { HdKeyring } from "./HdKeyring.js";
import { WatchKeyring } from "./WatchKeyring.js";

export const KEYRING_TYPES = {
  [HdKeyring.type]: HdKeyring,
  [WatchKeyring.type]: WatchKeyring,
};
