const DEFAULT_LOCK_TTL_MS = 300_000;
let devLocalLock = false;

function requestBackground(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || "Background unavailable"));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function makeOwner(label) {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${label}:${Date.now()}:${random[0].toString(16)}${random[1].toString(16)}`;
}

export async function withSigningLock(label, fn, ttlMs = DEFAULT_LOCK_TTL_MS) {
  const owner = makeOwner(label);
  const ttl = Number(ttlMs) || DEFAULT_LOCK_TTL_MS;
  const res = await requestBackground({
    type: "SIGNING_LOCK_ACQUIRE",
    owner,
    label,
    ttlMs: ttl,
  });
  if (!res && chrome.runtime?.id === "nice-try-dev-mock") {
    if (devLocalLock) {
      throw new Error("Another signing request is already in progress");
    }
    devLocalLock = true;
    try {
      return await fn();
    } finally {
      devLocalLock = false;
    }
  }
  if (!res?.ok) {
    throw new Error(res?.error || "Another signing request is already in progress");
  }
  const renewEveryMs = Math.max(10_000, Math.min(60_000, Math.floor(ttl / 3)));
  let lost=false;
  const assertLock=()=>{if(lost)throw Error('The signing lock expired. Review the transaction again.');};
  const renewTimer = setInterval(() => {
    requestBackground({
      type: "SIGNING_LOCK_RENEW",
      owner,
      ttlMs: ttl,
    }).then(result=>{if(!result?.ok)lost=true;}).catch(() => {lost=true;});
  }, renewEveryMs);
  try {
    return await fn(assertLock);
  } finally {
    clearInterval(renewTimer);
    try {
      await requestBackground({ type: "SIGNING_LOCK_RELEASE", owner });
    } catch {
      /* The background lock also has a TTL. */
    }
  }
}
