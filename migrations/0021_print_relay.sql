-- zip 397: the print network's device list and per-device job queues move from KV to D1.
-- Every open till heartbeats its device in (and a printer device polls its queue every few seconds); on KV each
-- heartbeat was a billed write. One row per shop for the device list, one row per device for its queue - the same
-- JSON the KV keys held, so nothing else changes. (print-relay.js creates these itself if this migration has not run.)
CREATE TABLE IF NOT EXISTS relay_devices (
  client_id TEXT NOT NULL PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS relay_queues (
  client_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, device_id)
) WITHOUT ROWID;
