import { config } from "./config.js";
import { fetchJson } from "./http.js";
import { formatSalary, isOpenToCountry, mentionsRemote, parseDate, parseRelativeDate, stripHtml } from "./matching.js";

/**
 * Each provider returns { name, intervalMs, searches: [{ target, run }] } or null when not configured.
 * `target` is the configured location the search is for; `run()` resolves to normalized jobs:
 * { title, company, location, url, source, postedAt, salary, description, remoteEligible? }
 * Searches of one provider run one after another (intervalMs apart) to respect rate limits.
 */
export function getProviders() {
  return [adzuna(), jooble(), serpApi(), himalayas(), jobicy()].filter(Boolean);
}

export function hasCityProvider() {
  const { adzunaAppId, adzunaAppKey, joobleApiKey, serpApiKey } = config.providers;
  return Boolean((adzunaAppId && adzunaAppKey) || joobleApiKey || serpApiKey);
}

const freshDays = () => Math.max(1, Math.ceil(config.freshHours / 24));

function keywordTargets(keywords = config.keywords, targets = config.locations) {
  return keywords.flatMap((keyword) => targets.map((target) => ({ keyword, target })));
}

// Free API key: https://developer.adzuna.com (India endpoint, 250 calls/day, 25/minute)
function adzuna() {
  const { adzunaAppId, adzunaAppKey } = config.providers;
  if (!adzunaAppId || !adzunaAppKey) {
    return null;
  }

  return {
    name: "Adzuna",
    intervalMs: 2600,
    searches: keywordTargets().map(({ keyword, target }) => ({
      target,
      run: async () => {
        const url = new URL("https://api.adzuna.com/v1/api/jobs/in/search/1");
        url.search = new URLSearchParams({
          app_id: adzunaAppId,
          app_key: adzunaAppKey,
          what: target.remote ? `${keyword} remote` : keyword,
          where: target.place,
          sort_by: "date",
          max_days_old: String(freshDays()),
          results_per_page: "50",
          "content-type": "application/json"
        });

        const data = await fetchJson(url);
        return (data.results || []).map((job) => ({
          title: stripHtml(job.title),
          company: job.company?.display_name || "Not specified",
          location: job.location?.display_name || target.place,
          url: job.redirect_url,
          source: "Adzuna",
          postedAt: parseDate(job.created),
          salary: adzunaSalary(job),
          description: stripHtml(job.description),
          remoteEligible: target.remote ? mentionsRemote(job.title, job.description, job.location?.display_name) : undefined
        }));
      }
    }))
  };
}

function adzunaSalary(job) {
  const salary = formatSalary(job.salary_min, job.salary_max, "INR", "year");
  return salary && String(job.salary_is_predicted) === "1" ? `${salary} (estimated)` : salary;
}

