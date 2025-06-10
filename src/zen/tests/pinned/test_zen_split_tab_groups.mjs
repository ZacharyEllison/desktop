// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/* import-globals-from head.js */

const { ZenPinnedTabsStorage } = ChromeUtils.importESModule(
  'resource:///modules/zen/tabs/ZenPinnedTabsStorage.mjs'
);
const { ZenPinnedTabManager } = ChromeUtils.importESModule(
  'resource:///modules/zen/tabs/ZenPinnedTabManager.mjs'
);

// Minimal Mocks
const MockZenPinnedTabsStorage = {
  _pins: [],
  async init() { this._pins = []; },
  async savePin(pin) {
    const existingIndex = this._pins.findIndex(p => p.uuid === pin.uuid);
    if (existingIndex > -1) {
      this._pins[existingIndex] = { ...this._pins[existingIndex], ...pin };
    } else {
      this._pins.push({ ...pin });
    }
    return Promise.resolve();
  },
  async getPins() {
    return Promise.resolve(JSON.parse(JSON.stringify(this._pins)));
  },
  async getGroupChildren(groupUuid) {
    return Promise.resolve(this._pins.filter(p => p.parentUuid === groupUuid));
  },
  async removePin(uuid) {
    this._pins = this._pins.filter(p => p.uuid !== uuid && p.parentUuid !== uuid);
    return Promise.resolve();
  },
  async updatePinTitle() { return Promise.resolve(); },
  _ensureTable: () => Promise.resolve(), // No-op for tests
  promiseInitialized: Promise.resolve(),
};

let gOriginalZenPinnedTabsStorage;

add_setup(async function() {
  // Replace actual storage with mock for tests
  gOriginalZenPinnedTabsStorage = ZenPinnedTabsStorage;
  Object.setPrototypeOf(ZenPinnedTabsStorage, MockZenPinnedTabsStorage); // Replace the prototype chain
  await ZenPinnedTabsStorage.init();

  // Mock global objects (add more properties as needed by tests)
  globalThis.gZenUIManager = {
    generateUuidv4: () => `mock-uuid-${Math.random().toString(36).substr(2, 9)}`,
    showToast: sinon.spy(),
  };

  globalThis.gZenWorkspaces = {
    getActiveWorkspaceFromCache: () => ({ uuid: 'active-ws-uuid', containerTabId: 0 }),
    promiseSectionsInitialized: Promise.resolve(),
    promiseInitialized: Promise.resolve(),
    allStoredTabs: [], // Mock as needed
    getEssentialsSection: () => ({ appendChild: sinon.spy() }),
    workspaceElement: () => ({ pinnedTabsContainer: { insertBefore: sinon.spy(), lastChild: null } }),
  };

  globalThis.gBrowser = {
    tabs: [], // Mock as needed for _initializePinnedTabs
    selectedTab: null, // Mock as needed
    pinTab: sinon.spy(),
    setIcon: sinon.spy(),
    setInitialTabTitle: sinon.spy(),
    _setTabLabel: sinon.spy(),
    getTabForBrowser: (browser) => globalThis.gBrowser.tabs.find(t => t.linkedBrowser === browser),
    tabContainer: {
        _invalidateCachedTabs: sinon.spy(),
    },
    _updateTabBarForPinnedTabs: sinon.spy(),
    addTrustedTab: sinon.spy((url, params) => {
        const newTab = {
            getAttribute: sinon.stub(),
            setAttribute: sinon.spy(),
            removeAttribute: sinon.spy(),
            hasAttribute: sinon.stub(),
            linkedBrowser: { currentURI: { spec: url }, _remoteAutoRemoved: false },
            ownerGlobal: window,
            initialize: sinon.spy(),
            style: { setProperty: sinon.spy(), removeProperty: sinon.spy() },
        };
        newTab.getAttribute.withArgs('usercontextid').returns(params.userContextId);
        globalThis.gBrowser.tabs.push(newTab);
        return newTab;
    }),
  };

  globalThis.SessionStore = {
    promiseAllWindowsRestored: Promise.resolve(),
    setTabState: sinon.spy(),
    getTabState: sinon.stub().returns(JSON.stringify({ entries: [] })),
  };

  globalThis.gZenViewSplitter = {
    restoreSplitViewFromPins: sinon.spy(),
    initiateSplitFromContextMenu: sinon.spy(),
    unsplitCurrentView: sinon.spy(),
    canSplitTabs: sinon.stub().returns(true), // Default to true for manager tests
  };

  globalThis.TabContextMenu = {
    contextTab: null, // Set this in individual tests if needed
  };

  // Ensure ZenPinnedTabManager uses the mocked storage if it's reinstantiated or its init is called
  // This might involve more complex mocking if ZenPinnedTabManager is a singleton that has already initialized.
  // For simplicity, we assume gZenPinnedTabManager will pick up the mocked ZenPinnedTabsStorage.
  // If gZenPinnedTabManager is already initialized, we might need to re-initialize it or directly mock its _pinsCache.
  if (globalThis.gZenPinnedTabManager) {
    globalThis.gZenPinnedTabManager._pinsCache = []; // Reset cache
    globalThis.gZenPinnedTabManager.refreshPinnedTabs = sinon.stub().callsFake(async function({init=false}={}) {
        await this._initializePinsCache(); // Uses mocked ZenPinnedTabsStorage.getPins
        await this._initializePinnedTabs(init);
    });
    globalThis.gZenPinnedTabManager._initializePinsCache = sinon.stub(globalThis.gZenPinnedTabManager, '_initializePinsCache').callThrough();
    globalThis.gZenPinnedTabManager._initializePinnedTabs = sinon.stub(globalThis.gZenPinnedTabManager, '_initializePinnedTabs').callThrough();
    globalThis.gZenPinnedTabManager._setPinnedAttributes = sinon.stub(globalThis.gZenPinnedTabManager, '_setPinnedAttributes').callThrough();
    globalThis.gZenPinnedTabManager.savePin = sinon.stub(globalThis.gZenPinnedTabManager, 'savePin').callThrough();
  }

});

