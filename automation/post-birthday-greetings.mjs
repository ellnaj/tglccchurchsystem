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
import { createCanvas, loadImage } from 'canvas'; // renders the branded birthday graphic

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
    `Greetings from #TglccFamily!\n\n` +
    `Happy Birthday, ${namesLine}!❤️\n\n` +
    `On this special day, the TGLCC family prays that God's grace overflows in your life. ` +
    `May He bless you richly with good health, favor, and countless reasons to smile in the year ahead.🙏\n\n` +
    `"The Lord bless you and keep you." — Numbers 6:24 \n\n` +
    `#TglccFamily #HappyBirthday #GodBless`,

  // 2. Faith & Strength
  (namesLine) =>
    `Greetings from #TglccFamily!\n\n` +
    `Happy Birthday, ${namesLine}!❤️\n\n` +
    `Today, the TGLCC family celebrates the faith and strength God continues to build in you. ` +
    `May this new year find you rooted in Him, courageous in every season, and confident in His promises.🙏\n\n` +
    `"I can do all things through Christ who strengthens me." — Philippians 4:13 \n\n` +
    `#TglccFamily #HappyBirthday #GodBless`,

  // 3. Prayer & Guidance
  (namesLine) =>
    `Greetings from #TglccFamily!\n\n` +
    `Happy Birthday, ${namesLine}!❤️\n\n` +
    `Today, we celebrate with you and thank God for the gift of your life. ` +
    `May His joy be your strength and may your heart be filled with gratitude as you step into this new chapter.🙏\n\n` +
    `"Trust in the Lord with all your heart, and He will make your paths straight." — Proverbs 3:5-6 \n\n` +
    `#TglccFamily #HappyBirthday #GodBless`,

  // 4. Joy & Gratitude
  (namesLine) =>
    `Greetings from #TglccFamily!\n\n` +
    `Happy Birthday, ${namesLine}!❤️\n\n` +
    `As you begin another year, may you continue to see God's hand working in your life. May He strengthen you when things get difficult, ` +
    `guide you when you need direction, and bless you with many beautiful moments along the way.🙏\n\n` +
    `"This is the day the Lord has made; let us rejoice and be glad in it." — Psalm 118:24 \n\n` +
    `#TglccFamily #HappyBirthday #GodBless`,

  // 5. Love & Fellowship
  (namesLine) =>
    `Greetings from #TglccFamily!\n\n` +
    `Happy Birthday, ${namesLine}!❤️\n\n` +
    `We’re thankful to God for another year of your life! May this new chapter be filled with meaningful moments, answered prayers, ` +
    `and countless blessings. Keep walking with God and enjoy every moment He has prepared for you.🙏\n\n` +
    `"Above all, love each other deeply, because love covers over a multitude of sins." — 1 Peter 4:8 \n\n` +
    `#TglccFamily #HappyBirthday #GodBless`,
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

function buildMessage(celebrants, templateIndex = pickTemplateIndex(celebrants)) {
  const namesLine = joinNames(celebrants.map((c) => c.name));
  const template = GREETING_TEMPLATES[templateIndex];
  return template(namesLine);
}

// ---------------------------------------------------------------------------
// 3b. Branded graphic — renders the selected message onto one TGLCC
//     blue/white/gold card (portrait) instead of posting the celebrant's raw
//     photo. Built from the SAME `message` string produced above, so the 5
//     templates / random-pick logic are untouched — this only changes how
//     that text is presented visually. Never written to disk; returns a PNG
//     Buffer that gets uploaded straight to Facebook.
// ---------------------------------------------------------------------------
const CARD_W = 1080;
const CARD_MAX_H = 2000; // generous working canvas; final image is cropped to actual content height
const TEXT_DARK = '#1E2A44';

