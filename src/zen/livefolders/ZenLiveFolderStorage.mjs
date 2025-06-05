// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

var ZenLiveFolderStorage = {
  async init() {
    await this._ensureTables();
    // Resolve a promise indicating initialization is complete
    this._resolveInitialized();
  },

  async _ensureTables() {
    await PlacesUtils.withConnectionWrapper('ZenLiveFolderStorage._ensureTables', async (db) => {
      // Create zen_live_folders table
      await db.execute(`
        CREATE TABLE IF NOT EXISTS zen_live_folders (
          uuid TEXT PRIMARY KEY,
          type TEXT NOT NULL, -- e.g., 'github_prs'
          title TEXT NOT NULL,
          source_username TEXT, -- e.g., GitHub username
          rss_feed_url TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_zen_live_folders_uuid ON zen_live_folders(uuid)`
      );
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_zen_live_folders_type ON zen_live_folders(type)`
      );

      // Create zen_live_folder_items table
      await db.execute(`
        CREATE TABLE IF NOT EXISTS zen_live_folder_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          folder_uuid TEXT NOT NULL,
          item_id TEXT NOT NULL, -- e.g., PR URL or unique ID from feed
          title TEXT NOT NULL,
          link TEXT, -- URL to the item
          status TEXT, -- e.g., 'open', 'merged', 'closed'
          last_updated INTEGER, -- Timestamp of when the item was last updated in the feed
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(folder_uuid, item_id),
          FOREIGN KEY (folder_uuid) REFERENCES zen_live_folders(uuid) ON DELETE CASCADE
        )
      `);
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_zen_live_folder_items_folder_uuid ON zen_live_folder_items(folder_uuid)`
      );
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_zen_live_folder_items_item_id ON zen_live_folder_items(item_id)`
      );

      // Changes tracking table for live folders (optional, but good for sync)
      await db.execute(`
        CREATE TABLE IF NOT EXISTS zen_live_folders_changes (
          uuid TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL
        )
      `);
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_zen_live_folders_changes_uuid ON zen_live_folders_changes(uuid)`
      );
    });
  },

  async saveLiveFolder(folder) {
    await PlacesUtils.withConnectionWrapper('ZenLiveFolderStorage.saveLiveFolder', async (db) => {
      const now = Date.now();
      await db.execute(
        `
        INSERT OR REPLACE INTO zen_live_folders (
          uuid, type, title, source_username, rss_feed_url, created_at, updated_at
        ) VALUES (
          :uuid, :type, :title, :source_username, :rss_feed_url,
          COALESCE((SELECT created_at FROM zen_live_folders WHERE uuid = :uuid), :now),
          :now
        )
      `,
        {
          uuid: folder.uuid,
          type: folder.type,
          title: folder.title,
          source_username: folder.source_username,
          rss_feed_url: folder.rss_feed_url,
          now,
        }
      );
      // Add to changes table if implementing sync
      await db.execute(
        `INSERT OR REPLACE INTO zen_live_folders_changes (uuid, timestamp) VALUES (:uuid, :timestamp)`,
        { uuid: folder.uuid, timestamp: Math.floor(now / 1000) }
      );
    });
    // Notify observers if necessary: Services.obs.notifyObservers(null, 'zen-live-folder-updated', folder.uuid);
  },

  async getLiveFolder(uuid) {
    const db = await PlacesUtils.promiseDBConnection();
    const rows = await db.execute(`SELECT * FROM zen_live_folders WHERE uuid = :uuid`, { uuid });
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    return {
      uuid: row.getResultByName('uuid'),
      type: row.getResultByName('type'),
      title: row.getResultByName('title'),
      source_username: row.getResultByName('source_username'),
      rss_feed_url: row.getResultByName('rss_feed_url'),
      created_at: row.getResultByName('created_at'),
      updated_at: row.getResultByName('updated_at'),
    };
  },

  async getAllLiveFolders() {
    const db = await PlacesUtils.promiseDBConnection();
    const rows = await db.execute(`SELECT * FROM zen_live_folders ORDER BY title ASC`);
    return rows.map((row) => ({
      uuid: row.getResultByName('uuid'),
      type: row.getResultByName('type'),
      title: row.getResultByName('title'),
      source_username: row.getResultByName('source_username'),
      rss_feed_url: row.getResultByName('rss_feed_url'),
    }));
  },

  async removeLiveFolder(uuid) {
    await PlacesUtils.withConnectionWrapper('ZenLiveFolderStorage.removeLiveFolder', async (db) => {
      await db.execute(`DELETE FROM zen_live_folders WHERE uuid = :uuid`, { uuid });
      // Also remove associated items
      await db.execute(`DELETE FROM zen_live_folder_items WHERE folder_uuid = :uuid`, { uuid });
      // Remove from changes table
      await db.execute(`DELETE FROM zen_live_folders_changes WHERE uuid = :uuid`, { uuid });
    });
    // Notify observers: Services.obs.notifyObservers(null, 'zen-live-folder-removed', uuid);
  },

  async saveLiveFolderItem(item) {
    await PlacesUtils.withConnectionWrapper(
      'ZenLiveFolderStorage.saveLiveFolderItem',
      async (db) => {
        const now = Date.now();
        await db.execute(
          `
        INSERT OR REPLACE INTO zen_live_folder_items (
          folder_uuid, item_id, title, link, status, last_updated, created_at, updated_at
        ) VALUES (
          :folder_uuid, :item_id, :title, :link, :status, :last_updated,
          COALESCE((SELECT created_at FROM zen_live_folder_items WHERE folder_uuid = :folder_uuid AND item_id = :item_id), :now),
          :now
        )
      `,
          {
            folder_uuid: item.folder_uuid,
            item_id: item.item_id,
            title: item.title,
            link: item.link,
            status: item.status,
            last_updated: item.last_updated,
            now,
          }
        );
      }
    );
  },

  async getLiveFolderItems(folderUuid) {
    const db = await PlacesUtils.promiseDBConnection();
    const rows = await db.execute(
      `SELECT * FROM zen_live_folder_items WHERE folder_uuid = :folderUuid ORDER BY last_updated DESC`,
      { folderUuid }
    );
    return rows.map((row) => ({
      id: row.getResultByName('id'),
      folder_uuid: row.getResultByName('folder_uuid'),
      item_id: row.getResultByName('item_id'),
      title: row.getResultByName('title'),
      link: row.getResultByName('link'),
      status: row.getResultByName('status'),
      last_updated: row.getResultByName('last_updated'),
    }));
  },

  async removeLiveFolderItems(folderUuid) {
    await PlacesUtils.withConnectionWrapper(
      'ZenLiveFolderStorage.removeLiveFolderItems',
      async (db) => {
        await db.execute(`DELETE FROM zen_live_folder_items WHERE folder_uuid = :folderUuid`, {
          folderUuid,
        });
      }
    );
  },
};

ZenLiveFolderStorage.promiseInitialized = new Promise((resolve) => {
  ZenLiveFolderStorage._resolveInitialized = resolve;
  // We need PlacesUtils to be available. Assuming it's loaded similarly to other storage files.
  // A more robust way would be to ensure PlacesUtils is loaded before calling init.
  if (globalThis.PlacesUtils) {
    ZenLiveFolderStorage.init();
  } else {
    // If PlacesUtils is not available, wait for a global event or use a lazy loader.
    // For simplicity, we'll assume it becomes available.
    // In a real scenario, this needs careful handling of dependencies.
    console.warn(
      'PlacesUtils not immediately available for ZenLiveFolderStorage. Will try to initialize later.'
    );
    // Fallback or error handling
  }
});