add_teardown(async function() {
  // Restore original objects
  Object.setPrototypeOf(ZenPinnedTabsStorage, gOriginalZenPinnedTabsStorage);
  delete globalThis.gZenUIManager;
  delete globalThis.gZenWorkspaces;
  delete globalThis.gBrowser;
  delete globalThis.SessionStore;
  delete globalThis.gZenViewSplitter;
  delete globalThis.TabContextMenu;
  sinon.restore(); // Restores all sinon spies and stubs
  MockZenPinnedTabsStorage._pins = []; // Reset mock storage state
  if (globalThis.gZenPinnedTabManager) {
    globalThis.gZenPinnedTabManager._pinsCache = [];
    if (globalThis.gZenPinnedTabManager.refreshPinnedTabs.restore) globalThis.gZenPinnedTabManager.refreshPinnedTabs.restore();
    if (globalThis.gZenPinnedTabManager._initializePinsCache.restore) globalThis.gZenPinnedTabManager._initializePinsCache.restore();
    if (globalThis.gZenPinnedTabManager._initializePinnedTabs.restore) globalThis.gZenPinnedTabManager._initializePinnedTabs.restore();
    if (globalThis.gZenPinnedTabManager._setPinnedAttributes.restore) globalThis.gZenPinnedTabManager._setPinnedAttributes.restore();
    if (globalThis.gZenPinnedTabManager.savePin.restore) globalThis.gZenPinnedTabManager.savePin.restore();
  }
});

