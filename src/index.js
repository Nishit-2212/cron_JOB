import { cities, config, drivesTarget, validateEmailConfig } from "./config.js";
import { sendDigest } from "./email.js";
import { sleep } from "./http.js";
import { createSeniorityFilter, createTitleMatcher, findCity, requiredYears } from "./matching.js";
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
  const isJuniorFriendly = createSeniorityFilter(config.maxExperienceYears);
  const cutoff = Date.now() - config.freshHours * 3_600_000;
  const inRun = new Set();
  let tooSenior = 0;

  const jobs = found
    .map((job) => ({ ...job, bucket: pickBucket(job), experienceYears: requiredYears(job.description) }))
    .filter((job) => job.bucket && job.title)
    // Curated fresher feeds are already filtered to IT/software roles by the site itself.
    .filter((job) => job.curated || isRelevant(job.title))
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

  const missingCitySource = cities.length > 0 && !hasCityProvider();
  const targets = [...config.locations, ...(drivesTarget ? [drivesTarget] : [])];
  const groups = targets.map((target) => {
    const groupJobs = jobs.filter((job) => job.bucket === target.label);
    const notSearched = missingCitySource && !target.remote && !target.drives;
    return {
      label: target.label,
      jobs: groupJobs,
      note: groupJobs.length ? "" : notSearched ? "Not searched – needs a free Adzuna or Jooble API key (see the warning at the top)." : "Nothing new since the last email."
    };
  });

  const notices = [];
  if (missingCitySource) {
    notices.push(`${cities.map((city) => city.label).join(" and ")} are NOT being searched: no free job API that works without a key covers Indian cities. Add ADZUNA_APP_ID + ADZUNA_APP_KEY (https://developer.adzuna.com/signup) and/or JOOBLE_API_KEY (https://jooble.org/api/about) as GitHub secrets.`);
  }
  notices.push(...results.filter((result) => result.error).map((result) => result.error));

  const stats = {
    fetched: found.length,
    tooSenior,
    sources: providers.map((provider) => provider.name)
  };

  if (jobs.length || config.sendEmptyDigest || config.dryRun) {
    await sendDigest({ jobs, groups, notices, stats });
    console.log(`${config.dryRun ? "Dry run" : `Emailed ${config.email.to}`}: ${jobs.length} new jobs (${found.length} fetched, ${tooSenior} too senior).`);
  } else {
    console.log(`No new jobs (${found.length} fetched, ${tooSenior} too senior) - no email sent.`);
  }

  if (!config.dryRun) {
    jobs.forEach((job) => seen.add(job));
    await seen.save();
  }

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
