import { expect, it } from 'vitest';
import { validateHomeFeed } from './home-feed';
import { inspectSingleJs } from '../../src/extensions/packages/platform-single-js';

it('accepts a bounded ranked search feed and rejects active URLs, duplicate IDs and oversized data', () => {
  expect(
    validateHomeFeed({
      items: [{ id: 'a', title: 'Title', rank: 2, searchQuery: 'Original', coverUrl: 'https://example.test/a.png' }],
      ttlSeconds: 300,
    }),
  ).toHaveProperty('items.0.rank', 2);
  for (const value of [
    {
      items: [
        { id: 'a', title: 'T' },
        { id: 'a', title: 'T' },
      ],
    },
    { items: [{ id: 'a', title: 'T', rank: 0 }] },
    { items: [{ id: 'a', title: 'T', coverUrl: 'data:image/png;base64,a' }] },
    { items: Array.from({ length: 51 }, (_, i) => ({ id: String(i), title: 'T' })) },
    { items: [], ttlSeconds: 0 },
    { items: [], asOf: 'not-a-date' },
  ])
    expect(() => validateHomeFeed(value)).toThrow('INVALID_HOME_FEED');
});
it('requires the home permission and accepts an on-demand single-file plugin with approved connection defaults', () => {
  const header = {
    id: 'org.example.ranks',
    version: '1.0.0',
    apiVersion: 2,
    license: 'MIT',
    activation: ['onHome'],
    permissions: ['home.feed', 'http.request'],
    features: ['home.feed', 'http.request'],
    contributes: { homeSections: [{ id: 'popular', title: 'Popular' }], connections: ['catalog'] },
    connections: [{ id: 'catalog', title: 'Catalog', endpoint: 'https://example.test/api/', methods: ['GET'] }],
  };
  const parse = (value: unknown) =>
    inspectSingleJs(
      new TextEncoder().encode(
        `/* @boaa-plugin ${JSON.stringify(value)} */\nBoaaPlugin.register({apiVersion:2,activate(){}});`,
      ),
    );
  expect(parse(header).manifest.contributes.homeSections?.[0].title).toBe('Popular');
  expect(() => parse({ ...header, permissions: ['http.request'], features: ['http.request'] })).toThrow();
  expect(() =>
    parse({ ...header, connections: [{ ...header.connections[0], endpoint: 'http://private.test/' }] }),
  ).toThrow();
  expect(() =>
    parse({
      ...header,
      permissions: [...header.permissions, 'commands.register'],
      features: [...header.features, 'commands.register'],
      contributes: { ...header.contributes, commands: ['popular'] },
    }),
  ).toThrow('contributes.roles');
});
