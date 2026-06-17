const Database = require('better-sqlite3');
const db = new Database('/home/choco/.config/AionUi/aionui/aionui-backend.db');
const rows = db.prepare("SELECT content FROM messages WHERE type = 'acp_tool_call' ORDER BY created_at DESC LIMIT 5").all();
rows.forEach(r => console.log(r.content.substring(0, 500) + "\n---\n"));
