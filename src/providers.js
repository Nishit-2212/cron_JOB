import { config, drivesTarget } from "./config.js";
import { fetchJson, fetchText, sleep } from "./http.js";
import { findCity, formatSalary, isOpenToCountry, mentionsRemote, parseDate, parseRelativeDate, stripHtml } from "./matching.js";

/**
 * Each provider returns { name, intervalMs, searches: [{ target, run }] } or null when not configured.
 * `target` is the configured location the search is for; `run()` resolves to normalized jobs:
 * { title, company, location, url, source, postedAt, salary, description (full text), summary?,
 *   levels? (seniority labels from the job board), region? (extra location text), remoteEligible? }
 * Searches of one provider run one after another (intervalMs apart) to respect rate limits.
 */
export function getProviders() {
  return [adzuna(), jooble(), serpApi(), himalayas(), jobicy(), offCampusJobs4u()].filter(Boolean);
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
          region: (job.location?.area || []).join(", "),
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
          summary: stripHtml(job.excerpt),
          description: stripHtml(job.description || job.excerpt),
          levels: job.seniority || [],
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
          summary: stripHtml(job.jobExcerpt),
          description: stripHtml(job.jobDescription || job.jobExcerpt),
          levels: job.jobLevel ? [job.jobLevel] : [],
          remoteEligible: isOpenToCountry(job.jobGeo, target.place)
        }));
      }
    }))
  };
}

const OFFCAMPUS_FEED = "https://offcampusjobs4u.com/feed/";
const OFFCAMPUS_MAX_PAGES = 5;

// Fresher off-campus drives posted on offcampusjobs4u.com, read from its public RSS feed.
// The feed holds 10 posts (about a day's worth), so older pages are read until the posts
// fall outside FRESH_HOURS. Only IT/Software posts are kept.
function offCampusJobs4u() {
  if (!drivesTarget) {
    return null;
  }

  return {
    name: "OffCampusJobs4u",
    intervalMs: 0,
    searches: [{
      target: drivesTarget,
      run: async () => {
        const cutoff = Date.now() - config.freshHours * 3_600_000;
        const items = [];

        for (let page = 1; page <= OFFCAMPUS_MAX_PAGES; page++) {
          let xml;
          try {
            xml = await fetchText(page === 1 ? OFFCAMPUS_FEED : `${OFFCAMPUS_FEED}?paged=${page}`, {
              headers: { Accept: "application/rss+xml" }
            });
          } catch (error) {
            if (page === 1) {
              throw error;
            }
            break; // Past the last page (404) - keep what we have.
          }

          const pageItems = parseRssItems(xml);
          items.push(...pageItems);
          const oldest = parseDate(pageItems.at(-1)?.pubDate);
          if (!oldest || oldest.getTime() < cutoff) {
            break;
          }
          await sleep(1000);
        }

        return items
          .filter((item) => item.categories.some((category) => /it\/software|software engineer|developer/i.test(category)))
          .map((item) => {
            const { company, role, location, salary } = parseDriveTitle(item.title);
            return {
              title: role ? `${role} – ${company}` : item.title,
              company,
              location,
              url: item.link,
              source: "OffCampusJobs4u",
              postedAt: parseDate(item.pubDate),
              salary,
              description: stripHtml(item.content || item.description),
              summary: stripHtml(item.description),
              curated: true
            };
          });
      }
    }]
  };
}

function parseRssItems(xml) {
  const field = (item, tag) => {
    const match = item.match(new RegExp(String.raw`<${tag}[^>]*>([\s\S]*?)</${tag}>`));
    return match ? match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim() : "";
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
    title: stripHtml(field(item, "title")),
    link: field(item, "link"),
    pubDate: field(item, "pubDate"),
    description: field(item, "description"),
    content: field(item, "content:encoded"),
    categories: [...item.matchAll(/<category>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/g)].map(([, category]) => category.trim())
  }));
}

// "Cisco Recruitment 2026 – Software Engineer | Bangalore | C/C++ & Python"
//   -> { company: "Cisco", role: "Software Engineer", location: "Bangalore", salary: "" }
function parseDriveTitle(title) {
  const [head, ...segments] = title.split("|").map((part) => part.trim());
  const [lead, ...roleParts] = head.split(/\s+[–—-]\s+/);
  const company = lead.split(/\s+(?:off\s*campus|recruitment|hiring|careers?|walk-?in|internship|jobs?)\b/i)[0].trim() || lead;
  const salary = segments.find((part) => /lpa|₹|ctc|stipend/i.test(part)) || "";
  const city = findCity(title, config.locations.filter((location) => !location.remote));
  const location = city?.label
    || segments.find((part) => part !== salary && !/batch|years?|fresher|&\s*python|\/|skills?/i.test(part) && /^[A-Za-z ,&()]+$/.test(part))
    || "India";
  return { company, role: roleParts.join(" – ").trim(), location, salary };
}