// ---------------------------------------------------------------------------
// 5 card design themes — one per GREETING_TEMPLATES theme (same index, same
// seed as pickTemplateIndex), so a given message theme always renders on its
// matching card design. Each theme controls palette + a few structural
// choices (photo frame, divider, footer, quote box) so the cards feel like
// distinct Canva-style templates rather than one skin re-colored.
// ---------------------------------------------------------------------------
const CARD_THEMES = [
  { // 1. Blessings & Grace — classic navy/gold
    name: 'grace',
    navy: '#0B2A5B', pillNavy: '#12407A', gold: '#C9A24B', paper: '#FAF6EC',
    photoFrame: 'circle', divider: 'line', footer: 'curve', quoteBox: 'thin', decoration: 'none',
  },
  { // 2. Faith & Strength — deep maroon/gold, bolder lines
    name: 'strength',
    navy: '#5B1A2B', pillNavy: '#7A2338', gold: '#D8B15B', paper: '#FBF3EC',
    photoFrame: 'square', divider: 'double', footer: 'angle', quoteBox: 'thick', decoration: 'corners',
  },
  { // 3. Prayer & Guidance — sage green/cream, softer shapes
    name: 'guidance',
    navy: '#2F4F3E', pillNavy: '#3E664F', gold: '#C7A75A', paper: '#F6F5EC',
    photoFrame: 'dashed', divider: 'line', footer: 'wave', quoteBox: 'dotted', decoration: 'dots',
  },
  { // 4. Joy & Gratitude — sky blue/gold, playful accents
    name: 'gratitude',
    navy: '#1B4B66', pillNavy: '#256485', gold: '#E0B84A', paper: '#F5F8FA',
    photoFrame: 'sparkle', divider: 'line', footer: 'curve', quoteBox: 'thin', decoration: 'confetti',
  },
  { // 5. Love & Fellowship — warm rose/gold, ring accents
    name: 'fellowship',
    navy: '#6B2E3A', pillNavy: '#8A3D4D', gold: '#D9A94E', paper: '#FBF1EC',
    photoFrame: 'ring', divider: 'double', footer: 'diagonal', quoteBox: 'filled', decoration: 'hearts',
  },
];

function stripEmoji(str) {
  return str.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '').trim();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawWrappedCentered(ctx, text, maxWidth, startY, lineHeight) {
  const lines = wrapText(ctx, text, maxWidth);
  let y = startY;
  lines.forEach((line) => {
    ctx.fillText(line, CARD_W / 2, y);
    y += lineHeight;
  });
  return y;
}

async function loadCelebrantImage(photo) {
  if (!photo) return null;
  try {
    return await loadImage(photo); // node-canvas accepts data URIs and http(s) URLs directly
  } catch (err) {
    console.warn(`Could not load photo for card graphic: ${err.message}`);
    return null;
  }
}

// Small corner/scatter accents drawn under everything else, kept subtle so
// text stays readable. Purely decorative — varies the "feel" of a theme
// beyond just its color palette.
function drawDecoration(ctx, theme) {
  const { gold, navy, decoration } = theme;
  ctx.save();
  ctx.globalAlpha = 0.5;
  if (decoration === 'corners') {
    // Bold L-shaped corner brackets, top-left & top-right
    ctx.strokeStyle = gold;
    ctx.lineWidth = 4;
    [[40, 40, 1], [CARD_W - 40, 40, -1]].forEach(([x, y, dir]) => {
      ctx.beginPath();
      ctx.moveTo(x, y + 50);
      ctx.lineTo(x, y);
      ctx.lineTo(x + dir * 50, y);
      ctx.stroke();
    });
  } else if (decoration === 'dots') {
    // Scattered small dots along the top edge, like petals falling
    ctx.fillStyle = gold;
    const dotSpots = [[70, 60, 5], [130, 100, 3], [CARD_W - 70, 60, 5], [CARD_W - 130, 100, 3], [CARD_W / 2 - 250, 50, 3], [CARD_W / 2 + 250, 50, 3]];
    dotSpots.forEach(([x, y, r]) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
  } else if (decoration === 'confetti') {
    // Tiny scattered squares/circles, playful
    const spots = [[60, 50], [110, 90], [CARD_W - 60, 50], [CARD_W - 110, 90], [CARD_W / 2 - 200, 40], [CARD_W / 2 + 200, 40], [90, 140], [CARD_W - 90, 140]];
    spots.forEach(([x, y], i) => {
      ctx.fillStyle = i % 2 === 0 ? gold : navy;
      if (i % 3 === 0) {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(x - 3, y - 3, 6, 6);
      }
    });
  } else if (decoration === 'hearts') {
    ctx.fillStyle = gold;
    [[80, 70, 10], [CARD_W - 80, 70, 10], [130, 110, 6], [CARD_W - 130, 110, 6]].forEach(([cx, cy, s]) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy + s * 0.3);
      ctx.bezierCurveTo(cx - s, cy - s * 0.6, cx - s * 1.6, cy + s * 0.5, cx, cy + s * 1.4);
      ctx.bezierCurveTo(cx + s * 1.6, cy + s * 0.5, cx + s, cy - s * 0.6, cx, cy + s * 0.3);
      ctx.fill();
    });
  }
  ctx.restore();
}

