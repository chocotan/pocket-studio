const Database = require('better-sqlite3');
const db = new Database('/home/choco/.config/AionUi/aionui/aionui-backend.db');
const rows = db.prepare("SELECT content FROM messages WHERE type = 'tool.call' ORDER BY created_at DESC LIMIT 5").all();
for (const r of rows) {
    console.log(r.content);
}
