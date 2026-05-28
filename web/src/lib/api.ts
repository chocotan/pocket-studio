export async function postJSON<T>(url: string, body: any): Promise<T> {
  // Resolve host properly for API connection (relative to window location or port 18080)
  const host = window.location.host ? "" : "http://localhost:18080";
  const res = await fetch(`${host}${url}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}
