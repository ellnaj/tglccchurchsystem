// post-birthday-greetings.mjs
//
// Daily job: looks up every ACTIVE member in Supabase whose birthday is
// today, builds one combined greeting if there's more than one, and posts
// it to the church's Facebook Page. Designed to run unattended from a
// GitHub Actions cron schedule (see .github/workflows/birthday-greetings.yml).
//
// Required environment variables (set as GitHub Secrets — see automation/README.md):
//   SUPABASE_URL              e.g. https://xxxxx.supabase.co
//   SUPABASE_KEY               the project's anon key (same one the web app uses is fine,
//                               since this script only reads the `members` table)
//   FB_PAGE_ID                 numeric Facebook Page ID
//   FB_PAGE_ACCESS_TOKEN        a long-lived / never-expiring Page access token
// Optional:
//   TIMEZONE                   IANA timezone used to decide what "today" is (default: Asia/Manila)
//   DRY_RUN                    set to "true" to log the post instead of publishing it
//   GRAPH_API_VERSION          Facebook Graph API version (default: v25.0)

import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  FB_PAGE_ID,
  FB_PAGE_ACCESS_TOKEN,
  TIMEZONE = 'Asia/Manila',
  DRY_RUN = 'false',
  GRAPH_API_VERSION = 'v25.0',
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}
requireEnv('SUPABASE_URL', SUPABASE_URL);
requireEnv('SUPABASE_KEY', SUPABASE_KEY);
requireEnv('FB_PAGE_ID', FB_PAGE_ID);
requireEnv('FB_PAGE_ACCESS_TOKEN', FB_PAGE_ACCESS_TOKEN);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------------
// 1. Figure out "today" (month/day) in the church's local timezone, not the
//    GitHub Actions runner's UTC clock.
// ---------------------------------------------------------------------------
function todayMonthDay(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return { month: get('month'), day: get('day'), year: get('year') };
}

// Pulls the month/day out of a stored birthday string. The app saves
// birthdays as plain 'YYYY-MM-DD' text, but this is written defensively in
// case a value ever comes back as a full ISO timestamp instead.
function monthDayFromBirthday(birthday) {
  if (!birthday) return null;
  const match = String(birthday).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return { month: match[2], day: match[3] };
}

// ---------------------------------------------------------------------------
// 2. Fetch active members and filter to today's celebrants.
// ---------------------------------------------------------------------------
async function getTodaysCelebrants() {
  const { month, day } = todayMonthDay(TIMEZONE);

  const { data, error } = await supabase
    .from('members')
    .select('name, birthday, active')
    .eq('active', true);

  if (error) {
    throw new Error(`Supabase query failed: ${error.message}`);
  }

  const celebrants = (data || []).filter((m) => {
    const md = monthDayFromBirthday(m.birthday);
    if (!md) return false;

    // Handle Feb 29 birthdays gracefully in non-leap years by celebrating
    // them on Feb 28 instead of skipping them entirely.
    if (md.month === '02' && md.day === '29' && month === '02' && day === '28') {
      const currentYear = Number(todayMonthDay(TIMEZONE).year);
      const isLeapYear = (currentYear % 4 === 0 && currentYear % 100 !== 0) || currentYear % 400 === 0;
      if (!isLeapYear) return true;
    }

    return md.month === month && md.day === day;
  });

  return celebrants.map((m) => m.name).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 3. Build the greeting message.
// ---------------------------------------------------------------------------
function joinNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function buildMessage(names) {
  const isPlural = names.length > 1;
  const namesLine = joinNames(names);

  if (isPlural) {
    return (
      `🎉🎂 HAPPY BIRTHDAY! 🎂🎉\n\n` +
      `Today, our TGLCC family celebrates ${names.length} wonderful members: ${namesLine}!\n\n` +
      `May the Lord bless each of you with more years of good health, grace, and joy, ` +
      `and may His love continue to shine through your life. Have a blessed celebration! 🙏❤️\n\n` +
      `From #TglccFamily — Happy Birthday! 🎈`
    );
  }

  return (
    `🎉🎂 HAPPY BIRTHDAY, ${namesLine.toUpperCase()}! 🎂🎉\n\n` +
    `Today our TGLCC family celebrates you! May the Lord bless you with more years of good health, ` +
    `grace, and joy, and may His love continue to shine through your life. Have a blessed celebration! 🙏❤️\n\n` +
    `From #TglccFamily — Happy Birthday! 🎈`
  );
}

// ---------------------------------------------------------------------------
// 4. Post to the Facebook Page.
// ---------------------------------------------------------------------------
async function postToFacebook(message) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/feed`;
  const body = new URLSearchParams({
    message,
    access_token: FB_PAGE_ACCESS_TOKEN,
  });

  const res = await fetch(url, { method: 'POST', body });
  const json = await res.json();

  if (!res.ok || json.error) {
    throw new Error(`Facebook post failed: ${JSON.stringify(json.error || json)}`);
  }

  return json; // { id: "<page-id>_<post-id>" }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const names = await getTodaysCelebrants();

  if (names.length === 0) {
    console.log('No active-member birthdays today. Nothing to post.');
    return;
  }

  const message = buildMessage(names);
  console.log('--- Birthday post content ---');
  console.log(message);
  console.log('------------------------------');

  if (DRY_RUN === 'true') {
    console.log('DRY_RUN is true — skipping the actual Facebook post.');
    return;
  }

  const result = await postToFacebook(message);
  console.log(`Posted to Facebook. Post ID: ${result.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
