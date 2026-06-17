const Database = require('better-sqlite3');
const db = new Database('/home/choco/.config/AionUi/aionui/aionui-backend.db');
const rows = db.prepare("SELECT content FROM messages WHERE type = 'assistant' ORDER BY created_at DESC LIMIT 50").all();
for (const r of rows) {
    if (r.content.includes('"tool_use"')) {
        console.log(r.content);
    }
}
