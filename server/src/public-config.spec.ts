import { demoLoginEnabled, publicPageViewConfig } from './public-config.js';

describe('publicPageViewConfig', () => {
  it('returns trimmed public view tokens when configured', () => {
    expect(
      publicPageViewConfig({
        PUBLIC_ROADMAP_VIEW_TOKEN: ' roadmap-token ',
        PUBLIC_CHANGELOG_VIEW_TOKEN: 'changelog-token',
      }),
    ).toEqual({
      roadmapViewToken: 'roadmap-token',
      changelogViewToken: 'changelog-token',
    });
  });

  it('omits unset or blank view tokens as null', () => {
    expect(
      publicPageViewConfig({
        PUBLIC_ROADMAP_VIEW_TOKEN: ' ',
      }),
    ).toEqual({
      roadmapViewToken: null,
      changelogViewToken: null,
    });
  });
});

describe('demoLoginEnabled', () => {
  it('follows DEMO_LOGIN in production and development', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(
        demoLoginEnabled({ NODE_ENV: 'production', DEMO_LOGIN: value }),
      ).toBe(true);
    }
    for (const value of ['0', 'false', 'FALSE', 'no', 'off']) {
      expect(
        demoLoginEnabled({ NODE_ENV: 'development', DEMO_LOGIN: value }),
      ).toBe(false);
    }
  });

  it('hides the panel in production and shows it elsewhere when unset', () => {
    expect(demoLoginEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(demoLoginEnabled({ NODE_ENV: 'production', DEMO_LOGIN: '  ' })).toBe(
      false,
    );
    expect(demoLoginEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(demoLoginEnabled({})).toBe(true);
  });
});
