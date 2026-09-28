import nodemailer from "nodemailer";
import { config } from "./config.js";
import { truncate } from "./matching.js";

export async function sendDigest(digest) {
  const subject = buildSubject(digest);

  if (config.dryRun) {
    console.log(`Subject: ${subject}\n\n${renderText(digest)}`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: { user: config.email.user, pass: config.email.pass }
  });

  await transporter.sendMail({
    from: config.email.from,
    to: config.email.to,
    subject,
    text: renderText(digest),
    html: renderHtml(digest)
  });
}

function buildSubject({ jobs, groups }) {
  const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  if (!jobs.length) {
    return `Job digest ${date}: nothing new`;
  }
  const breakdown = groups.filter((group) => group.jobs.length).map((group) => `${group.label} ${group.jobs.length}`).join(" · ");
  return `Job digest ${date}: ${jobs.length} new (${breakdown})`;
}

function postedLabel(date) {
  if (!date) {
    return "Date unknown";
  }
  const hours = Math.max(0, Math.round((Date.now() - date.getTime()) / 3_600_000));
  if (hours < 1) {
    return "Just now";
  }
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function jobMeta(job) {
  return [
    postedLabel(job.postedAt),
    job.source,
    job.experienceYears === 0 ? "Fresher" : job.experienceYears ? `${job.experienceYears}+ yrs exp` : "",
    job.salary
  ].filter(Boolean);
}

function jobSummary(job) {
  return truncate(job.summary || job.description || "", 220);
}

function footer({ stats }) {
  const hidden = config.maxExperienceYears === null
    ? ""
    : ` Hid ${stats.tooSenior} senior role${stats.tooSenior === 1 ? "" : "s"} (more than ${config.maxExperienceYears} yrs or senior titles).`;
  return `Scanned ${stats.fetched} postings from ${stats.sources.join(", ")}.${hidden}`;
}

function renderText(digest) {
  const { groups, notices } = digest;
  const lines = [];

  if (notices.length) {
    lines.push("⚠ ACTION NEEDED", ...notices.map((notice) => `- ${notice}`), "");
  }

  let index = 0;
  for (const group of groups) {
    lines.push(`== ${group.label} (${group.jobs.length}) ==`);
    if (group.note) {
      lines.push(group.note);
    }
    for (const job of group.jobs) {
      index += 1;
      lines.push(
        `${index}. ${job.title}`,
        `   ${job.company} · ${job.location}`,
        `   ${jobMeta(job).join(" · ")}`,
        ...(job.url ? [`   ${job.url}`] : [])
      );
    }
    lines.push("");
  }

  lines.push(footer(digest));
  return lines.join("\n");
}

function renderHtml(digest) {
  const { jobs, groups, notices } = digest;

  const noticesHtml = notices.length
    ? `<div style="margin:16px 0;padding:12px 14px;background:#fee2e2;border-left:4px solid #dc2626;border-radius:6px;font-size:14px;color:#7f1d1d;">
        <strong>⚠ Action needed</strong>
        <ul style="margin:6px 0 0;padding-left:18px;">${notices.map((notice) => `<li style="margin-bottom:4px;">${linkify(escapeHtml(notice))}</li>`).join("")}</ul>
      </div>`
    : "";

  const sections = groups.map((group) => `
    <h2 style="margin:24px 0 6px;font-size:16px;color:#111827;border-bottom:2px solid #2563eb;padding-bottom:4px;">
      ${escapeHtml(group.label)} <span style="color:#6b7280;font-weight:normal;">(${group.jobs.length})</span>
    </h2>
    ${group.note ? `<p style="margin:6px 0;font-size:13px;color:#6b7280;">${escapeHtml(group.note)}</p>` : ""}
    ${group.jobs.map(renderJobHtml).join("")}`).join("");

  return `
    <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;line-height:1.45;color:#111827;max-width:680px;margin:0 auto;">
      <h1 style="font-size:20px;margin:0 0 4px;">Daily job digest</h1>
      <p style="margin:0;color:#6b7280;font-size:13px;">
        ${jobs.length} new role${jobs.length === 1 ? "" : "s"} since the last email · posted in the last ${config.freshHours}h
      </p>
      ${noticesHtml}${sections}
      <p style="margin-top:28px;font-size:12px;color:#9ca3af;">${escapeHtml(footer(digest))}</p>
    </div>`;
}

function renderJobHtml(job) {
  const url = safeUrl(job.url);
  const title = url
    ? `<a href="${escapeHtml(url)}" style="color:#1d4ed8;text-decoration:none;">${escapeHtml(job.title)}</a>`
    : escapeHtml(job.title);
  const summary = jobSummary(job);

  return `
    <div style="padding:10px 0;border-bottom:1px solid #e5e7eb;">
      <div style="font-size:15px;font-weight:600;">${title}</div>
      <div style="font-size:13px;color:#374151;">${escapeHtml(job.company)} · ${escapeHtml(job.location)}</div>
      <div style="font-size:12px;color:#6b7280;">${jobMeta(job).map(escapeHtml).join(" · ")}</div>
      ${summary ? `<div style="font-size:13px;color:#4b5563;margin-top:4px;">${escapeHtml(summary)}</div>` : ""}
    </div>`;
}

function linkify(html) {
  return html.replace(/https:\/\/[^\s)<]+/g, (url) => `<a href="${url}" style="color:#7f1d1d;">${url}</a>`);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
