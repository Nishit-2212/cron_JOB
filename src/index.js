import { cities, config, validateEmailConfig } from "./config.js";
import { sendDigest } from "./email.js";
import { sleep } from "./http.js";
import { createTitleMatcher, findCity } from "./matching.js";
import { getProviders, hasCityProvider } from "./providers.js";
import { jobKeys, loadSeenStore } from "./seen-store.js";

async function main() {
  validateEmailConfig();

  const providers = getProviders();
  const seen = await loadSeenStore(config.seenJobsFile, config.seenJobsDays);
  console.log(`Searching ${providers.map((provider) => `${provider.name} (${provider.searches.length})`).join(", ")}; ${seen.size()} jobs remembered.`);

  // Providers run in parallel; searches within a provider run sequentially to stay under rate limits.
  const results = await Promise.all(providers.map(runProvider));
  const found = results.flatMap((result) => result.jobs);

  const isRelevant = createTitleMatcher(config.keywords, config.excludeKeywords);
  const cutoff = Date.now() - config.freshHours * 3_600_000;
  const inRun = new Set();

  const jobs = found
    .map((job) => ({ ...job, bucket: pickBucket(job) }))
    .filter((job) => job.bucket && job.title && isRelevant(job.title))
    .filter((job) => (job.postedAt ? job.postedAt.getTime() >= cutoff : config.includeUnknownDates))
    .sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0))
    .filter((job) => {
      const keys = jobKeys(job);
      if (keys.some((key) => inRun.has(key)) || seen.has(job)) {
        return false;
      }
      keys.forEach((key) => inRun.add(key));
      return true;
    })
    .slice(0, config.maxResults);

  const groups = config.locations
    .map(({ label }) => ({ label, jobs: jobs.filter((job) => job.bucket === label) }))
    .filter((group) => group.jobs.length);

  const notices = results.filter((result) => result.error).map((result) => result.error);
  if (cities.length && !hasCityProvider()) {
    notices.push(`No city job source is configured, so ${cities.map((city) => city.label).join("/")} jobs can't be found. Add ADZUNA_APP_ID + ADZUNA_APP_KEY and/or JOOBLE_API_KEY (both free).`);
  }

  await sendDigest({ jobs, groups, notices });

  if (!config.dryRun) {
    jobs.forEach((job) => seen.add(job));
    await seen.save();
  }

  console.log(`${config.dryRun ? "Dry run" : `Emailed ${config.email.to}`}: ${jobs.length} new jobs (${found.length} fetched).`);
  notices.forEach((notice) => console.warn(`Warning: ${notice}`));

  if (results.length && results.every((result) => result.allFailed)) {
    throw new Error("Every job source failed - see warnings above.");
  }
}

async function runProvider(provider) {
  const jobs = [];
  const messages = new Set();
  const total = provider.searches.length;
  let failed = 0;
  let skipped = 0;

  for (const [index, search] of provider.searches.entries()) {
    if (index > 0) {
      await sleep(provider.intervalMs);
    }
    try {
      const batch = await search.run();
      jobs.push(...batch.map((job) => ({ ...job, target: search.target })));
    } catch (error) {
      failed += 1;
      messages.add(error.message);
      // Bad credentials or an exhausted quota won't fix themselves on the next search.
      if (/\b(401|403)\b|invalid api key|run out of searches/i.test(error.message)) {
        skipped = total - index - 1;
        break;
      }
    }
  }

  const error = failed
    ? `${provider.name}: ${failed}/${total} searches failed${skipped ? `, ${skipped} skipped` : ""} (${[...messages].slice(0, 2).join("; ")})`
    : null;

  return { jobs, error, allFailed: total > 0 && failed + skipped === total };
}

// Decide which configured location a job belongs to, or null to drop it.
function pickBucket(job) {
  if (job.target.remote) {
    return job.remoteEligible ? job.target.label : null;
  }
  return findCity(job.location, cities)?.label ?? null;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
