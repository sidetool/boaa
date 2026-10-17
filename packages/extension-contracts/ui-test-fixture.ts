/** Synthetic test fixture; not an installed plugin or a runtime capability declaration. */
export function uiManifestFixture() {
  return {
    packageFormat: 'boaa.extension.package',
    packageVersion: 2,
    extension: {
      id: 'org.example.wordbook',
      name: '선택 단어장',
      version: '0.1.0',
      permissions: ['ui.panel.render', 'commands.register', 'reader.selection.consume', 'storage.own'],
      contributes: {
        readerAddonTabs: [{ id: 'org.example.wordbook.panel', title: '단어장', order: 600 }],
        commands: [
          {
            id: 'org.example.wordbook.capture',
            title: '단어 저장',
            locations: ['reader.selection'],
            opensPanel: 'org.example.wordbook.panel',
          },
        ],
      },
    },
    execution: { kind: 'browser-ui', apiVersion: 1, entry: 'dist/ui.js' },
    requires: { hostApi: { major: 1, minMinor: 0 }, features: ['ui.readerAddonTabs', 'reader.selection.consume'] },
    requestedAccess: { networkOrigins: [], storageKiB: 1024, contentScopes: ['selection:explicit'] },
    license: 'MIT',
  };
}
