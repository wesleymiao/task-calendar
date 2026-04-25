const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'tasks.db');

async function start() {
  const SQL = await initSqlJs();

  // Load or create database
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  let db;
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT DEFAULT '', date TEXT NOT NULL, start_time TEXT, end_time TEXT,
    priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'todo', color TEXT DEFAULT '#4F8EF7',
    assignee TEXT DEFAULT '', repeat_type TEXT DEFAULT 'none', repeat_end_date TEXT,
    remind_before INTEGER DEFAULT 15, created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (room_id) REFERENCES rooms(id)
  )`);
  persist();

  function persist() { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  function get(sql, params = []) { const r = all(sql, params); return r[0] || null; }
  function run(sql, params = []) { db.run(sql, params); persist(); }

  // REST API
  app.post('/api/rooms', (req, res) => {
    const id = uuidv4().slice(0, 8);
    const name = req.body.name || 'My Tasks';
    run('INSERT INTO rooms (id, name) VALUES (?, ?)', [id, name]);
    res.json({ id, name });
  });

  app.get('/api/rooms/:id', (req, res) => {
    const room = get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(room);
  });

  app.get('/api/rooms/:roomId/tasks', (req, res) => {
    const { start, end, date } = req.query;
    if (date) return res.json(all('SELECT * FROM tasks WHERE room_id = ? AND date = ? ORDER BY start_time', [req.params.roomId, date]));
    if (start && end) return res.json(all('SELECT * FROM tasks WHERE room_id = ? AND date BETWEEN ? AND ? ORDER BY date, start_time', [req.params.roomId, start, end]));
    res.json(all('SELECT * FROM tasks WHERE room_id = ? ORDER BY date, start_time', [req.params.roomId]));
  });

  app.post('/api/rooms/:roomId/tasks', (req, res) => {
    const id = uuidv4();
    const t = req.body;
    run('INSERT INTO tasks (id,room_id,title,description,date,start_time,end_time,priority,status,color,assignee,repeat_type,repeat_end_date,remind_before) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, req.params.roomId, t.title, t.description||'', t.date, t.start_time||null, t.end_time||null, t.priority||'medium', t.status||'todo', t.color||'#4F8EF7', t.assignee||'', t.repeat_type||'none', t.repeat_end_date||null, t.remind_before??15]);
    const task = { id, room_id: req.params.roomId, ...t };
    io.to(req.params.roomId).emit('task:created', task);
    res.json(task);
  });

  app.put('/api/rooms/:roomId/tasks/:taskId', (req, res) => {
    const t = req.body;
    run(`UPDATE tasks SET title=?,description=?,date=?,start_time=?,end_time=?,priority=?,status=?,color=?,assignee=?,repeat_type=?,repeat_end_date=?,remind_before=?,updated_at=datetime('now') WHERE id=? AND room_id=?`,
      [t.title, t.description||'', t.date, t.start_time||null, t.end_time||null, t.priority||'medium', t.status||'todo', t.color||'#4F8EF7', t.assignee||'', t.repeat_type||'none', t.repeat_end_date||null, t.remind_before??15, req.params.taskId, req.params.roomId]);
    const task = { id: req.params.taskId, room_id: req.params.roomId, ...t };
    io.to(req.params.roomId).emit('task:updated', task);
    res.json(task);
  });

  app.delete('/api/rooms/:roomId/tasks/:taskId', (req, res) => {
    run('DELETE FROM tasks WHERE id = ? AND room_id = ?', [req.params.taskId, req.params.roomId]);
    io.to(req.params.roomId).emit('task:deleted', { id: req.params.taskId });
    res.json({ ok: true });
  });

  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // WebSocket
  io.on('connection', (socket) => {
    socket.on('join', (roomId) => {
      socket.join(roomId);
      const tasks = all('SELECT * FROM tasks WHERE room_id = ? ORDER BY date, start_time', [roomId]);
      socket.emit('tasks:init', tasks);
    });
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch(console.error);
