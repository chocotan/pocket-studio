export interface User {
  id: string;
  username: string;
  created_at: number;
}

export interface TokenRecord {
  id: string;
  name: string;
  prefix: string;
  value?: string;
  created_at: number;
  last_used_at?: number;
  revoked_at?: number;
}

export function formatTime(value?: number) {
  if (!value) return "";
  return new Date(value * 1000).toLocaleString();
}

export function studioLink(token: string) {
  const url = new URL("/studio/", window.location.origin);
  url.searchParams.set("server_url", window.location.origin);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.pathname + url.search;
}
