-- zip 359: in-facility staff chat (the server also creates this by itself on first use; this migration is a safety net)
CREATE TABLE IF NOT EXISTS chat_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, ch TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chat_ch ON chat_msgs (ch, id);
CREATE INDEX IF NOT EXISTS idx_chat_from ON chat_msgs (from_id, ts);
