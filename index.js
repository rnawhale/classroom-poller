import 'dotenv/config';
import fs from 'node:fs/promises';
import http from 'node:http';
import { URL } from 'node:url';
import open from 'open';
import { google } from 'googleapis';
import { format } from 'date-fns';

// Use "me" scopes so it works for student accounts too.
// If you later need teacher-wide access, switch to *.students.* scopes (requires teacher/admin permissions).
const SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly',
  // Some teachers post “homework” as announcements/materials. This lets us read those too.
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
];

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

  // Classroom gives a local date+time w/o timezone. We'll interpret as Asia/Seoul by default.
  // Convert to a Date in UTC by subtracting offset.
  const utcMs = Date.UTC(year, month - 1, day, hour, minute) - tzOffsetMinutes * 60_000;
  return new Date(utcMs);
}

async function startLocalAuth({ clientId, clientSecret }) {
  const redirectUri = 'http://127.0.0.1:53682/oauth2callback';
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  const codePromise = new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const code = u.searchParams.get('code');
        if (!code) {
          res.writeHead(400);
          res.end('Missing code');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK. You can close this tab.');
        server.close();
        resolve(code);
      } catch (e) {
        reject(e);
      }
    });

    server.listen(53682, '127.0.0.1', () => {
      // ready
    });
  });

  console.log('Google OAuth consent URL (open in a browser on THIS machine):');
  console.log(authUrl);
  try {
    await open(authUrl);
  } catch {
    // headless environments: user opens URL manually
  }

  const code = await codePromise;

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  return { oAuth2Client, tokens };
}

async function startDeviceAuth({ clientId, clientSecret }) {
  // OAuth 2.0 Device Authorization Grant
  // User can approve from ANY device (phone), no need for localhost redirect.
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);

  const deviceRes = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      scope: SCOPES.join(' '),
    }),
  });

  const device = await deviceRes.json();
  if (!deviceRes.ok) {
    throw new Error('Device code start failed: ' + JSON.stringify(device));
  }

  console.log('\n=== ACTION REQUIRED (Device Flow) ===');
  console.log('1) Open:', device.verification_url);
  console.log('2) Enter code:', device.user_code);
  console.log('====================================\n');

  const intervalMs = (device.interval || 5) * 1000;
  const expiresAt = Date.now() + (device.expires_in || 600) * 1000;

  while (Date.now() < expiresAt) {
    await new Promise(r => setTimeout(r, intervalMs));

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const tok = await tokenRes.json();
    if (tokenRes.ok) {
      oAuth2Client.setCredentials(tok);
      return { oAuth2Client, tokens: tok };
    }

    if (tok.error === 'authorization_pending' || tok.error === 'slow_down') continue;
    throw new Error('Device token failed: ' + JSON.stringify(tok));
  }

  throw new Error('Device flow timed out');
}

async function main() {
  const clientId = mustGetEnv('GOOGLE_CLIENT_ID');
  const clientSecret = mustGetEnv('GOOGLE_CLIENT_SECRET');

  const tokenPath = process.env.GOOGLE_TOKEN_PATH || './token.json';

  let tokens = null;
  try {
    tokens = JSON.parse(await fs.readFile(tokenPath, 'utf8'));
  } catch {}

  let auth;
  if (tokens?.refresh_token || tokens?.access_token) {
    const redirectUri = 'http://127.0.0.1:53682/oauth2callback';
    const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oAuth2Client.setCredentials(tokens);
    auth = oAuth2Client;
  } else {
    const useDevice = (process.env.GOOGLE_AUTH_METHOD || '').toLowerCase() === 'device';
    const r = useDevice
      ? await startDeviceAuth({ clientId, clientSecret })
      : await startLocalAuth({ clientId, clientSecret });
    auth = r.oAuth2Client;
    await fs.writeFile(tokenPath, JSON.stringify(r.tokens, null, 2));
    console.log('Saved tokens to', tokenPath);
  }

  const classroom = google.classroom({ version: 'v1', auth });

  const coursesRes = await classroom.courses.list({ courseStates: ['ACTIVE'], pageSize: 50 });
  const courses = coursesRes.data.courses || [];
  console.log(`Courses: ${courses.length}`);

  for (const c of courses) {
    console.log(`\n# ${c.name} (id=${c.id})`);

    const cwRes = await classroom.courses.courseWork.list({
      courseId: c.id,
      pageSize: 50,
      courseWorkStates: ['PUBLISHED'],
      orderBy: 'dueDate desc',
    });
    const works = cwRes.data.courseWork || [];
    console.log(`CourseWork: ${works.length}`);

    for (const w of works) {
      const due = googleDueToDate(w.dueDate, w.dueTime);
      const dueStr = due ? format(due, "yyyy-MM-dd HH:mm 'KST'") : 'NO_DUE';
      const topic = w.topicId ? `(topicId:${w.topicId})` : '';
      const link = w.alternateLink || '';
      console.log(`- [CW] ${c.name} | ${dueStr} | ${w.title} ${topic} ${link}`);
    }

    const annRes = await classroom.courses.announcements.list({
      courseId: c.id,
      pageSize: 20,
      orderBy: 'updateTime desc',
    });
    const anns = annRes.data.announcements || [];
    console.log(`Announcements: ${anns.length}`);
    for (const a of anns) {
      const when = a.updateTime || a.creationTime;
      const whenStr = when ? format(new Date(when), "yyyy-MM-dd HH:mm 'KST'") : '';
      const txt = (a.text || '').replace(/\s+/g, ' ').slice(0, 120);
      console.log(`- [ANN] ${c.name} | ${whenStr} | ${txt}`);
    }
  }
}

main().catch((e) => {
  console.error(e?.response?.data || e);
  process.exit(1);
});
