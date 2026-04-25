const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
const db = new Database(path.join(__dirname, 'data', 'tasks.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
    status TEXT DEFAULT 'todo' CHECK(status IN ('todo','in_progress','done')),
    color TEXT DEFAULT '#4F8EF7',
    assignee TEXT DEFAULT '',
    repeat_type TEXT DEFAULT 'none' CHECK(repeat_type IN ('none','daily','weekly','monthly','weekdays','custom')),
    repeat_end_date TEXT,
    remind_before INTEGER DEFAULT 15,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (room_id) REFERENCES rooms(id)
  );
`);

// Prepared statements
const stmts = {
  createRoom: db.prepare('INSERT INTO rooms (id, name) VALUES (?, ?)'),
  getRoom: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  getTasks: db.prepare('SELECT * FROM tasks WHERE room_id = ? ORDER BY date, start_time'),
  getTasksByDate: db.prepare('SELECT * FROM tasks WHERE room_id = ? AND date = ? ORDER BY start_time'),
  getTasksByRange: db.prepare('SELECT * FROM tasks WHERE room_id = ? AND date BETWEEN ? AND ? ORDER BY date, start_time'),
  createTask: db.prepare(`INSERT INTO tasks (id, room_id, title, description, date, start_time, end_time, priority, status, color, assignee, repeat_type, repeat_end_date, remind_before) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateTask: db.prepare(`UPDATE tasks SET title=?, description=?, date=?, start_time=?, end_time=?, priority=?, status=?, color=?, assignee=?, repeat_type=?, repeat_end_date=?, remind_before=?, updated_at=datetime('now') WHERE id=? AND room_id=?`),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ? AND room_id = ?'),
};

// REST API
app.post('/api/rooms', (req, res) => {
  const id = uuidv4().slice(0, 8);
  const name = req.body.name || 'My Tasks';
  stmts.createRoom.run(id, name);
  res.json({ id, name });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = stmts.getRoom.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room);
});

app.get('/api/rooms/:roomId/tasks', (req, res) => {
  const { start, end, date } = req.query;
  if (date) return res.json(stmts.getTasksByDate.all(req.params.roomId, date));
  if (start && end) return res.json(stmts.getTasksByRange.all(req.params.roomId, start, end));
  res.json(stmts.getTasks.all(req.params.roomId));
});

app.post('/api/rooms/:roomId/tasks', (req, res) => {
  const id = uuidv4();
  const t = req.body;
  stmts.createTask.run(id, req.params.roomId, t.title, t.description || '', t.date, t.start_time || null, t.end_time || null, t.priority || 'medium', t.status || 'todo', t.color || '#4F8EF7', t.assignee || '', t.repeat_type || 'none', t.repeat_end_date || null, t.remind_before ?? 15);
  const task = { id, room_id: req.params.roomId, ...t };
  io.to(req.params.roomId).emit('task:created', task);
  res.json(task);
});

app.put('/api/rooms/:roomId/tasks/:taskId', (req, res) => {
  const t = req.body;
  stmts.updateTask.run(t.title, t.description || '', t.date, t.start_time || null, t.end_time || null, t.priority || 'medium', t.status || 'todo', t.color || '#4F8EF7', t.assignee || '', t.repeat_type || 'none', t.repeat_end_date || null, t.remind_before ?? 15, req.params.taskId, req.params.roomId);
  const task = { id: req.params.taskId, room_id: req.params.roomId, ...t };
  io.to(req.params.roomId).emit('task:updated', task);
  res.json(task);
});

app.delete('/api/rooms/:roomId/tasks/:taskId', (req, res) => {
  stmts.deleteTask.run(req.params.taskId, req.params.roomId);
  io.to(req.params.roomId).emit('task:deleted', { id: req.params.taskId });
  res.json({ ok: true });
});

// Fallback to index.html for SPA
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket
io.on('connection', (socket) => {
  socket.on('join', (roomId) => {
    socket.join(roomId);
    socket.roomId = roomId;
    const tasks = stmts.getTasks.all(roomId);
    socket.emit('tasks:init', tasks);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