// Free API key: https://jooble.org/api/about
function jooble() {
  const { joobleApiKey } = config.providers;
  if (!joobleApiKey) {
    return null;
  }

  const since = new Date(Date.now() - config.freshHours * 3_600_000).toISOString().slice(0, 10);

  return {
    name: "Jooble",
    intervalMs: 700,
    searches: keywordTargets().map(({ keyword, target }) => ({
      target,
      run: async () => {
        const data = await fetchJson(`https://jooble.org/api/${joobleApiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keywords: target.remote ? `${keyword} remote` : keyword,
            location: target.place,
            datecreatedfrom: since,
            page: "1"
          })
        });

        return (data.jobs || []).map((job) => ({
          title: stripHtml(job.title),
          company: job.company || "Not specified",
          location: job.location || target.place,
          url: job.link,
          source: "Jooble",
          postedAt: parseDate(job.updated),
          salary: job.salary || "",
          description: stripHtml(job.snippet),
          remoteEligible: target.remote ? mentionsRemote(job.title, job.snippet, job.location, job.type) : undefined
        }));
      }
    }))
  };
}

// Google Jobs (includes LinkedIn/Naukri/Indeed postings). One search = one SerpApi credit.
function serpApi() {
  const { serpApiKey, serpApiKeywords } = config.providers;
  if (!serpApiKey) {
    return null;
  }

  return {
    name: "Google Jobs",
    intervalMs: 1000,
    searches: keywordTargets(serpApiKeywords).map(({ keyword, target }) => ({
      target,
      run: async () => {
        const url = new URL("https://serpapi.com/search.json");
        url.search = new URLSearchParams({
          engine: "google_jobs",
          q: target.remote ? keyword : `${keyword} ${target.place}`,
          location: target.remote ? target.place : "India",
          gl: "in",
          hl: "en",
          api_key: serpApiKey,
          ...(target.remote ? { ltype: "1" } : {})
        });

        const data = await fetchJson(url, { timeoutMs: 45_000 });
        if (data.error && !/hasn't returned any results/i.test(data.error)) {
          throw new Error(data.error);
        }

        return (data.jobs_results || []).map((job) => {
          const extensions = job.detected_extensions || {};
          const via = String(job.via || extensions.via || "").replace(/^via\s+/i, "");
          return {
            title: job.title,
            company: job.company_name || "Not specified",
            location: job.location || target.place,
            url: job.apply_options?.[0]?.link || job.share_link || "",
            source: via ? `Google Jobs (${via})` : "Google Jobs",
            postedAt: parseRelativeDate(extensions.posted_at),
            salary: extensions.salary || "",
            description: stripHtml(job.description),
            remoteEligible: target.remote ? true : undefined
          };
        });
      }
    }))
  };
}

// Remote jobs, no key needed: https://himalayas.app/api
function himalayas() {
  const targets = config.locations.filter((location) => location.remote);
  if (!targets.length) {
    return null;
  }

  return {
    name: "Himalayas",
    intervalMs: 500,
    searches: keywordTargets(config.keywords, targets).map(({ keyword, target }) => ({
      target,
      run: async () => {
        const url = new URL("https://himalayas.app/jobs/api/search");
        url.search = new URLSearchParams({ q: keyword, country: target.place, sort: "recent" });

        const data = await fetchJson(url);
        return (data.jobs || []).map((job) => ({
          title: job.title,
          company: job.companyName || "Not specified",
          location: `Remote (${job.locationRestrictions?.length ? job.locationRestrictions.join(", ") : "Worldwide"})`,
          url: job.applicationLink,
          source: "Himalayas",
          postedAt: parseDate(job.pubDate),
          salary: formatSalary(job.minSalary, job.maxSalary, job.currency, job.salaryPeriod),
          description: stripHtml(job.excerpt || job.description),
          remoteEligible: isOpenToCountry(job.locationRestrictions, target.place)
        }));
      }
    }))
  };
}

// Remote jobs, no key needed: https://jobicy.com/jobs-rss-feed (one call per remote location).
function jobicy() {
  const targets = config.locations.filter((location) => location.remote);
  if (!targets.length) {
    return null;
  }

  return {
    name: "Jobicy",
    intervalMs: 1000,
    searches: targets.map((target) => ({
      target,
      run: async () => {
        const data = await fetchJson("https://jobicy.com/api/v2/remote-jobs?count=100&geo=apac&industry=engineering");
        return (data.jobs || []).map((job) => ({
          title: stripHtml(job.jobTitle),
          company: job.companyName || "Not specified",
          location: `Remote (${job.jobGeo || "Anywhere"})`,
          url: job.url,
          source: "Jobicy",
          postedAt: parseDate(job.pubDate),
          salary: formatSalary(job.annualSalaryMin, job.annualSalaryMax, job.salaryCurrency, "year"),
          description: stripHtml(job.jobExcerpt),
          remoteEligible: isOpenToCountry(job.jobGeo, target.place)
        }));
      }
    }))
  };
}
