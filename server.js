const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const GOOGLE_URL = process.env.GOOGLE_SHEETS_WEB_APP_URL || '';
const GOOGLE_TOKEN = process.env.GOOGLE_SHEETS_TOKEN || '';
const STUDENT_REFRESH_MS = 60 * 1000;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error('Security error: set ADMIN_EMAIL, ADMIN_PASSWORD, and SESSION_SECRET in your environment before starting the app.');
  process.exit(1);
}

let students = loadStudents();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: 'hackathon.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 8 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

const examState = new Map();
const answers = new Map();
const questionSets = loadQuestions();

function loadStudents() {
  const csv = fs.readFileSync(path.join(__dirname, 'data', 'students.csv'), 'utf8');
  return parse(csv, { columns: true, skip_empty_lines: true, bom: true });
}
async function refreshStudentsFromGoogle() {
  if (!GOOGLE_URL) return;
  try {
    const u = new URL(GOOGLE_URL);
    u.searchParams.set('action', 'students');
    if (GOOGLE_TOKEN) u.searchParams.set('token', GOOGLE_TOKEN);
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Google Sheets returned ${r.status}`);
    const data = await r.json();
    if (Array.isArray(data.students) && data.students.length) {
      students = data.students;
      console.log(`Loaded ${students.length} students from Google Sheets.`);
    }
  } catch (err) {
    console.error('Google Sheets student sync failed:', err.message);
  }
}

async function pushResponseToGoogle(payload) {
  if (!GOOGLE_URL) return;
  try {
    const body = { ...payload };
    if (GOOGLE_TOKEN) body.token = GOOGLE_TOKEN;
    await fetch(GOOGLE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    console.error('Google Sheets response sync failed:', err.message);
  }
}

function loadQuestions() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'questions.json'), 'utf8'));
}
function normalize(s) { return String(s || '').trim().toLowerCase(); }
function normalizeDob(s) { return String(s || '').trim().replace(/-/g, '/'); }
function studentKey(email) { return normalize(email); }
function requireStudent(req, res, next) { if (!req.session.student) return res.status(401).json({ error: 'Student login required' }); next(); }
function requireAdmin(req, res, next) { if (!req.session.admin) return res.status(401).json({ error: 'Admin login required' }); next(); }
function shuffle(items, seed) {
  const a = items.slice(); let x = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) { x = (1664525 * x + 1013904223) >>> 0; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function seedFor(email, round) { let h = 2166136261; for (const c of email + ':' + round) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
function publicQuestions(round, email) {
  const list = questionSets[round].map(q => ({ id: q.id, question: q.question, options: q.options, section: q.section }));
  return shuffle(list, seedFor(email, round));
}
function allQuestionMap() { return Object.values(questionSets).flat().reduce((m, q) => (m[q.id] = q, m), {}); }
function now() { return Date.now(); }

app.get('/api/config', (req, res) => res.json({ round1Minutes: 45, round2Minutes: 90, round1Count: questionSets.round1.length, round2Count: questionSets.round2.length, googleSheetsConfigured: !!GOOGLE_URL }));

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (normalize(email) === normalize(ADMIN_EMAIL) && password === ADMIN_PASSWORD) { req.session.admin = { email: ADMIN_EMAIL }; return res.json({ ok: true }); }
  res.status(401).json({ error: 'Invalid admin credentials' });
});
app.post('/api/admin/logout', (req, res) => { delete req.session.admin; res.json({ ok: true }); });
app.get('/api/admin/me', requireAdmin, (req, res) => res.json(req.session.admin));
app.get('/api/admin/students', requireAdmin, (req, res) => res.json(students));
app.get('/api/admin/questions', requireAdmin, (req, res) => res.json(questionSets));
app.get('/api/admin/live', requireAdmin, (req, res) => {
  const live = [...examState.values()].filter(x => x.status === 'active').map(x => ({ ...x, answers: undefined }));
  res.json(live);
});
app.get('/api/admin/responses', requireAdmin, (req, res) => res.json([...answers.values()]));
app.get('/api/admin/results', requireAdmin, (req, res) => res.json(buildResults()));

app.post('/api/student/login', async (req, res) => {
  await refreshStudentsFromGoogle();
  const email = normalize(req.body.email); const dob = normalizeDob(req.body.dob);
  const student = students.find(s => normalize(s['Email Adress']) === email && normalizeDob(s['Date Of Birth']) === dob);
  if (!student) return res.status(401).json({ error: 'Email and Date of Birth do not match our registration records.' });
  req.session.student = { email, name: student['Full Name'], regNo: student['Reg No'] };
  const key = studentKey(email);
  if (!examState.has(key)) examState.set(key, { email, name: student['Full Name'], regNo: student['Reg No'], status: 'instructions', currentRound: 0, startedAt: null, round1StartedAt: null, round2StartedAt: null, completedAt: null });
  res.json({ ok: true, student: req.session.student, state: examState.get(key) });
});
app.post('/api/student/logout', requireStudent, (req, res) => { delete req.session.student; res.json({ ok: true }); });
app.get('/api/student/me', requireStudent, (req, res) => { const state = examState.get(studentKey(req.session.student.email)); res.json({ student: req.session.student, state }); });
app.post('/api/student/accept-instructions', requireStudent, (req, res) => {
  const key = studentKey(req.session.student.email); const s = examState.get(key);
  if (!s || s.status !== 'instructions') return res.status(400).json({ error: 'Instructions have already been accepted or exam has started.' });
  s.status = 'active'; s.currentRound = 1; s.startedAt = now(); s.round1StartedAt = s.startedAt;
  answers.set(key, { email: s.email, name: s.name, regNo: s.regNo, saved: {}, updatedAt: now(), violations: 0 });
  io.emit('exam-status', s);
  res.json({ ok: true, state: s });
});
app.get('/api/student/round/:round', requireStudent, (req, res) => {
  const round = 'round' + Number(req.params.round); const s = examState.get(studentKey(req.session.student.email));
  if (!s || s.status !== 'active' || !['round1','round2'].includes(round)) return res.status(400).json({ error: 'Round unavailable.' });
  if (s.currentRound !== Number(req.params.round)) return res.status(403).json({ error: 'This round is not active.', currentRound: s.currentRound });
  res.json({ questions: publicQuestions(round, req.session.student.email), saved: answers.get(studentKey(req.session.student.email))?.saved || {}, startedAt: s[round + 'StartedAt'], durationMinutes: round === 'round1' ? 45 : 90 });
});
app.post('/api/student/save-answer', requireStudent, (req, res) => {
  const { questionId, option, round } = req.body; const key = studentKey(req.session.student.email); const s = examState.get(key);
  if (!s || s.status !== 'active' || s.currentRound !== Number(round)) return res.status(403).json({ error: 'Round is not active.' });
  const q = allQuestionMap()[questionId]; if (!q || !q.options.includes(option)) return res.status(400).json({ error: 'Invalid question or option.' });
  const rec = answers.get(key); rec.saved[questionId] = { option, round: Number(round), savedAt: now() }; rec.updatedAt = now();
  const livePayload = { email: rec.email, name: rec.name, regNo: rec.regNo, questionId, option, round: Number(round), savedAt: rec.saved[questionId].savedAt };
  io.emit('live-response', livePayload);
  pushResponseToGoogle(livePayload);
  res.json({ ok: true });
});
app.post('/api/student/violation', requireStudent, (req, res) => { const rec = answers.get(studentKey(req.session.student.email)); if (rec) { rec.violations = (rec.violations || 0) + 1; rec.updatedAt = now(); } res.json({ ok: true }); });
app.post('/api/student/next-round', requireStudent, (req, res) => {
  const key = studentKey(req.session.student.email); const s = examState.get(key); if (!s || s.status !== 'active' || s.currentRound !== 1) return res.status(400).json({ error: 'Round 1 is not ready.' });
  if (now() - s.round1StartedAt < 45 * 60 * 1000) return res.status(403).json({ error: 'Round 1 time has not expired yet.' });
  s.currentRound = 2; s.round2StartedAt = now(); io.emit('exam-status', s); res.json({ ok: true, state: s });
});
app.post('/api/student/complete', requireStudent, (req, res) => {
  const key = studentKey(req.session.student.email); const s = examState.get(key); if (!s || s.status !== 'active' || s.currentRound !== 2) return res.status(400).json({ error: 'Round 2 is not active.' });
  if (now() - s.round2StartedAt < 90 * 60 * 1000) return res.status(403).json({ error: 'Round 2 time has not expired yet.' });
  s.status = 'completed'; s.completedAt = now(); io.emit('exam-status', s); res.json({ ok: true, result: buildResults().find(r => r.email === s.email) });
});
app.post('/api/student/feedback', requireStudent, (req, res) => { fs.appendFileSync(path.join(__dirname,'data','feedback.jsonl'), JSON.stringify({ ...req.body, ...req.session.student, submittedAt: now() })+'\n'); res.json({ ok: true }); });

function buildResults() {
  const qm = allQuestionMap();
  return [...answers.values()].map(rec => {
    let r1=0,r2=0,total=0,attempted=0; const detail=[];
    for (const [qid,a] of Object.entries(rec.saved || {})) { const q=qm[qid]; const correct=q.correct===a.option; if (correct) { total++; if(a.round===1) r1++; else r2++; } attempted++; detail.push({questionId:qid,round:a.round,selected:a.option,correctAnswer:q.correct,isCorrect:correct}); }
    const s=examState.get(studentKey(rec.email)); return {email:rec.email,name:rec.name,regNo:rec.regNo,round1Score:r1,round2Score:r2,totalScore:total,attempted,violations:rec.violations||0,status:s?.status||'unknown',detail};
  });
}

refreshStudentsFromGoogle();
setInterval(refreshStudentsFromGoogle, STUDENT_REFRESH_MS);

io.on('connection', socket => { socket.on('admin-join', () => {}); });
setInterval(() => {
  const t=now();
  for (const s of examState.values()) {
    if (s.status==='active' && s.currentRound===1 && t-s.round1StartedAt >= 45*60*1000) { s.currentRound=2; s.round2StartedAt=t; io.emit('exam-status',s); }
    else if (s.status==='active' && s.currentRound===2 && t-s.round2StartedAt >= 90*60*1000) { s.status='completed'; s.completedAt=t; io.emit('exam-status',s); }
  }
}, 1000);

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Hackathon site listening on http://localhost:${PORT}`);
});
