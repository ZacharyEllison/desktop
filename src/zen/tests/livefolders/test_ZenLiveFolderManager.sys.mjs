// src/zen/tests/livefolders/test_ZenLiveFolderManager.sys.mjs
/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { ZenLiveFolderManager } = ChromeUtils.importESModule(
  "resource:///chrome/zen/livefolders/ZenLiveFolderManager.mjs"
);
const { ZenLiveFolderStorage } = ChromeUtils.importESModule(
  "resource:///chrome/zen/livefolders/ZenLiveFolderStorage.mjs"
);

// Mock global gZenUIManager if not already available from head.js
if (typeof globalThis.gZenUIManager === 'undefined' && typeof globalThis.mockGZenUIManager !== 'undefined') {
    globalThis.gZenUIManager = globalThis.mockGZenUIManager;
} else if (typeof globalThis.gZenUIManager === 'undefined') {
    globalThis.gZenUIManager = { // Fallback mock if head.js didn't provide it
      showToast: (messageId, options) => {
        console.log(\`(Fallback Mock) Toast: \${messageId}, Options: \${JSON.stringify(options)}\`);
      }
    };
}

// Mock Services and other globals needed by ZenLiveFolderManager
let observedNotifications = [];
if (!globalThis.Services) globalThis.Services = {};

globalThis.Services.obs = globalThis.Services.obs || {
    notifyObservers: (subject, topic, data) => {
        observedNotifications.push({ subject, topic, data });
    },
    addObserver: () => {},
    removeObserver: () => {},
};

// Minimal prefs mock for polling interval
let mockPollingInterval = 15 * 60 * 1000;
const mockPrefsBranch = {
    _observers: [],
    addObserver: function(domain, obs) { this._observers.push(obs); },
    removeObserver: function(domain, obs) { this._observers = this._observers.filter(o => o !== obs); },
    getIntPref: function(prefName, defaultValue) {
        if (prefName === "polling_interval_ms") return mockPollingInterval;
        return defaultValue;
    },
    // Simulate pref change notification
    _notifyPrefChange(prefName) {
        this._observers.forEach(obs => {
            if (typeof obs.observe === 'function') {
                obs.observe(null, "nsPref:changed", prefName);
            }
        });
    }
};
globalThis.Services.prefs = globalThis.Services.prefs || {
    getIntPref: (prefKey, defaultValue) => {
        if (prefKey === "zen.livefolders.polling_interval_ms") return mockPollingInterval;
        return defaultValue;
    },
    getBranch: (branchName) => {
        if (branchName === "zen.livefolders.") return mockPrefsBranch;
        // Fallback for other branches if necessary
        return { addObserver: () => {}, removeObserver: () => {}, getIntPref: (k,d) => d };
    },
};

globalThis.Services.uuid = globalThis.Services.uuid || {
    generateUUID: () => \`test-uuid-\${Math.random().toString(36).substring(2, 15)}\`
};

// Mock for gBrowser and tab operations (very basic)
globalThis.gBrowser = globalThis.gBrowser || {
    addTrustedTab: (url, options) => {
        console.log(\`Mock gBrowser.addTrustedTab: \${url}\`);
        const mockTab = {
            setAttribute: (attr, val) => { mockTab[attr] = val; },
            linkedBrowser: { contentWindow: {} }, // Mock contentWindow for event dispatch checks
        };
        return mockTab;
    },
    pinTab: (tab) => { console.log('Mock gBrowser.pinTab'); },
    removeTab: (tab) => { console.log('Mock gBrowser.removeTab'); },
    selectedTab: null,
    tabs: [],
    tabContainer: {
        addEventListener: () => {},
        removeEventListener: () => {},
    }
};


add_task(async function setup() {
  await ZenLiveFolderStorage.promiseInitialized; // Manager depends on storage
  // Manually ensure _pollingIntervalMs is reset if tests change mockPollingInterval directly
  delete ZenLiveFolderManager._pollingIntervalMs;
  await ZenLiveFolderManager.init();
  observedNotifications = [];

  await PlacesUtils.withConnectionWrapper("test_manager_setup_cleanup", async (db) => {
    await db.execute("DELETE FROM zen_live_folder_items");
    await db.execute("DELETE FROM zen_live_folders");
    await db.execute("DELETE FROM zen_live_folders_changes");
  });
});

add_task(async function test_enable_github_prs_live_folder() {
  const username = "testghuser";

  let saveFolderCalledWith = null;
  const originalSaveLiveFolder = ZenLiveFolderStorage.saveLiveFolder;
  ZenLiveFolderStorage.saveLiveFolder = async (folder) => {
    saveFolderCalledWith = folder;
    return originalSaveLiveFolder.call(ZenLiveFolderStorage, folder);
  };

  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;
  globalThis.fetch = async (url) => {
    fetchCallCount++;
    Assert.ok(url.includes(username), "Fetch URL should include username");
    Assert.ok(url.includes("is:pr"), "Fetch URL should query for 'is:pr'");
    Assert.ok(url.includes("author:" + username), "Fetch URL should include 'author:username'");
    return {
      ok: true,
      text: async () => \`<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <id>tag:github.com,2008:PullRequestEvent/123</id>
            <title>\${username} opened pull request myrepo#42 Awesome Feature</title>
            <link href="http://example.com/pull/42"/>
            <updated>2023-01-01T10:00:00Z</updated>
          </entry>
        </feed>\`,
    };
  };

  const folderUuid = await ZenLiveFolderManager.enableGitHubPullRequestsLiveFolder(username);
  Assert.ok(folderUuid, "Should return a folder UUID");
  Assert.ok(saveFolderCalledWith, "saveLiveFolder should have been called");
  Assert.equal(saveFolderCalledWith.source_username, username, "Username should match");
  Assert.equal(saveFolderCalledWith.type, "github_prs", "Type should be github_prs");
  Assert.ok(saveFolderCalledWith.title.includes(username), "Folder title should include username");

  const items = await ZenLiveFolderStorage.getLiveFolderItems(folderUuid);
  Assert.equal(items.length, 1, "Should have fetched and stored one item");
  Assert.equal(items[0].title, "myrepo#42 Awesome Feature", "Item title should be parsed correctly");
  Assert.equal(fetchCallCount, 1, "Fetch should be called once during initial enablement.");

  const creationNotification = observedNotifications.find(obs => obs.topic === 'zen-live-folder-created');
  Assert.ok(creationNotification, "zen-live-folder-created should be observed");
  Assert.equal(creationNotification.data, folderUuid, "Notification data should be the folder UUID");

  ZenLiveFolderStorage.saveLiveFolder = originalSaveLiveFolder;
  globalThis.fetch = originalFetch;
});

add_task(async function test_parse_github_atom_feed() {
  const feedText = \`<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>pr1</id><title>user1 opened pull request repo/project#1 Test PR 1</title><link href="http://example.com/pr/1"/><updated>2023-01-01T12:00:00Z</updated></entry>
      <entry><id>pr2</id><title>user1 merged pull request repo/project#2 Test PR 2</title><link href="http://example.com/pr/2"/><updated>2023-01-02T12:00:00Z</updated></entry>
      <entry><id>pr3</id><title>user1 closed pull request repo/project#3 Test PR 3</title><link href="http://example.com/pr/3"/><updated>2023-01-03T12:00:00Z</updated></entry>
      <entry><id>issue1</id><title>user1 opened issue repo/project#4 An Issue</title><link href="http://example.com/issue/4"/><updated>2023-01-04T12:00:00Z</updated></entry>
    </feed>\`;
  const folderUuid = "parse-test-uuid";
  const items = ZenLiveFolderManager._parseGitHubAtomFeed(feedText, folderUuid);

  Assert.equal(items.length, 3, "Should parse 3 PR items, skipping the issue");
  const pr1 = items.find(item => item.link === "http://example.com/pr/1");
  Assert.equal(pr1.status, "open");
  Assert.equal(pr1.title, "repo/project#1 Test PR 1");
});

add_task(async function test_polling_config_and_start_stop() {
  mockPollingInterval = 30 * 60 * 1000; // 30 minutes
  delete ZenLiveFolderManager._pollingIntervalMs; // Clear cached value
  Assert.equal(ZenLiveFolderManager.POLLING_INTERVAL_MS, 30 * 60 * 1000, "Polling interval should be 30 mins from mock pref");

  mockPollingInterval = 30 * 1000; // 30 seconds (below minimum)
  delete ZenLiveFolderManager._pollingIntervalMs;
  Assert.equal(ZenLiveFolderManager.POLLING_INTERVAL_MS, 60 * 1000, "Polling interval should be forced to 1 min if pref is too low");

  const folderUuid = "polling-test-uuid";
  // Need to save a folder for polling to make sense, as fetchAndStoreItems requires folderData
  await ZenLiveFolderStorage.saveLiveFolder({uuid: folderUuid, type: "github_prs", title: "PollTest", rss_feed_url: "http://example.com/polltest"});

  ZenLiveFolderManager.startPolling(folderUuid);
  Assert.ok(ZenLiveFolderManager._pollingTimers.has(folderUuid), "Should have a timer for the folder");

  // Simulate pref change to update interval
  mockPollingInterval = 2 * 60 * 1000; // 2 minutes
  mockPrefsBranch._notifyPrefChange("polling_interval_ms"); // Notify observers
  // Check if timer was restarted (hard to check directly without more spies, but _pollingIntervalMs should be cleared)
  Assert.ok(ZenLiveFolderManager._pollingTimers.has(folderUuid), "Timer should still exist after pref change.");
  // At this point, the old timer is cleared, and a new one started.
  // We can verify the new interval will be used by checking the POLLING_INTERVAL_MS getter again.
  Assert.equal(ZenLiveFolderManager.POLLING_INTERVAL_MS, 2 * 60 * 1000, "Getter should reflect new pref value for next cycle.");


  ZenLiveFolderManager.stopPolling(folderUuid);
  Assert.ok(!ZenLiveFolderManager._pollingTimers.has(folderUuid), "Timer should be cleared after stopping");

  // Cleanup
  await ZenLiveFolderStorage.removeLiveFolder(folderUuid);
  mockPollingInterval = 15 * 60 * 1000; // Reset to default for other tests
  delete ZenLiveFolderManager._pollingIntervalMs;
});

add_task(async function test_fetch_error_handling() {
    const username = "fetcherroruser";
    const originalFetch = globalThis.fetch;
    let errorLogged = false;
    const originalConsoleError = console.error;
    console.error = (msg) => {
        if (msg.includes("Failed to fetch RSS feed")) errorLogged = true;
        originalConsoleError.call(console, msg);
    };

    globalThis.fetch = async (url) => ({ ok: false, status: 500, statusText: "Server Error" });

    const folderUuid = await ZenLiveFolderManager.enableGitHubPullRequestsLiveFolder(username);
    Assert.ok(folderUuid, "Folder should still be created even if initial fetch fails");
    Assert.ok(errorLogged, "Error should have been logged for failed fetch");

    const items = await ZenLiveFolderStorage.getLiveFolderItems(folderUuid);
    Assert.equal(items.length, 0, "No items should be stored after failed fetch");

    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    await ZenLiveFolderStorage.removeLiveFolder(folderUuid);
});

// Teardown method to unregister observers if manager has shutdown logic
add_task(async function teardown() {
    if (typeof ZenLiveFolderManager.unregisterPrefObserver === "function") {
        ZenLiveFolderManager.unregisterPrefObserver();
    }
    // Clear any remaining timers
    ZenLiveFolderManager._pollingTimers.forEach((timerId, uuid) => {
        ZenLiveFolderManager.stopPolling(uuid);
    });
});
