const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 5001;
const DB_PATH = path.join(__dirname, 'tasks.db');

// Open DB
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Could not open database', err);
    process.exit(1);
  }
  console.log('Connected to SQLite database:', DB_PATH);
});

// Initialize table (and add missing columns when needed)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    completed INTEGER DEFAULT 0,
    priority TEXT DEFAULT 'Normal',
    category TEXT,
    due_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    position INTEGER DEFAULT 0
  )`, (err) => {
    if (err) console.error('Table creation error:', err);
  });

  // Ensure columns exist (safe migration for older DBs)
  const expectedColumns = {
    description: "TEXT",
    priority: "TEXT",
    category: "TEXT",
    due_date: "TEXT",
    created_at: "TEXT",
    completed_at: "TEXT",
    position: "INTEGER"
  };

  db.all(`PRAGMA table_info(tasks)`, (err, rows) => {
    if (err) return console.error('PRAGMA error', err);
    
    const existing = rows.map(r => r.name);
    Object.keys(expectedColumns).forEach(col => {
      if (!existing.includes(col)) {
        db.run(`ALTER TABLE tasks ADD COLUMN ${col} ${expectedColumns[col]}`, (err) => {
          if (err) console.error(`Failed to add column ${col}:`, err);
          else console.log(`Added missing column: ${col}`);
        });
      }
    });
  });
});

app.use(express.json());

// CORS for local dev (adjust in production)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:3000'); // frontend origin
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Basic health
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    database: 'SQLite',
    message: 'Task Manager API'
  });
});

/**
 * GET /tasks
 * Query params:
 * - q (search in title/description)
 * - completed (0/1)
 * - category
 * - priority
 * - sort (created_at|due_date|priority|title|position) + order (asc|desc)
 * - page (1...), limit (default 50)
 */
app.get('/tasks', (req, res) => {
  let { q, completed, category, priority, sort, order, page, limit } = req.query;
  let conditions = [];
  let params = [];

  if (q) {
    conditions.push(`(title LIKE ? OR description LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`);
  }
  if (completed !== undefined) {
    conditions.push('completed = ?');
    params.push(completed === '1' || completed === 'true' ? 1 : 0);
  }
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  if (priority) {
    conditions.push('priority = ?');
    params.push(priority);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  
  const sortMap = {
    created_at: 'created_at',
    due_date: 'due_date',
    priority: "CASE WHEN priority='High' THEN 1 WHEN priority='Normal' THEN 2 ELSE 3 END",
    title: 'LOWER(title)',
    position: 'position'
  };
  
  const sortCol = sortMap[sort] || 'position';
  order = (order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  
  page = parseInt(page) || 1;
  limit = parseInt(limit) || 100;
  const offset = (page - 1) * limit;
  
  const sql = `SELECT * FROM tasks ${where} ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`;
  
  db.all(sql, [...params, limit, offset], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error', details: err });
    res.json(rows);
  });
});

// Create task
app.post('/tasks', (req, res) => {
  const {
    title,
    description = '',
    priority = 'Normal',
    category = '',
    due_date = null,
    position = 0
  } = req.body;

  if (!title || !title.trim()) return res.status(400).json({ error: 'Task title is required' });

  db.run(
    `INSERT INTO tasks (title, description, priority, category, due_date, position)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [title.trim(), description, priority, category, due_date, position],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to create task', details: err });
      
      db.get('SELECT * FROM tasks WHERE id = ?', [this.lastID], (err2, row) => {
        if (err2) return res.status(500).json({ error: 'Failed to fetch new task', details: err2 });
        res.status(201).json(row);
      });
    }
  );
});

// Update task (full update)
app.put('/tasks/:id', (req, res) => {
  const taskId = parseInt(req.params.id);
  if (isNaN(taskId)) return res.status(400).json({ error: 'Invalid task ID' });

  const {
    title,
    description = '',
    completed = false,
    priority = 'Normal',
    category = '',
    due_date = null,
    position = 0
  } = req.body;

  if (!title || !title.trim()) return res.status(400).json({ error: 'Task title is required' });

  const completedInt = completed ? 1 : 0;
  const completedAt = completed ? new Date().toISOString() : null;

  db.run(
    `UPDATE tasks 
     SET title = ?, description = ?, completed = ?, priority = ?, 
         category = ?, due_date = ?, position = ?, completed_at = ? 
     WHERE id = ?`,
    [title.trim(), description, completedInt, priority, category, due_date, position, completedAt, taskId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to update task', details: err });
      if (this.changes === 0) return res.status(404).json({ error: 'Task not found' });
      
      db.get('SELECT * FROM tasks WHERE id = ?', [taskId], (err2, row) => {
        if (err2) return res.status(500).json({ error: 'Failed to fetch updated task', details: err2 });
        res.json(row);
      });
    }
  );
});

// Partial update (toggle / patch)
app.patch('/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid task ID' });

  const fields = [];
  const params = [];

  if (req.body.title !== undefined) {
    fields.push('title = ?');
    params.push(req.body.title.trim());
  }
  if (req.body.description !== undefined) {
    fields.push('description = ?');
    params.push(req.body.description);
  }
  if (req.body.priority !== undefined) {
    fields.push('priority = ?');
    params.push(req.body.priority);
  }
  if (req.body.category !== undefined) {
    fields.push('category = ?');
    params.push(req.body.category);
  }
  if (req.body.due_date !== undefined) {
    fields.push('due_date = ?');
    params.push(req.body.due_date);
  }
  if (req.body.position !== undefined) {
    fields.push('position = ?');
    params.push(req.body.position);
  }
  if (req.body.completed !== undefined) {
    const completedInt = req.body.completed ? 1 : 0;
    fields.push('completed = ?', 'completed_at = ?');
    params.push(completedInt, (req.body.completed ? new Date().toISOString() : null));
  }

  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

  const sql = `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`;
  params.push(id);

  db.run(sql, params, function (err) {
    if (err) return res.status(500).json({ error: 'Failed to update task', details: err });
    if (this.changes === 0) return res.status(404).json({ error: 'Task not found' });
    
    db.get('SELECT * FROM tasks WHERE id = ?', [id], (err2, row) => {
      if (err2) return res.status(500).json({ error: 'Failed to fetch updated task', details: err2 });
      res.json(row);
    });
  });
});

// Delete
app.delete('/tasks/:id', (req, res) => {
  const taskId = parseInt(req.params.id);
  if (isNaN(taskId)) return res.status(400).json({ error: 'Invalid task ID' });

  db.run('DELETE FROM tasks WHERE id = ?', [taskId], function (err) {
    if (err) return res.status(500).json({ error: 'Failed to delete task', details: err });
    if (this.changes === 0) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true, message: 'Task deleted' });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