add_task(async function test_create_split_group_pin() {
  await ZenPinnedTabsStorage.init(); // Clear storage
  if (globalThis.gZenPinnedTabManager) globalThis.gZenPinnedTabManager._pinsCache = [];


  const manager = globalThis.gZenPinnedTabManager; // Use the global instance
  const originalSetPinnedAttributes = manager._setPinnedAttributes.wrappedMethod || manager._setPinnedAttributes; // Access original if sinon wrapped

  // Temporarily replace _setPinnedAttributes with a test-specific stub for this task
  manager._setPinnedAttributes = sinon.stub().callsFake(async (tab) => {
    const newPinId = gZenUIManager.generateUuidv4();
    tab.setAttribute('zen-pin-id', newPinId);
    const pinData = { uuid: newPinId, title: tab.label || 'Mock Tab', url: 'http://example.com/mock', parentUuid: null, workspaceUuid: 'active-ws-uuid', isEssential: false, isGroup: false, splitGroup: false, editedTitle: false };
    await ZenPinnedTabsStorage.savePin(pinData); // Simulate saving the new pin
    manager._pinsCache.push(pinData); // Add to manager's cache
    return pinData;
  });


  const mockTabs = [
    { getAttribute: sinon.stub(), setAttribute: sinon.spy(), label: "Tab 1" },
    { getAttribute: sinon.stub(), setAttribute: sinon.spy(), label: "Tab 2" }
  ];
  mockTabs[0].getAttribute.withArgs('zen-pin-id').returns('tab-uuid-1');
  mockTabs[0].getAttribute.withArgs('zen-workspace-id').returns('ws-1');
  mockTabs[1].getAttribute.withArgs('zen-pin-id').returns(null); // This tab will have attributes set

  // Pre-populate cache and storage for the first tab
  const firstTabPin = { uuid: 'tab-uuid-1', title: 'Tab 1', url: 'http://example.com/1', parentUuid: null, workspaceUuid: 'ws-1', isEssential: false, isGroup: false, splitGroup: false, editedTitle: false };
  await ZenPinnedTabsStorage.savePin(firstTabPin);
  manager._pinsCache = [JSON.parse(JSON.stringify(firstTabPin))];


  const groupUuid = await manager.createSplitGroupPin(mockTabs, 'My Split Group');

  Assert.ok(groupUuid.startsWith('mock-uuid-'), 'Should return a mock group UUID');

  const groupPin = MockZenPinnedTabsStorage._pins.find(p => p.uuid === groupUuid);
  Assert.ok(groupPin, 'Group pin should be saved');
  Assert.equal(groupPin.title, 'My Split Group', 'Group pin title should match');
  Assert.ok(groupPin.is_group, 'Group pin should be a group');
  Assert.ok(groupPin.split_group, 'Group pin should be a split_group');
  Assert.equal(groupPin.workspaceUuid, 'ws-1', 'Group pin workspace should match first tab or active');

  // Check first tab
  const firstTabUpdatedPin = MockZenPinnedTabsStorage._pins.find(p => p.uuid === 'tab-uuid-1');
  Assert.equal(firstTabUpdatedPin.parentUuid, groupUuid, 'First tab pin should be updated with parentUuid');
  Assert.equal(firstTabUpdatedPin.workspaceUuid, null, 'First tab pin workspaceUuid should be null');

  // Check second tab (which had _setPinnedAttributes called)
  Assert.ok(manager._setPinnedAttributes.calledOnceWithExactly(mockTabs[1]), '_setPinnedAttributes should be called for the second tab');
  const secondTabGeneratedPinId = mockTabs[1].getAttribute('zen-pin-id'); // Get the ID set by the stub
  Assert.ok(secondTabGeneratedPinId, 'Second tab should now have a pin ID');
  const secondTabUpdatedPin = MockZenPinnedTabsStorage._pins.find(p => p.uuid === secondTabGeneratedPinId);
  Assert.ok(secondTabUpdatedPin, 'Second tab pin should exist in storage');
  Assert.equal(secondTabUpdatedPin.parentUuid, groupUuid, 'Second tab pin should be updated with parentUuid');
  Assert.equal(secondTabUpdatedPin.workspaceUuid, null, 'Second tab pin workspaceUuid should be null');

  Assert.ok(manager.refreshPinnedTabs.called, "refreshPinnedTabs should have been called");

  // Restore original _setPinnedAttributes if it was a method on the prototype, or remove the stub
   if (manager._setPinnedAttributes.isSinonProxy) {
    manager._setPinnedAttributes.restore(); // For stubs on instance methods
  } else {
    manager._setPinnedAttributes = originalSetPinnedAttributes; // Fallback for direct replacement
  }
   // It's safer to restore specific stubs if they might interfere with other tests or teardown
  if (manager._setPinnedAttributes.restore) manager._setPinnedAttributes.restore();
});


add_task(async function test_remove_split_group_pin() {
  await ZenPinnedTabsStorage.init(); // Clear storage
  if (globalThis.gZenPinnedTabManager) globalThis.gZenPinnedTabManager._pinsCache = [];
  const manager = globalThis.gZenPinnedTabManager;

  const groupUuid = 'group-to-remove-uuid';
  await ZenPinnedTabsStorage.savePin({ uuid: groupUuid, is_group: true, split_group: true, title: 'Test Group' });
  await ZenPinnedTabsStorage.savePin({ uuid: 'child-pin-1', parentUuid: groupUuid, title: 'Child 1' });

  await manager.removeSplitGroupPin(groupUuid);

  const groupPin = MockZenPinnedTabsStorage._pins.find(p => p.uuid === groupUuid);
  Assert.ok(!groupPin, 'Group pin should be removed from storage');
  const childPin = MockZenPinnedTabsStorage._pins.find(p => p.uuid === 'child-pin-1');
  Assert.ok(!childPin, 'Child pin should also be removed (simulating cascade or explicit removal)');
  Assert.ok(manager.refreshPinnedTabs.called, "refreshPinnedTabs should have been called");
});

