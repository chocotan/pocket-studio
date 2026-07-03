const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const dbPath = path.join(os.homedir(), '.config/AionUi/aionui/aionui-backend.db');
const db = new Database(dbPath);
const rows = db.prepare("SELECT content FROM messages WHERE type = 'tool.call' ORDER BY created_at DESC LIMIT 5").all();
for (const r of rows) {
    console.log(r.content);
}
