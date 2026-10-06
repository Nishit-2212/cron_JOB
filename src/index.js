import { cities, config, drivesTarget, validateEmailConfig } from "./config.js";
import { sendDigest } from "./email.js";
import { sleep } from "./http.js";
import { createSeniorityFilter, createTitleMatcher, findCity, requiredYears } from "./matching.js";
import { getProviders, hasDailyCityProvider } from "./providers.js";
import { jobKeys, loadSeenStore } from "./seen-store.js";

async function main() {
  validateEmailConfig();

  const providers = await getProviders();
  const seen = await loadSeenStore(config.seenJobsFile, config.seenJobsDays);
  console.log(`Searching ${providers.map((provider) => `${provider.name} (${provider.searches.length})`).join(", ")}; ${seen.size()} jobs remembered.`);

  // Providers run in parallel; searches within a provider run sequentially to stay under rate limits.
  const results = await Promise.all(providers.map(runProvider));
  const found = results.flatMap((result) => result.jobs);

  const isRelevant = createTitleMatcher(config.keywords, config.excludeKeywords);
  const isJuniorFriendly = createSeniorityFilter(config.maxExperienceYears);
  const now = Date.now();
  // Most sources use FRESH_HOURS; Google Jobs searches rotate over several days, so it sets its own window.
  const isFresh = (job) => (job.postedAt
    ? now - job.postedAt.getTime() <= (job.maxAgeHours ?? config.freshHours) * 3_600_000
    : config.includeUnknownDates);
  const inRun = new Set();
  let tooSenior = 0;

  const jobs = found
    .map((job) => ({ ...job, bucket: pickBucket(job), experienceYears: requiredYears(job.description) }))
    .filter((job) => job.bucket && job.title)
    // Curated fresher feeds are already filtered to IT/software roles by the site itself.
    .filter((job) => job.curated || isRelevant(job.title))
    .filter(isFresh)
    .sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0))
    .filter((job) => {
      const keys = jobKeys(job);
      if (keys.some((key) => inRun.has(key)) || seen.has(job)) {
        return false;
      }
      keys.forEach((key) => inRun.add(key));
      return true;
    })
    .filter((job) => {
      // Fresher-drive posts are junior by nature, but the site's tags are loose, so still check the years asked for.
      const keep = job.curated
        ? isJuniorFriendly({ title: "", experienceYears: job.experienceYears })
        : isJuniorFriendly(job);
      if (!keep) {
        tooSenior += 1;
      }
      return keep;
    })
    .slice(0, config.maxResults);

  // A section counts as searched when at least one search for it succeeded in this run.
  const searched = new Set(results.flatMap((result) => [...result.searched]));
  const targets = [...config.locations, ...(drivesTarget ? [drivesTarget] : [])];
  const groups = targets.map((target) => {
    const groupJobs = jobs.filter((job) => job.bucket === target.label);
    return {
      label: target.label,
      jobs: groupJobs,
      note: groupJobs.length ? "" : searched.has(target.label) ? "Nothing new since the last email." : "Not searched this run – see the note at the top."
    };
  });

  const notices = [];
  if (cities.length && !hasDailyCityProvider()) {
    const names = cities.map((city) => city.label).join(" and ");
    const keys = "free ADZUNA_APP_ID + ADZUNA_APP_KEY (https://developer.adzuna.com/signup) and JOOBLE_API_KEY (https://jooble.org/api/about) GitHub secrets";
    notices.push(config.providers.serpApiKey
      ? `${names} only get a few Google Jobs searches a day, because SerpApi's free plan has 250 searches a month. Add the ${keys} to search them every day.`
      : `${names} are NOT being searched: no free job API that works without a key covers Indian cities. Add the ${keys}.`);
  }
  notices.push(...results.map((result) => result.error).filter(Boolean));
  const info = results.map((result) => result.note).filter(Boolean);

  const stats = {
    fetched: found.length,
    tooSenior,
    sources: results.map(({ name, jobs: fetched, summary }) => ({ name, fetched: fetched.length, summary }))
  };

  if (jobs.length || config.sendEmptyDigest || config.dryRun) {
    await sendDigest({ jobs, groups, notices, info, stats });
    console.log(`${config.dryRun ? "Dry run" : `Emailed ${config.email.to}`}: ${jobs.length} new jobs (${found.length} fetched, ${tooSenior} too senior).`);
  } else {
    console.log(`No new jobs (${found.length} fetched, ${tooSenior} too senior) - no email sent.`);
  }

  if (!config.dryRun) {
    jobs.forEach((job) => seen.add(job));
    await seen.save();
  }

  info.forEach((note) => console.log(`Note: ${note}`));
  notices.forEach((notice) => console.warn(`Warning: ${notice}`));

  if (results.some((result) => result.total) && results.every((result) => result.allFailed || !result.total)) {
    throw new Error("Every job source failed - see warnings above.");
  }
}

async function runProvider(provider) {
  const jobs = [];
  const messages = new Set();
  const searched = new Set();
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
      searched.add(search.target.label);
    } catch (error) {
      failed += 1;
      messages.add(error.message);
      // Bad credentials, a used-up quota or a rate limit that outlasted the retries won't fix themselves on the next search.
      if (/\b(401|403|429)\b|invalid api key|run out of searches/i.test(error.message)) {
        skipped = total - index - 1;
        break;
      }
    }
  }

  const error = failed
    ? `${provider.name}: ${failed}/${total} searches failed${skipped ? `, ${skipped} skipped` : ""} (${[...messages].slice(0, 2).join("; ")})`
    : null;

  return {
    name: provider.name,
    summary: provider.summary,
    note: provider.note,
    jobs,
    searched,
    total,
    error,
    allFailed: total > 0 && failed + skipped === total
  };
}

// Decide which section a job belongs to, or null to drop it.
function pickBucket(job) {
  if (job.target.drives) {
    // A fresher drive in Ahmedabad/Gandhinagar goes to that city's section.
    return findCity(`${job.title} ${job.location}`, cities)?.label ?? job.target.label;
  }
  if (job.target.remote) {
    return job.remoteEligible ? job.target.label : null;
  }
  return findCity(`${job.location} ${job.region ?? ""}`, cities)?.label ?? null;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
