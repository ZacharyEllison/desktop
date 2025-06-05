// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Assuming ZenLiveFolderStorage is imported or made available globally/lazily
// For example: const { ZenLiveFolderStorage } = ChromeUtils.importESModule('resource:///modules/ZenLiveFolderStorage.sys.mjs');
// Or if it's on \`globalThis\` like other Zen managers.

var ZenLiveFolderManager = {
  // POLLING_INTERVAL_MS is now a getter
  _pollingTimers: new Map(), // Store timers by folder UUID
  _prefs: null, // For preference observer

  get POLLING_INTERVAL_MS() {
    // Lazily get the preference or use a default
    if (!this._pollingIntervalMs) {
        try {
            // Default to 15 minutes (15 * 60 * 1000 ms)
            this._pollingIntervalMs = Services.prefs.getIntPref("zen.livefolders.polling_interval_ms", 15 * 60 * 1000);
        } catch (e) {
            // Pref might not exist or be of wrong type, use default
            this._pollingIntervalMs = 15 * 60 * 1000;
        }
    }
    // Ensure a minimum interval to prevent abuse (e.g., 1 minute)
    return Math.max(60 * 1000, this._pollingIntervalMs);
  },

  async init() {
    // Ensure ZenLiveFolderStorage is initialized
    await ZenLiveFolderStorage.promiseInitialized;
    console.log("ZenLiveFolderManager initialized");
    // Potentially load existing live folders and start polling
    this.loadAndPollExistingFolders();
    this._setupLoginListener();

    // Setup preference observer for polling interval
    if (globalThis.Services && Services.prefs) {
        this._prefs = Services.prefs.getBranch("zen.livefolders.");
        this._prefs.addObserver("", this); // "this" must implement observe()
    }
  },

  _setupLoginListener() {
    // Events from content pages might bubble up to the top-level browser window
    // or specific elements like the tab browser.
    // Using AppConstants.MOZ_APP_NAME to ensure this listener is only for the main app window.
    // if (typeof window !== 'undefined' && typeof AppConstants !== 'undefined' && AppConstants.MOZ_APP_NAME === 'firefox') { // AppConstants might not be available here directly
    if (typeof window !== 'undefined') { // Simplified check
        // Listen on gBrowser.tabContainer for events that might bubble from tabs
        if (globalThis.gBrowser && globalThis.gBrowser.tabContainer) {
            globalThis.gBrowser.tabContainer.addEventListener('zen-github-username-obtained', this.handleGitHubLoginEvent.bind(this), false);
            console.log("ZenLiveFolderManager: Added listener for zen-github-username-obtained on gBrowser.tabContainer");
        } else {
            console.warn("ZenLiveFolderManager: gBrowser.tabContainer not available to set up login listener. Falling back to window.");
            // Fallback: listen on the main window.
            window.addEventListener('zen-github-username-obtained', this.handleGitHubLoginEvent.bind(this), false);
            console.log("ZenLiveFolderManager: Added listener for zen-github-username-obtained on window (fallback).");
        }
    }
  },

  async handleGitHubLoginEvent(event) {
    if (event.detail && event.detail.username) {
      const username = event.detail.username;
      console.log(\`ZenLiveFolderManager: Received GitHub username: \${username}\`);
      try {
        const folderUuid = await this.enableGitHubPullRequestsLiveFolder(username);
        if (folderUuid && globalThis.gZenUIManager && globalThis.gZenUIManager.showToast) {
          globalThis.gZenUIManager.showToast('zen-livefolder-github-enabled-toast', {
            // descriptionId: 'zen-livefolder-github-enabled-toast-description', // Example for a more specific message
            // For now, using the main messageId as the primary display string.
            // In a real scenario, 'zen-livefolder-github-enabled-toast' would be a generic title
            // and descriptionId would point to "GitHub PR Live Folder for '{username}' enabled!"
            // For simplicity here, we'll assume the main ID can convey enough.
          });
           // Attempt to close the login tab
           if (event.originalTarget && event.originalTarget.ownerGlobal) {
             const eventWindow = event.originalTarget.ownerGlobal;
             for (const tab of globalThis.gBrowser.tabs) {
                if (tab.linkedBrowser && tab.linkedBrowser.contentWindow === eventWindow) {
                    if (!tab.closing) {
                        globalThis.gBrowser.removeTab(tab);
                    }
                    break;
                }
             }
           }
        } else if (!folderUuid) {
            if (globalThis.gZenUIManager && globalThis.gZenUIManager.showToast) {
                globalThis.gZenUIManager.showToast('zen-livefolder-github-error-toast');
            }
        }
      } catch (error) {
        console.error("ZenLiveFolderManager: Error enabling GitHub Live Folder from event:", error);
        if (globalThis.gZenUIManager && globalThis.gZenUIManager.showToast) {
           globalThis.gZenUIManager.showToast('zen-livefolder-github-error-toast');
        }
      }
    } else {
        console.warn("ZenLiveFolderManager: Received zen-github-username-obtained event without username in detail.");
    }
  },

  async loadAndPollExistingFolders() {
    const folders = await ZenLiveFolderStorage.getAllLiveFolders();
    for (const folder of folders) {
      this.startPolling(folder.uuid);
      // Initial fetch for each folder on startup
      this.fetchAndStoreItems(folder.uuid);
    }
  },

  generateUuidv4() {
    // Assumes Services.uuid is available, similar to ZenUIManager
    if (globalThis.Services && Services.uuid) {
      return Services.uuid.generateUUID().toString();
    }
    // Fallback for environments where Services.uuid might not be available directly
    // This is a simplified UUID v4 generator, consider a more robust one if needed.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },

  _getGitHubRssUrl(username) {
    // Updated URL format for more specific PR search and public PRs
    return \`https://github.com/search?q=is:pr+author:\${username}+is:public&type=pulls&format=atom\`;
  },

  async enableGitHubPullRequestsLiveFolder(username) { // Ensure it's async
    if (!username) {
      console.error("ZenLiveFolderManager: Username is required to enable GitHub PR Live Folder.");
      return null;
    }
    const folderUuid = this.generateUuidv4();
    const rssFeedUrl = this._getGitHubRssUrl(username); // Uses the updated method

    const newFolder = {
      uuid: folderUuid,
      type: 'github_prs',
      title: \`Pull Requests (\${username})\`, // Dynamic title with username
      source_username: username,
      rss_feed_url: rssFeedUrl,
    };

    await ZenLiveFolderStorage.saveLiveFolder(newFolder);
    console.log(\`ZenLiveFolderManager: Enabled GitHub PR Live Folder for \${username} with UUID \${folderUuid}\`);

    // Initial fetch and start polling
    await this.fetchAndStoreItems(folderUuid);
    this.startPolling(folderUuid);

    // Notify UI or other components that a new live folder has been created
    if (globalThis.Services && globalThis.Services.obs) {
        Services.obs.notifyObservers(null, 'zen-live-folder-created', folderUuid);
    }

    // Create a visual representation (e.g., a special pinned tab)
    if (globalThis.gBrowser && globalThis.gBrowser.addTrustedTab && globalThis.gBrowser.pinTab) {
        const liveFolderURL = \`chrome://browser/content/zen/livefolders/about_live_folder.xhtml?uuid=\${folderUuid}&title=\${encodeURIComponent(newFolder.title)}\`;

        let liveFolderTab = globalThis.gBrowser.addTrustedTab(liveFolderURL, {
            relatedToCurrent: false,
            owner: null,
        });
        liveFolderTab.setAttribute('zen-live-folder-uuid', folderUuid);
        liveFolderTab.setAttribute('zen-live-folder-type', newFolder.type);
        // The title of the tab will be set by the about_live_folder.xhtml page itself from the URL query param.

        globalThis.gBrowser.pinTab(liveFolderTab);
        // Select the tab after pinning to make it active
        globalThis.gBrowser.selectedTab = liveFolderTab;

        console.log(\`ZenLiveFolderManager: Created visual tab for Live Folder \${folderUuid} at \${liveFolderURL}\`);
    }

    return folderUuid;
  },

  async fetchAndStoreItems(folderUuid) {
    const folderData = await ZenLiveFolderStorage.getLiveFolder(folderUuid);
    if (!folderData || !folderData.rss_feed_url) {
      console.error(\`ZenLiveFolderManager: No folder data or RSS URL for UUID \${folderUuid}\`);
      return;
    }

    console.log(\`ZenLiveFolderManager: Fetching items for \${folderData.title} from \${folderData.rss_feed_url}\`);
    try {
      const response = await fetch(folderData.rss_feed_url, { cache: "no-store" });
      if (!response.ok) {
        let errorMsg = \`ZenLiveFolderManager: Failed to fetch RSS feed for \${folderData.title}. Status: \${response.status} \${response.statusText}\`;
        if (response.status === 401 || response.status === 403) {
          errorMsg += \`. This could indicate an authentication/authorization issue if the feed were private, or an invalid username/repo for public feeds.\`;
          // Potentially stop polling for this folder if it's a persistent auth error for a specific feed type
          // For now, we'll let it retry as it might be a temporary issue or misconfiguration.
        }
        console.error(errorMsg);
        return;
      }
      const feedText = await response.text();
      const parsedItems = this._parseGitHubAtomFeed(feedText, folderUuid);

      if (parsedItems.length > 0) {
        const existingItems = await ZenLiveFolderStorage.getLiveFolderItems(folderUuid);
        const currentFeedItemIds = new Set();

        for (const item of parsedItems) {
          await ZenLiveFolderStorage.saveLiveFolderItem(item);
          currentFeedItemIds.add(item.item_id);
        }

        for (const existingItem of existingItems) {
          if (!currentFeedItemIds.has(existingItem.item_id)) {
            console.log(\`Item \${existingItem.item_id} is stale and should be removed (implementation pending).\`);
          }
        }
      }
      console.log(\`ZenLiveFolderManager: Fetched and stored \${parsedItems.length} items for \${folderData.title}.\`);
      Services.obs.notifyObservers(null, 'zen-live-folder-updated', folderUuid);
    } catch (error) {
      console.error(\`ZenLiveFolderManager: Error fetching or parsing RSS feed for \${folderData.title}:\`, error);
    }
  },

  _parseGitHubAtomFeed(feedText, folderUuid) {
    const items = [];
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(feedText, "application/xml");
      const entries = xmlDoc.getElementsByTagName("entry");

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const title = entry.getElementsByTagName("title")[0]?.textContent || "No title";
        const link = entry.getElementsByTagName("link")[0]?.getAttribute("href") || "";
        const itemId = entry.getElementsByTagName("id")[0]?.textContent || link;
        const updated = entry.getElementsByTagName("updated")[0]?.textContent || new Date().toISOString();

        let status = 'open';
        if (title.toLowerCase().includes('merged pull request')) {
          status = 'merged';
        } else if (title.toLowerCase().includes('closed pull request')) {
          status = 'closed';
        } else if (title.toLowerCase().includes('opened pull request')) {
          status = 'open';
        }

        if (!title.toLowerCase().includes('pull request')) {
            continue;
        }

        items.push({
          folder_uuid: folderUuid,
          item_id: itemId,
          title: title.replace(/^[a-zA-Z0-9_-]+ (opened|merged|closed) pull request /, ''),
          link: link,
          status: status,
          last_updated: new Date(updated).getTime(),
        });
      }
    } catch (error) {
      console.error("ZenLiveFolderManager: Error parsing Atom feed:", error);
    }
    return items;
  },

  startPolling(folderUuid) {
    if (this._pollingTimers.has(folderUuid)) {
      console.log(\`ZenLiveFolderManager: Polling already active for UUID \${folderUuid}\`);
      return;
    }

    const intervalId = setInterval(async () => {
      await this.fetchAndStoreItems(folderUuid);
    }, this.POLLING_INTERVAL_MS);

    this._pollingTimers.set(folderUuid, intervalId);
    console.log(\`ZenLiveFolderManager: Started polling for UUID \${folderUuid} every \${this.POLLING_INTERVAL_MS / 1000 / 60} minutes.\`);
  },

  stopPolling(folderUuid) {
    if (this._pollingTimers.has(folderUuid)) {
      clearInterval(this._pollingTimers.get(folderUuid));
      this._pollingTimers.delete(folderUuid);
      console.log(\`ZenLiveFolderManager: Stopped polling for UUID \${folderUuid}\`);
    }
  },

  async getLiveFoldersForDisplay() {
    return ZenLiveFolderStorage.getAllLiveFolders();
  },

  async getLiveFolderItemsForDisplay(folderUuid) {
    return ZenLiveFolderStorage.getLiveFolderItems(folderUuid);
  },

  async removeFolder(folderUuid) {
    this.stopPolling(folderUuid);
    await ZenLiveFolderStorage.removeLiveFolder(folderUuid);
    console.log(\`ZenLiveFolderManager: Removed folder \${folderUuid}\`);
    Services.obs.notifyObservers(null, 'zen-live-folder-removed', folderUuid);
  },

  // Preference observer implementation
  observe(aSubject, aTopic, aData) {
    if (aTopic === "nsPref:changed") {
      switch (aData) {
        case "polling_interval_ms":
          // Clear existing interval property so it's refetched by the getter
          delete this._pollingIntervalMs;
          console.log("ZenLiveFolderManager: Polling interval preference changed. Updating all active polls.");
          this.updateAllPollingIntervals();
          break;
      }
    }
  },

  updateAllPollingIntervals() {
    console.log("ZenLiveFolderManager: Updating polling intervals for all active live folders.");
    const currentTimerKeys = Array.from(this._pollingTimers.keys()); // Iterate over a copy of keys
    currentTimerKeys.forEach(folderUuid => {
        this.stopPolling(folderUuid); // Clears the old timer
        this.startPolling(folderUuid); // Starts a new one with the updated interval
    });
  },

  // Call this on shutdown to prevent memory leaks
  unregisterPrefObserver() {
    if (this._prefs) {
        this._prefs.removeObserver("", this);
        this._prefs = null;
    }
  }
};

// Deferring init call to when it's explicitly called by the application startup process.
// ZenLiveFolderManager.init(); // This should be called by the browser's startup sequence.
// Ensure unregisterPrefObserver() is called on shutdown, e.g. via Services.obs 'quit-application' or similar.
