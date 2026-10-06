const USER_AGENT = "daily-job-mailer/2.0 (+https://github.com/Nishit-2212/cron_JOB)";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const fetchText = (url, options = {}) => fetchJson(url, { ...options, as: "text" });

// fetch() with a timeout and retries for network errors, 429 and 5xx responses.
export async function fetchJson(url, { retries = 2, timeoutMs = 20_000, as = "json", ...options } = {}) {
  const host = new URL(url).hostname;

  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: { "User-Agent": USER_AGENT, Accept: as === "json" ? "application/json" : "*/*", ...options.headers },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      const reason = error.name === "TimeoutError" ? `timed out after ${timeoutMs / 1000}s` : error.message;
      throw new Error(`${reason} (${host})`);
    }

    if (response.ok) {
      return as === "json" ? response.json() : response.text();
    }

    const detail = await errorDetail(response);
    // An exhausted monthly quota comes back as 429 too, and retrying it only wastes time.
    const retryable = (response.status === 429 || response.status >= 500) && !/run out of searches/i.test(detail);
    if (retryable && attempt < retries) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") || "", 10);
      await sleep(Number.isNaN(retryAfter) ? backoff(attempt) : Math.min(retryAfter, 60) * 1000);
      continue;
    }
    throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""} (${host})`);
  }
}

function backoff(attempt) {
  return 1000 * 2 ** attempt + Math.random() * 500;
}

// The API's own error message, e.g. SerpApi's "Your account has run out of searches."
async function errorDetail(response) {
  try {
    const data = JSON.parse(await response.text());
    const message = data.error ?? data.message ?? data.display;
    return typeof message === "string" ? message.trim().slice(0, 200) : "";
  } catch {
    return "";
  }
}
