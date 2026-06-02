// The ONE official StraVIBE backend — mirrors stravibe-npm-package/src/config.js.
// Hardcoded and non-overridable so a published build always reports to the
// official backend. The ingest endpoint and the device-auth flow both derive
// from this single base.
export const API_BASE = "https://stravibe.vercel.app";

export const INGEST_URL = `${API_BASE}/v1/import`;
export const authUrl = (path: string): string => `${API_BASE}/auth/cli/${path}`;

// Public leaderboard / dashboard, opened from the status-bar menu.
export const LEADERBOARD_URL = `${API_BASE}/leaderboard`;
