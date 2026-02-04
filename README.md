# classroom-poller

Minimal local poller to list Google Classroom courses + coursework (for checklist generation).

## Setup
1) Create `.env` from `.env.example`.
2) Run:

```bash
npm run poll
```

First run opens a browser for Google OAuth consent, then saves tokens to `GOOGLE_TOKEN_PATH`.

## Notes
- Scopes are read-only.
- Due date/time from Classroom is interpreted as Asia/Seoul (KST) by default.
