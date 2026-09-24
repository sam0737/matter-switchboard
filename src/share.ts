/** Matter enhanced commissioning windows are 3–15 minutes. */
export const SHARE_TIMEOUT_MIN_SECONDS = 180;
export const SHARE_TIMEOUT_MAX_SECONDS = 900;
export const SHARE_TIMEOUT_DEFAULT_SECONDS = 180;

export interface ShareWindow {
  manualPairingCode: string;
  qrPairingCode: string;
  timeoutSeconds: number;
  expiresAt: string;
}

const timeoutError = `Sharing window must be an integer from ${SHARE_TIMEOUT_MIN_SECONDS} through ${SHARE_TIMEOUT_MAX_SECONDS} seconds`;

/** Duration of a multi-admin sharing window. Omitted input uses the default. */
export function shareTimeoutSeconds(value?: unknown): number {
  let seconds = value;
  if (seconds === undefined) return SHARE_TIMEOUT_DEFAULT_SECONDS;
  if (typeof seconds === "string") {
    if (!/^\d+$/.test(seconds)) throw new Error(timeoutError);
    seconds = Number(seconds);
  }
  if (
    typeof seconds !== "number" ||
    !Number.isSafeInteger(seconds) ||
    seconds < SHARE_TIMEOUT_MIN_SECONDS ||
    seconds > SHARE_TIMEOUT_MAX_SECONDS
  ) {
    throw new Error(timeoutError);
  }
  return seconds;
}
