// src/zen/tests/livefolders/head.js
/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

// Import common services
var { Services } = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs");
var { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
var { XPCOMUtils } = ChromeUtils.importESModule("resource://gre/modules/XPCOMUtils.sys.mjs");
var { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");

// Ensure profile directory is set up for PlacesUtils
do_get_profile();

// Globally available mocks or stubs if needed across tests
globalThis.mockGZenUIManager = {
  showToast: (messageId, options) => {
    console.log(\`Mock Toast: \${messageId}, Options: \${JSON.stringify(options)}\`);
  }
};
