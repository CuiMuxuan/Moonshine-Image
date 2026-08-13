export const APP_UPDATE_CHANNELS = Object.freeze(["test", "stable"]);
export const DEFAULT_APP_UPDATE_CHANNEL = "stable";
export const DEFAULT_APP_UPDATE_BASE_URL = "https://download.moonshine.email/app/win-x64";

export function normalizeAppUpdateChannel(value, { fallback = DEFAULT_APP_UPDATE_CHANNEL } = {}) {
  const channel = String(value ?? "").trim().toLowerCase() || fallback;
  if (!APP_UPDATE_CHANNELS.includes(channel)) {
    throw new Error(`Unsupported app update channel: ${channel}`);
  }
  return channel;
}

export function normalizeAppUpdateBaseUrl(value = DEFAULT_APP_UPDATE_BASE_URL) {
  const rawValue = String(value ?? "").trim() || DEFAULT_APP_UPDATE_BASE_URL;
  const parsed = new URL(rawValue);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("App update base URL must be a credential-free HTTP(S) URL");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function buildAppUpdateFeedUrl(channel, { baseUrl = DEFAULT_APP_UPDATE_BASE_URL } = {}) {
  return `${normalizeAppUpdateBaseUrl(baseUrl)}/${normalizeAppUpdateChannel(channel)}/`;
}
