// post-birthday-greetings.mjs
//
// Daily job: looks up every ACTIVE member in Supabase whose birthday is
// today, builds one combined greeting (with photo(s)) if there's more than
// one, and posts it to the church's Facebook Page. Designed to run
// unattended from a GitHub Actions cron schedule (see
// .github/workflows/birthday-greetings.yml).
//
// Required environment variables (set as GitHub Secrets):
//   SUPABASE_URL              e.g. https://xxxxx.supabase.co
//   SUPABASE_KEY               the project's anon key (same one the web app uses is fine,
//                               since this script only reads the `members` table)
//   FB_PAGE_ID                 numeric Facebook Page ID
//   FB_PAGE_ACCESS_TOKEN        a long-lived / never-expiring Page access token
// Optional:
//   TIMEZONE                   IANA timezone used to decide what "today" is (default: Asia/Manila)
//   DRY_RUN                    set to "true" to log the post instead of publishing it
//   GRAPH_API_VERSION          Facebook Graph API version (default: v25.0)
//
// PHOTOS: the `members.photo` column stores either a base64 data URI
// (`data:image/jpeg;base64,...`, produced by the admin app's photo picker)
// or, less commonly, a plain http(s) URL. Neither is ever written to disk —
// data URIs are decoded straight into memory and uploaded to Facebook as
// multipart form data; plain URLs are passed straight to the Graph API's
// `url` parameter. Nothing is fetched from or stored in the repo.

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto'; // built-in — no new dependency

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
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

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
    .select('name, birthday, photo, active')
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

  return celebrants
    .filter((m) => m.name)
    .map((m) => ({ name: m.name, photo: (m.photo || '').trim() || null }));
}

// ---------------------------------------------------------------------------
// 3. Build the greeting message — 5 Christian templates, one theme each,
//    picked deterministically so the same celebrant(s) on the same day
//    always get the same message (safe to rerun), while different birthdays
//    naturally land on different templates.
// ---------------------------------------------------------------------------
function joinNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

const GREETING_TEMPLATES = [
  // 1. Blessings & Grace
  (namesLine) =>
    `🎉🎂 HAPPY BIRTHDAY! 🎂🎉\n\n` +
    `Happy birthday, ${namesLine}!\n\n` +
    `On this special day, the TGLCC family prays that God's grace overflows in your life. ` +
    `May He bless you richly with good health, favor, and countless reasons to smile in the year ahead.\n\n` +
    `"The Lord bless you and keep you." — Numbers 6:24 🙏❤️\n\n` +
    `#TGLCCFamily #HappyBirthday #GodBless`,

  // 2. Faith & Strength
  (namesLine) =>
    `🎉🎂 HAPPY BIRTHDAY! 🎂🎉\n\n` +
    `Happy birthday, ${namesLine}!\n\n` +
    `Today, the TGLCC family celebrates the faith and strength God continues to build in you. ` +
    `May this new year find you rooted in Him, courageous in every season, and confident in His promises.\n\n` +
    `"I can do all things through Christ who strengthens me." — Philippians 4:13 💪🙏\n\n` +
    `#TGLCCFamily #HappyBirthday #GodBless`,

  // 3. Prayer & Guidance
  (namesLine) =>
    `🎉🎂 HAPPY BIRTHDAY! 🎂🎉\n\n` +
    `Happy birthday, ${namesLine}!\n\n` +
    `The TGLCC family lifts you up in prayer today, asking the Lord to guide every step you take this new year ` +
    `and to light your path with His wisdom and peace.\n\n` +
    `"Trust in the Lord with all your heart, and He will make your paths straight." — Proverbs 3:5-6 🙏✨\n\n` +
    `#TGLCCFamily #HappyBirthday #GodBless`,

  // 4. Joy & Gratitude
  (namesLine) =>
    `🎉🎂 HAPPY BIRTHDAY! 🎂🎉\n\n` +
    `Happy birthday, ${namesLine}!\n\n` +
    `Today, the TGLCC family rejoices with you and gives thanks to God for the gift of your life. ` +
    `May His joy be your strength and may gratitude fill every moment of this new chapter.\n\n` +
    `"This is the day the Lord has made; let us rejoice and be glad in it." — Psalm 118:24 🎈❤️\n\n` +
    `#TGLCCFamily #HappyBirthday #GodBless`,

  // 5. Love & Fellowship
  (namesLine) =>
    `🎉🎂 HAPPY BIRTHDAY! 🎂🎉\n\n` +
    `Happy birthday, ${namesLine}!\n\n` +
    `The TGLCC family is grateful to walk this journey of faith alongside you. May you feel God's love ` +
    `and the warmth of your church family surrounding you today and always.\n\n` +
    `"Above all, love each other deeply, because love covers over a multitude of sins." — 1 Peter 4:8 🙏❤️\n\n` +
    `#TGLCCFamily #HappyBirthday #GodBless`,
];

