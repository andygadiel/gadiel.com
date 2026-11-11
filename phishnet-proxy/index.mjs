// Proxy for the Phish.net v5 API, deployed as an AWS Lambda Function URL.
// The Function URL config handles the CORS headers. This code exposes a single
// fixed route, GET /latest, which returns the setlist rows for the most recent
// Phish show. The API key is sent server-side in the X-API-KEY header and is
// never reachable for arbitrary endpoints.

const API = "https://api.phish.net/v5";
const USER_AGENT = "gadiel.com/1.0 (andygadiel@gmail.com)";
const CACHE_MS = 5 * 60 * 1000;

let cache = { at: 0, body: null };

async function phishnet(path) {
  const res = await fetch(`${API}/${path}`, {
    headers: {
      "X-API-KEY": process.env.PHISHNET_API_KEY,
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) throw new Error(`phish.net HTTP ${res.status}`);
  const json = await res.json();
  if (json.error !== false) throw new Error(`phish.net error: ${json.error_message}`);
  return json.data;
}

async function latestShow() {
  const [row] = await phishnet("setlists/artistid/1.json?order_by=showdate&direction=desc&limit=1");
  if (!row) return [];
  const rows = await phishnet(`setlists/showid/${row.showid}.json`);
  return rows.sort((a, b) => a.position - b.position);
}

function respond(statusCode, payload, cacheControl = "no-store") {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": cacheControl },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method !== "GET" || event.rawPath !== "/latest") {
    return respond(404, { error: true, error_message: "not found", data: [] });
  }

  if (cache.body && Date.now() - cache.at < CACHE_MS) {
    return respond(200, cache.body, "public, max-age=300");
  }

  try {
    const data = await latestShow();
    cache = { at: Date.now(), body: JSON.stringify({ error: false, error_message: "", data }) };
    return respond(200, cache.body, "public, max-age=300");
  } catch (err) {
    console.error(err);
    if (cache.body) return respond(200, cache.body, "public, max-age=60");
    return respond(502, { error: true, error_message: "upstream unavailable", data: [] });
  }
};