add_task(async function test_update_pin_parent() {
  await ZenPinnedTabsStorage.init(); // Clear storage
  const manager = globalThis.gZenPinnedTabManager;

  const tabPinId = 'tab-to-update-parent-uuid';
  const parentGroupPinUuid = 'new-parent-group-uuid';
  const initialPinData = { uuid: tabPinId, title: 'Test Pin', workspaceUuid: 'ws-initial', parentUuid: null, is_group: false, split_group: false };

  await ZenPinnedTabsStorage.savePin(initialPinData);
  manager._pinsCache = [JSON.parse(JSON.stringify(initialPinData))]; // Set cache

  await manager.updatePinParent(tabPinId, parentGroupPinUuid);

  const updatedPinInStorage = MockZenPinnedTabsStorage._pins.find(p => p.uuid === tabPinId);
  Assert.ok(updatedPinInStorage, 'Pin should exist in storage');
  Assert.equal(updatedPinInStorage.parentUuid, parentGroupPinUuid, 'Pin parentUuid should be updated in storage');
  Assert.equal(updatedPinInStorage.workspaceUuid, null, 'Pin workspaceUuid should be null when parent is set (in storage)');

  const updatedPinInCache = manager._pinsCache.find(p => p.uuid === tabPinId);
  Assert.ok(updatedPinInCache, 'Pin should exist in cache');
  Assert.equal(updatedPinInCache.parentUuid, parentGroupPinUuid, 'Pin parentUuid should be updated in cache');
  Assert.equal(updatedPinInCache.workspaceUuid, null, 'Pin workspaceUuid should be null when parent is set (in cache)');

  Assert.ok(manager.refreshPinnedTabs.called, "refreshPinnedTabs should have been called");

  // Test removing from group
  await manager.updatePinParent(tabPinId, null);
  const removedParentPinInStorage = MockZenPinnedTabsStorage._pins.find(p => p.uuid === tabPinId);
  Assert.equal(removedParentPinInStorage.parentUuid, null, 'Pin parentUuid should be null after removal from group (storage)');
  Assert.equal(removedParentPinInStorage.workspaceUuid, 'active-ws-uuid', 'Pin workspaceUuid should be active workspace (storage)');
});

add_task(async function test_initialize_pinned_tabs_restores_split_groups() {
  await ZenPinnedTabsStorage.init(); // Clear storage
  const manager = globalThis.gZenPinnedTabManager;
  manager._pinsCache = []; // Reset manager's cache

  const groupPin = { uuid: 'split-group-A', title: 'Split A', is_group: true, split_group: true, workspaceUuid: 'ws1', parentUuid: null };
  const childPin1 = { uuid: 'child-A1', title: 'Child A1', parentUuid: 'split-group-A', url: 'http://a1.example.com' };
  const childPin2 = { uuid: 'child-A2', title: 'Child A2', parentUuid: 'split-group-A', url: 'http://a2.example.com' };
  const normalPin = { uuid: 'normal-B', title: 'Normal B', parentUuid: null, url: 'http://b.example.com' };

  await ZenPinnedTabsStorage.savePin(groupPin);
  await ZenPinnedTabsStorage.savePin(childPin1);
  await ZenPinnedTabsStorage.savePin(childPin2);
  await ZenPinnedTabsStorage.savePin(normalPin);

  // Mock gBrowser.tabs for _initializePinnedTabs
  const mockTabA1 = { getAttribute: sinon.stub().withArgs('zen-pin-id').returns('child-A1'), setAttribute: sinon.spy(), querySelector: sinon.stub().returns(null) };
  const mockTabA2 = { getAttribute: sinon.stub().withArgs('zen-pin-id').returns('child-A2'), setAttribute: sinon.spy(), querySelector: sinon.stub().returns(null) };
  const mockTabB = { getAttribute: sinon.stub().withArgs('zen-pin-id').returns('normal-B'), setAttribute: sinon.spy(), querySelector: sinon.stub().returns(null) };
  globalThis.gBrowser.tabs = [mockTabA1, mockTabA2, mockTabB];
  globalThis.gZenWorkspaces.allStoredTabs = globalThis.gBrowser.tabs;


  // Call the actual _initializePinsCache and _initializePinnedTabs
  // Ensure refreshPinnedTabs uses the actual methods for this test, not stubs
  if (manager.refreshPinnedTabs.isSinonProxy) manager.refreshPinnedTabs.restore();
  const originalRefresh = manager.refreshPinnedTabs;
  manager.refreshPinnedTabs = async ({init=false}={}) => { // temp override for this test
    await manager._initializePinsCache.wrappedMethod.call(manager);
    await manager._initializePinnedTabs.wrappedMethod.call(manager,init);
  }


  await manager.refreshPinnedTabs({ init: true });
  manager.refreshPinnedTabs = originalRefresh; // restore


  Assert.ok(gZenViewSplitter.restoreSplitViewFromPins.calledOnce, 'restoreSplitViewFromPins should be called once');
  const callArgs = gZenViewSplitter.restoreSplitViewFromPins.firstCall.args;
  Assert.deepEqual(callArgs[0], groupPin, 'restoreSplitViewFromPins called with correct groupPin');
  Assert.equal(callArgs[1].length, 2, 'restoreSplitViewFromPins called with correct number of childTabObjects');
  Assert.ok(callArgs[1].includes(mockTabA1), 'Child A1 tab object should be passed');
  Assert.ok(callArgs[1].includes(mockTabA2), 'Child A2 tab object should be passed');

  // Cleanup gBrowser.tabs
  globalThis.gBrowser.tabs = [];
  globalThis.gZenWorkspaces.allStoredTabs = [];
});