// Deterministic template pick: seeded from the celebrants' names (sorted, so
// order doesn't matter) + today's date. Same celebrants + same day => same
// index every time (safe reruns). Different day or different celebrants =>
// likely a different template.
function pickTemplateIndex(celebrants) {
  const { year, month, day } = todayMonthDay(TIMEZONE);
  const seed = celebrants.map((c) => c.name).slice().sort().join('|') + `|${year}-${month}-${day}`;
  const hash = createHash('sha256').update(seed).digest();
  return hash[0] % GREETING_TEMPLATES.length;
}

function buildMessage(celebrants) {
  const namesLine = joinNames(celebrants.map((c) => c.name));
  const template = GREETING_TEMPLATES[pickTemplateIndex(celebrants)];
  return template(namesLine);
}

// ---------------------------------------------------------------------------
// 4. Photo handling — decode base64 data URIs in memory, or pass plain URLs
//    straight through. Never written to disk.
// ---------------------------------------------------------------------------
function parseDataUri(value) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(value);
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

// Uploads one celebrant's photo to the Page as an *unpublished* photo, so it
// can be attached to the combined feed post afterwards. Returns the
// media_fbid on success, or null on any failure (logged, not thrown) so a
// bad/missing photo never takes down the whole job.
async function uploadUnpublishedPhoto(name, photo) {
  if (!photo) return null;

  try {
    const form = new FormData();
    form.append('published', 'false');
    form.append('access_token', FB_PAGE_ACCESS_TOKEN);

    const dataUri = parseDataUri(photo);
    if (dataUri) {
      form.append('source', new Blob([dataUri.buffer], { type: dataUri.mime }), 'photo');
    } else if (/^https?:\/\//i.test(photo)) {
      form.append('url', photo);
    } else {
      console.warn(`Skipping photo for ${name}: unrecognized photo format.`);
      return null;
    }

    const res = await fetch(`${GRAPH_BASE}/${FB_PAGE_ID}/photos`, { method: 'POST', body: form });
    const json = await res.json();

    if (!res.ok || json.error || !json.id) {
      console.warn(`Photo upload failed for ${name}: ${JSON.stringify(json.error || json)}`);
      return null;
    }

    return json.id;
  } catch (err) {
    console.warn(`Photo upload threw for ${name}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 5. Duplicate-post guard. No extra table/service — just checks whether the
//    Page already has a birthday post published today (in TIMEZONE), so an
//    accidental double-trigger of the workflow doesn't post twice.
// ---------------------------------------------------------------------------
async function alreadyPostedToday() {
  const { month, day, year } = todayMonthDay(TIMEZONE);

  try {
    const url = new URL(`${GRAPH_BASE}/${FB_PAGE_ID}/posts`);
    url.searchParams.set('fields', 'message,created_time');
    url.searchParams.set('limit', '10');
    url.searchParams.set('access_token', FB_PAGE_ACCESS_TOKEN);

    const res = await fetch(url);
    const json = await res.json();

    if (!res.ok || json.error) {
      console.warn(`Could not check recent posts (continuing anyway): ${JSON.stringify(json.error || json)}`);
      return false;
    }

    return (json.data || []).some((post) => {
      if (!post.message || !post.message.includes('HAPPY BIRTHDAY')) return false;
      const created = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(post.created_time));
      return created === `${year}-${month}-${day}`;
    });
  } catch (err) {
    console.warn(`Duplicate-post check failed (continuing anyway): ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 6. Post to the Facebook Page, with photo(s) attached when available.
// ---------------------------------------------------------------------------
async function postToFacebook(message, mediaFbids) {
  const url = `${GRAPH_BASE}/${FB_PAGE_ID}/feed`;
  const body = new URLSearchParams({ message, access_token: FB_PAGE_ACCESS_TOKEN });

  // attached_media works for one photo or many — it publishes the
  // already-uploaded (currently unpublished) photo(s) as part of this post.
  if (mediaFbids.length > 0) {
    body.set('attached_media', JSON.stringify(mediaFbids.map((id) => ({ media_fbid: id }))));
  }

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
  const celebrants = await getTodaysCelebrants();

  if (celebrants.length === 0) {
    console.log('No active-member birthdays today. Nothing to post.');
    return;
  }

  console.log(`Today's celebrants: ${celebrants.map((c) => c.name).join(', ')}`);

  const message = buildMessage(celebrants);
  console.log('--- Birthday post content ---');
  console.log(message);
  console.log('------------------------------');

  if (DRY_RUN === 'true') {
    const withPhoto = celebrants.filter((c) => c.photo).length;
    console.log(`DRY_RUN is true — skipping Facebook. ${withPhoto}/${celebrants.length} celebrant(s) have a photo on file.`);
    return;
  }

  if (await alreadyPostedToday()) {
    console.log('A birthday post already went out today — skipping to avoid a duplicate.');
    return;
  }

  // Upload each celebrant's photo (if any) as unpublished first, so we can
  // attach whichever ones succeed to a single combined post.
  const mediaFbids = [];
  for (const celebrant of celebrants) {
    const id = await uploadUnpublishedPhoto(celebrant.name, celebrant.photo);
    if (id) mediaFbids.push(id);
  }

  const result = await postToFacebook(message, mediaFbids);
  console.log(`Posted to Facebook. Post ID: ${result.id || result.post_id || '(see response)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
