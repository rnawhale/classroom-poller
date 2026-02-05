import 'dotenv/config';
import fs from 'node:fs/promises';
import { google } from 'googleapis';

// Data format consumed by docs/index.html
// docs/days/YYYY-MM-DD.json
// {
//   generatedAt: ISO,
//   day: "YYYY-MM-DD" (KST),
//   groups: [{ name, items: [{id,title,link,dueAt,topic,createdAt}]}]
// }
//
// docs/days/index.json
// { generatedAt, latestDay, days: [{day,label}] }

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function googleDueToDate(dueDate, dueTime, tzOffsetMinutes = 9 * 60) {
  if (!dueDate) return null;
  const year = dueDate.year;
  const month = dueDate.month; // 1-12
  const day = dueDate.day;
  const hour = dueTime?.hours ?? 23;
  const minute = dueTime?.minutes ?? 59;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute) - tzOffsetMinutes * 60_000;
  return new Date(utcMs);
}

function kstDayKey(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const da = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${da}`;
}

function kstLabel(dayKey) {
  // YYYY-MM-DD -> YYYY.MM.DD
  return dayKey.replace(/-/g, '.');
}

async function main() {
  const clientId = mustGetEnv('GOOGLE_CLIENT_ID');
  const clientSecret = mustGetEnv('GOOGLE_CLIENT_SECRET');
  const tokenPath = process.env.GOOGLE_TOKEN_PATH || './token.json';

  const tokens = JSON.parse(await fs.readFile(tokenPath, 'utf8'));
  const redirectUri = 'http://127.0.0.1:53682/oauth2callback';
  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  auth.setCredentials(tokens);

  const classroom = google.classroom({ version: 'v1', auth });

  const coursesRes = await classroom.courses.list({ courseStates: ['ACTIVE'], pageSize: 20 });
  const courses = coursesRes.data.courses || [];

  // dayKey -> courseName -> items[]
  const dayBuckets = new Map();

  function pushItem(dayKey, courseName, item) {
    if (!dayBuckets.has(dayKey)) dayBuckets.set(dayKey, new Map());
    const byCourse = dayBuckets.get(dayKey);
    if (!byCourse.has(courseName)) byCourse.set(courseName, []);
    byCourse.get(courseName).push(item);
  }

  for (const c of courses) {
    // CourseWork (if permitted)
    try {
      const cwRes = await classroom.courses.courseWork.list({
        courseId: c.id,
        pageSize: 50,
        courseWorkStates: ['PUBLISHED'],
        orderBy: 'updateTime desc',
      });
      for (const w of (cwRes.data.courseWork || [])) {
        const whenIso = w.updateTime || w.creationTime;
        const when = whenIso ? new Date(whenIso) : new Date();
        const dayKey = kstDayKey(when);

        const due = googleDueToDate(w.dueDate, w.dueTime);
        pushItem(dayKey, c.name, {
          id: `cw:${c.id}:${w.id}`,
          title: w.title,
          link: w.alternateLink,
          dueAt: due ? due.toISOString() : null,
          topic: w.workType || 'COURSEWORK',
          createdAt: when.toISOString(),
        });
      }
    } catch {
      // ignore
    }

    // Announcements
    try {
      const annRes = await classroom.courses.announcements.list({
        courseId: c.id,
        pageSize: 200,
        orderBy: 'updateTime desc',
      });

      for (const a of (annRes.data.announcements || [])) {
        const txt = (a.text || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;

        const whenIso = a.updateTime || a.creationTime;
        const when = whenIso ? new Date(whenIso) : new Date();
        const dayKey = kstDayKey(when);

        // For now: include all announcements in archives.
        // We'll tighten “homework-only” filtering after we review examples.
        pushItem(dayKey, c.name, {
          id: `ann:${c.id}:${a.id}`,
          title: txt.length > 120 ? txt.slice(0, 117) + '…' : txt,
          link: c.alternateLink || null,
          dueAt: null,
          topic: 'ANNOUNCEMENT',
          createdAt: when.toISOString(),
        });
      }
    } catch {
      // ignore
    }
  }

  const days = Array.from(dayBuckets.keys()).sort();
  const latestDay = days[days.length - 1] || null;

  await fs.mkdir('./docs/days', { recursive: true });

  for (const dayKey of days) {
    const byCourse = dayBuckets.get(dayKey);

    const groups = Array.from(byCourse.entries()).map(([name, items]) => {
      items.sort((a, b) => {
        // Newest first within a day
        const at = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
        if (at !== bt) return bt - at;
        return (a.title || '').localeCompare(b.title || '');
      });
      return { name, items };
    });

    const out = {
      generatedAt: new Date().toISOString(),
      day: dayKey,
      groups,
    };

    await fs.writeFile(`./docs/days/${dayKey}.json`, JSON.stringify(out, null, 2));
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    latestDay,
    days: days.map(d => ({ day: d, label: kstLabel(d) })),
  };
  await fs.writeFile('./docs/days/index.json', JSON.stringify(manifest, null, 2));

  console.log('Wrote docs/days/*.json and docs/days/index.json');
}

main().catch((e) => {
  console.error(e?.response?.data || e);
  process.exit(1);
});