function drawPhotoFrame(ctx, img, cx, cy, r, theme) {
  const { navy, gold, photoFrame } = theme;
  const drawClippedCircle = () => {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    const scale = Math.max((r * 2) / img.width, (r * 2) / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    ctx.restore();
  };

  if (photoFrame === 'square') {
    ctx.save();
    roundRect(ctx, cx - r, cy - r, r * 2, r * 2, 24);
    ctx.clip();
    const scale = Math.max((r * 2) / img.width, (r * 2) / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    ctx.restore();
    ctx.strokeStyle = navy;
    ctx.lineWidth = 6;
    roundRect(ctx, cx - r, cy - r, r * 2, r * 2, 24);
    ctx.stroke();
  } else {
    drawClippedCircle();
    ctx.strokeStyle = navy;
    ctx.lineWidth = photoFrame === 'ring' ? 5 : 5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    if (photoFrame === 'dashed') {
      ctx.strokeStyle = gold;
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.arc(cx, cy, r + 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (photoFrame === 'ring') {
      ctx.strokeStyle = gold;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 12, 0, Math.PI * 2);
      ctx.stroke();
    } else if (photoFrame === 'sparkle') {
      ctx.fillStyle = gold;
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI * 2 * i) / 6;
        const sx = cx + Math.cos(angle) * (r + 20);
        const sy = cy + Math.sin(angle) * (r + 20);
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

// Builds the branded card as a PNG buffer from the celebrant list + the
// already-built `message` string (same one used as the FB post caption).
// `themeIndex` should match the message's template index so the visual
// theme (colors/shapes) always pairs with the message theme (words).
async function generateBirthdayCard(celebrants, message, themeIndex = 0) {
  const theme = CARD_THEMES[themeIndex % CARD_THEMES.length];
  const { navy, pillNavy, gold, paper } = theme;
  const [, greetingBlock, bodyBlock, quoteBlock, hashtagBlock] = message.split('\n\n');

  // Draw onto a generously tall working canvas first; we don't know the
  // final content height (name/message length varies) until after the
  // quote box is laid out, so the card is cropped to size at the end.
  const canvas = createCanvas(CARD_W, CARD_MAX_H);
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';

  // Background
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, CARD_W, CARD_MAX_H);

  drawDecoration(ctx, theme);

  // Heading
  ctx.fillStyle = navy;
  ctx.font = 'bold 62px sans-serif';
  ctx.fillText('HAPPY BIRTHDAY!', CARD_W / 2, 130);

  // Divider (single line+dot, or bolder double line depending on theme)
  ctx.strokeStyle = gold;
  ctx.lineWidth = theme.divider === 'double' ? 3 : 2;
  const drawDividerHalf = (yOff) => {
    ctx.beginPath();
    ctx.moveTo(150, 165 + yOff);
    ctx.lineTo(CARD_W / 2 - 20, 165 + yOff);
    ctx.moveTo(CARD_W / 2 + 20, 165 + yOff);
    ctx.lineTo(CARD_W - 150, 165 + yOff);
    ctx.stroke();
  };
  drawDividerHalf(0);
  if (theme.divider === 'double') drawDividerHalf(8);
  ctx.fillStyle = gold;
  ctx.beginPath();
  ctx.arc(CARD_W / 2, 165, 6, 0, Math.PI * 2);
  ctx.fill();

  // Celebrant photo(s) — frame shape depends on theme
  const photos = (await Promise.all(celebrants.map((c) => loadCelebrantImage(c.photo)))).filter(Boolean);
  const photoY = 300;
  const photoR = 110;
  if (photos.length > 0) {
    const spacing = photoR * 2 + 30;
    const startX = CARD_W / 2 - ((photos.length - 1) * spacing) / 2;
    photos.forEach((img, i) => {
      const cx = startX + i * spacing;
      drawPhotoFrame(ctx, img, cx, photoY, photoR, theme);
    });
  }

  // "Happy birthday, {name(s)}!"
  ctx.fillStyle = navy;
  ctx.font = 'bold 44px sans-serif';
  const greetingY = photos.length > 0 ? photoY + photoR + 80 : 300;
  let y = drawWrappedCentered(ctx, greetingBlock, CARD_W - 160, greetingY, 52);

  // Body paragraph
  ctx.fillStyle = TEXT_DARK;
  ctx.font = '29px sans-serif';
  y = drawWrappedCentered(ctx, bodyBlock, CARD_W - 200, y + 40, 40);

  // Quote box (verse text + reference) — border style depends on theme
  const cleanQuote = stripEmoji(quoteBlock);
  const quoteMatch = /^"(.+)"\s*—\s*(.+)$/.exec(cleanQuote);
  const quoteText = quoteMatch ? quoteMatch[1] : cleanQuote;
  const quoteRef = quoteMatch ? quoteMatch[2] : '';
  const boxTop = y + 20;
  const boxH = 150;

  if (theme.quoteBox === 'filled') {
    ctx.fillStyle = `${navy}14`; // faint tint of navy
    roundRect(ctx, 100, boxTop, CARD_W - 200, boxH, 16);
    ctx.fill();
  }
  ctx.strokeStyle = theme.quoteBox === 'thick' ? navy : '#C9D6E8';
  ctx.lineWidth = theme.quoteBox === 'thick' ? 4 : 2;
  if (theme.quoteBox === 'dotted') ctx.setLineDash([4, 6]);
  roundRect(ctx, 100, boxTop, CARD_W - 200, boxH, 16);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = navy;
  ctx.font = 'italic bold 28px sans-serif';
  drawWrappedCentered(ctx, `"${quoteText}"`, CARD_W - 260, boxTop + 55, 34);
  ctx.font = 'bold 22px sans-serif';
  ctx.fillStyle = gold;
  ctx.fillText(`— ${quoteRef}`, CARD_W / 2, boxTop + boxH - 30);

  // Footer — gold hairline + colored band (shape depends on theme), hashtag
  // pills sitting inside the band (no emblem/wordmark).
  const footerTop = boxTop + boxH + 45;
  const pillH = 50;
  const footerPillY = footerTop + 62;
  const footerBottom = footerPillY + pillH + 45;

  ctx.fillStyle = gold;
  ctx.fillRect(0, footerTop - 6, CARD_W, 6);
  ctx.fillStyle = navy;
  ctx.beginPath();
  if (theme.footer === 'curve') {
    ctx.moveTo(0, footerTop + 30);
    ctx.quadraticCurveTo(CARD_W / 2, footerTop - 30, CARD_W, footerTop + 30);
  } else if (theme.footer === 'wave') {
    ctx.moveTo(0, footerTop + 20);
    ctx.quadraticCurveTo(CARD_W / 4, footerTop - 15, CARD_W / 2, footerTop + 20);
    ctx.quadraticCurveTo((CARD_W / 4) * 3, footerTop + 55, CARD_W, footerTop + 20);
  } else if (theme.footer === 'angle') {
    ctx.moveTo(0, footerTop + 45);
    ctx.lineTo(CARD_W / 2, footerTop);
    ctx.lineTo(CARD_W, footerTop + 45);
  } else if (theme.footer === 'diagonal') {
    ctx.moveTo(0, footerTop + 45);
    ctx.lineTo(CARD_W, footerTop);
  } else {
    ctx.moveTo(0, footerTop + 20);
    ctx.lineTo(CARD_W, footerTop + 20);
  }
  ctx.lineTo(CARD_W, footerBottom);
  ctx.lineTo(0, footerBottom);
  ctx.closePath();
  ctx.fill();

  // Hashtag pills, centered inside the footer band
  const tags = (hashtagBlock || '').split(' ').filter(Boolean);
  ctx.font = 'bold 22px sans-serif';
  const pillPadding = 20;
  const pillGap = 16;
  const widths = tags.map((t) => ctx.measureText(t).width + pillPadding * 2);
  const totalW = widths.reduce((a, b) => a + b, 0) + pillGap * (tags.length - 1);
  let px = CARD_W / 2 - totalW / 2;
  tags.forEach((tag, i) => {
    ctx.fillStyle = pillNavy;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, px, footerPillY, widths[i], pillH, pillH / 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(tag, px + widths[i] / 2, footerPillY + pillH / 2 + 7);
    px += widths[i] + pillGap;
  });

  // Crop the working canvas down to the actual content height.
  const finalCanvas = createCanvas(CARD_W, footerBottom);
  const finalCtx = finalCanvas.getContext('2d');
  finalCtx.drawImage(canvas, 0, 0, CARD_W, footerBottom, 0, 0, CARD_W, footerBottom);

  return finalCanvas.toBuffer('image/png');
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

// Uploads an already-rendered image buffer (the branded card) as an
// *unpublished* Page photo, same pattern as uploadUnpublishedPhoto above.
// Returns the media_fbid on success, or null on failure (logged, not thrown).
async function uploadPhotoBuffer(buffer) {
  try {
    const form = new FormData();
    form.append('published', 'false');
    form.append('access_token', FB_PAGE_ACCESS_TOKEN);
    form.append('source', new Blob([buffer], { type: 'image/png' }), 'birthday-card.png');

    const res = await fetch(`${GRAPH_BASE}/${FB_PAGE_ID}/photos`, { method: 'POST', body: form });
    const json = await res.json();

    if (!res.ok || json.error || !json.id) {
      console.warn(`Card graphic upload failed: ${JSON.stringify(json.error || json)}`);
      return null;
    }

    return json.id;
  } catch (err) {
    console.warn(`Card graphic upload threw: ${err.message}`);
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

  const templateIndex = pickTemplateIndex(celebrants);
  const message = buildMessage(celebrants, templateIndex);
  console.log('--- Birthday post content ---');
  console.log(message);
  console.log(`(message theme #${templateIndex + 1}/${GREETING_TEMPLATES.length} — card design will match)`);
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

  // Prefer posting the branded TGLCC card graphic. If rendering it fails for
  // any reason, fall back to the original behavior (each celebrant's raw
  // photo attached individually) so a post still goes out.
  const mediaFbids = [];
  try {
    const cardBuffer = await generateBirthdayCard(celebrants, message, templateIndex);
    const cardId = await uploadPhotoBuffer(cardBuffer);
    if (cardId) mediaFbids.push(cardId);
  } catch (err) {
    console.warn(`Card graphic generation failed, falling back to raw photos: ${err.message}`);
  }

  if (mediaFbids.length === 0) {
    for (const celebrant of celebrants) {
      const id = await uploadUnpublishedPhoto(celebrant.name, celebrant.photo);
      if (id) mediaFbids.push(id);
    }
  }

  const result = await postToFacebook(message, mediaFbids);
  console.log(`Posted to Facebook. Post ID: ${result.id || result.post_id || '(see response)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
