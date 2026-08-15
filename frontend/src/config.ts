export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");

// Leave the default empty so WebSocket clients derive the same-origin /api
// endpoint from API_BASE_URL. Set VITE_WS_BASE_URL only for an intentional
// external WebSocket backend.
export const WS_BASE_URL = (import.meta.env.VITE_WS_BASE_URL || "").replace(/\/$/, "");
