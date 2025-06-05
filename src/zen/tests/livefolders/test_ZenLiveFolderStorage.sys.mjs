// src/zen/tests/livefolders/test_ZenLiveFolderStorage.sys.mjs
/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { ZenLiveFolderStorage } = ChromeUtils.importESModule(
  "resource:///chrome/zen/livefolders/ZenLiveFolderStorage.mjs"
);

add_task(async function setup() {
  // Ensure the tables are created by initializing storage
  await ZenLiveFolderStorage.promiseInitialized;
  // Clean up before running tests
  await PlacesUtils.withConnectionWrapper("test_setup_cleanup", async (db) => {
    await db.execute("DELETE FROM zen_live_folder_items");
    await db.execute("DELETE FROM zen_live_folders");
    await db.execute("DELETE FROM zen_live_folders_changes"); // Also clear this table
  });
});

add_task(async function test_save_get_remove_live_folder() {
  const folder1 = {
    uuid: "test-uuid-1",
    type: "github_prs",
    title: "Test PRs 1",
    source_username: "testuser1",
    rss_feed_url: "http://example.com/feed1.rss",
  };
  await ZenLiveFolderStorage.saveLiveFolder(folder1);

  let retrievedFolder = await ZenLiveFolderStorage.getLiveFolder(folder1.uuid);
  Assert.notEqual(retrievedFolder, null, "Folder 1 should be retrieved");
  Assert.equal(retrievedFolder.title, folder1.title, "Folder 1 title should match");
  Assert.ok(retrievedFolder.created_at, "Folder 1 should have created_at timestamp");
  Assert.ok(retrievedFolder.updated_at, "Folder 1 should have updated_at timestamp");
  const initialUpdatedAt = retrievedFolder.updated_at;

  const folder2 = {
    uuid: "test-uuid-2",
    type: "gitlab_mrs",
    title: "Test MRs 2",
    source_username: "testuser2",
    rss_feed_url: "http://example.com/feed2.rss",
  };
  await ZenLiveFolderStorage.saveLiveFolder(folder2);

  let allFolders = await ZenLiveFolderStorage.getAllLiveFolders();
  Assert.equal(allFolders.length, 2, "Should retrieve two folders");

  // Test saving again (update)
  folder1.title = "Test PRs 1 Updated";
  // Ensure a delay to check if updated_at changes
  await new Promise(resolve => setTimeout(resolve, 10));
  await ZenLiveFolderStorage.saveLiveFolder(folder1);
  retrievedFolder = await ZenLiveFolderStorage.getLiveFolder(folder1.uuid);
  Assert.equal(retrievedFolder.title, folder1.title, "Folder 1 updated title should match");
  Assert.ok(retrievedFolder.updated_at > initialUpdatedAt, "Folder 1 updated_at should be greater after update");


  await ZenLiveFolderStorage.removeLiveFolder(folder1.uuid);
  retrievedFolder = await ZenLiveFolderStorage.getLiveFolder(folder1.uuid);
  Assert.equal(retrievedFolder, null, "Folder 1 should be null after removal");

  // Check changes table
  const db = await PlacesUtils.promiseDBConnection();
  let rows = await db.execute("SELECT * FROM zen_live_folders_changes WHERE uuid = ?", [folder1.uuid]);
  Assert.equal(rows.length, 0, "Folder 1 should be removed from changes table");


  allFolders = await ZenLiveFolderStorage.getAllLiveFolders();
  Assert.equal(allFolders.length, 1, "Should have one folder left");
  Assert.equal(allFolders[0].uuid, folder2.uuid, "Remaining folder should be folder 2");

  await ZenLiveFolderStorage.removeLiveFolder(folder2.uuid);
  allFolders = await ZenLiveFolderStorage.getAllLiveFolders();
  Assert.equal(allFolders.length, 0, "Should have no folders left");
});

add_task(async function test_save_get_remove_live_folder_items() {
  const folder = {
    uuid: "item-test-folder-uuid",
    type: "github_prs",
    title: "Item Test Folder",
    source_username: "itemuser",
    rss_feed_url: "http://example.com/itemfeed.rss",
  };
  await ZenLiveFolderStorage.saveLiveFolder(folder);

  const item1 = {
    folder_uuid: folder.uuid,
    item_id: "pr-1",
    title: "Pull Request 1",
    link: "http://example.com/pr/1",
    status: "open",
    last_updated: Date.now(),
  };
  await ZenLiveFolderStorage.saveLiveFolderItem(item1);
  const item1CreatedAt = (await ZenLiveFolderStorage.getLiveFolderItems(folder.uuid)).find(i=>i.item_id === "pr-1").created_at;


  const item2 = {
    folder_uuid: folder.uuid,
    item_id: "pr-2",
    title: "Pull Request 2",
    link: "http://example.com/pr/2",
    status: "merged",
    last_updated: Date.now() - 1000, // Older
  };
  await ZenLiveFolderStorage.saveLiveFolderItem(item2);

  let items = await ZenLiveFolderStorage.getLiveFolderItems(folder.uuid);
  Assert.equal(items.length, 2, "Should retrieve two items for the folder");
  // Items are ordered by last_updated DESC
  Assert.equal(items[0].item_id, "pr-1", "First item should be pr-1 due to newer timestamp");

  // Test update
  item1.status = "closed";
  const item1OriginalLastUpdated = item1.last_updated;
  item1.last_updated = Date.now(); // Ensure updated_at for item changes
  await new Promise(resolve => setTimeout(resolve, 10)); // ensure time passes
  await ZenLiveFolderStorage.saveLiveFolderItem(item1);

  items = await ZenLiveFolderStorage.getLiveFolderItems(folder.uuid);
  const updatedItem1 = items.find(i => i.item_id === "pr-1");
  Assert.equal(updatedItem1.status, "closed", "Item 1 status should be updated to closed");
  Assert.ok(updatedItem1.updated_at > item1CreatedAt, "Item 1 updated_at should be greater after update");
  Assert.equal(updatedItem1.created_at, item1CreatedAt, "Item 1 created_at should not change on update");
  Assert.ok(updatedItem1.last_updated > item1OriginalLastUpdated, "Item 1 last_updated from feed should be updated");

  // Test removing all items for a folder
  await ZenLiveFolderStorage.removeLiveFolderItems(folder.uuid);
  items = await ZenLiveFolderStorage.getLiveFolderItems(folder.uuid);
  Assert.equal(items.length, 0, "Items should be empty after removeLiveFolderItems");

  // Test that removing folder also removes items (CASCADE)
  await ZenLiveFolderStorage.saveLiveFolderItem(item1); // Add an item back
  items = await ZenLiveFolderStorage.getLiveFolderItems(folder.uuid);
  Assert.equal(items.length, 1, "Should have one item before folder removal");

  await ZenLiveFolderStorage.removeLiveFolder(folder.uuid);
  items = await ZenLiveFolderStorage.getLiveFolderItems(folder.uuid);
  Assert.equal(items.length, 0, "Items should be empty after folder removal due to CASCADE");
});
