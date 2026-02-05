import 'dotenv/config';
import fs from 'node:fs/promises';
import { google } from 'googleapis';

// Data format consumed by docs/index.html
// {
//   generatedAt: ISO,
//   groups: [{ name, items: [{id,title,link,dueAt,topic}]}]
// }

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

  const groups = [];

  for (const c of courses) {
    const items = [];

    // CourseWork (if permitted)
    try {
      const cwRes = await classroom.courses.courseWork.list({
        courseId: c.id,
        pageSize: 50,
        courseWorkStates: ['PUBLISHED'],
        orderBy: 'dueDate desc',
      });
      for (const w of (cwRes.data.courseWork || [])) {
        const due = googleDueToDate(w.dueDate, w.dueTime);
        items.push({
          id: `cw:${c.id}:${w.id}`,
          title: w.title,
          link: w.alternateLink,
          dueAt: due ? due.toISOString() : null,
          topic: w.workType || 'COURSEWORK',
        });
      }
    } catch {
      // ignore
    }

    // Announcements (often used as homework posts)
    try {
      const annRes = await classroom.courses.announcements.list({
        courseId: c.id,
        pageSize: 50,
        orderBy: 'updateTime desc',
      });
      for (const a of (annRes.data.announcements || [])) {
        const txt = (a.text || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;

        // Very light filter: keep ones likely related to homework/assignment.
        const hay = txt.toLowerCase();
        const looksLikeHomework =
          hay.includes('homework') ||
          hay.includes('assignment') ||
          hay.includes('due') ||
          hay.includes('quiz') ||
          hay.includes('test') ||
          hay.includes('read') ||
          hay.includes('watch') ||
          hay.includes('worksheet');

        if (!looksLikeHomework) continue;

        items.push({
          id: `ann:${c.id}:${a.id}`,
          title: txt.length > 120 ? txt.slice(0, 117) + '…' : txt,
          link: c.alternateLink || null,
          dueAt: null,
          topic: 'ANNOUNCEMENT',
        });
      }
    } catch {
      // ignore
    }

    // Sort: due date first, then title
    items.sort((a, b) => {
      const ad = a.dueAt ? Date.parse(a.dueAt) : Infinity;
      const bd = b.dueAt ? Date.parse(b.dueAt) : Infinity;
      if (ad !== bd) return ad - bd;
      return (a.title || '').localeCompare(b.title || '');
    });

    groups.push({ name: c.name, items });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    groups,
  };

  await fs.mkdir('./docs', { recursive: true });
  await fs.writeFile('./docs/data.json', JSON.stringify(out, null, 2));
  console.log('Wrote docs/data.json');
}

main().catch((e) => {
  console.error(e?.response?.data || e);
  process.exit(1);
});
