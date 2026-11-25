/**
 * The Trama logo files, built from the geometry in the Brand frame ("Site · 06 Brand", "Brand assets"):
 * two interlocking square frames on a 4-unit module inside a 96-unit square (weft in amber, warp in ink),
 * and the wordmark outlined from Newsreader 400 (optical size 36, tracking -0.01em), so exported SVG and
 * PNG files need no font.
 */

export type LogoKind = 'symbol' | 'horizontal' | 'stacked' | 'wordmark';
export type LogoVariant = 'colour-dark' | 'colour-light' | 'white' | 'black';

export interface LogoAsset {
  kind: LogoKind;
  name: string;
  description: string;
  /** Natural size of the exported SVG, in px. */
  width: number;
  height: number;
}

export interface LogoVariantInfo {
  variant: LogoVariant;
  label: string;
  /** Background the variant is meant for (the tile it is shown on). */
  surface: 'dark' | 'light';
}

export const LOGO_VARIANTS: readonly LogoVariantInfo[] = [
  { variant: 'colour-dark', label: 'COLOUR · DARK', surface: 'dark' },
  { variant: 'colour-light', label: 'COLOUR · LIGHT', surface: 'light' },
  { variant: 'white', label: 'WHITE', surface: 'dark' },
  { variant: 'black', label: 'BLACK', surface: 'light' },
];

export const LOGOS: readonly LogoAsset[] = [
  {
    kind: 'symbol',
    name: 'Logomark',
    description:
      'The two woven frames. Use it for avatars, app icons and anywhere space is tight.',
    width: 96,
    height: 96,
  },
  {
    kind: 'horizontal',
    name: 'Logo',
    description: 'Logomark and wordmark side by side. The default choice for most placements.',
    width: 169,
    height: 44,
  },
  {
    kind: 'stacked',
    name: 'Stacked logo',
    description: 'For square formats such as social cards and event badges.',
    width: 89,
    height: 96,
  },
  {
    kind: 'wordmark',
    name: 'Wordmark',
    description: 'The name on its own, when the logomark already appears nearby.',
    width: 144,
    height: 38,
  },
];

interface Palette {
  weft: string;
  warp: string;
  text: string;
}

const PALETTES: Record<LogoVariant, Palette> = {
  'colour-dark': { weft: '#e2a93b', warp: '#dcdde0', text: '#dcdde0' },
  'colour-light': { weft: '#c98a1e', warp: '#17181c', text: '#17181c' },
  white: { weft: '#ffffff', warp: '#ffffff', text: '#ffffff' },
  black: { weft: '#0f1114', warp: '#0f1114', text: '#0f1114' },
};

/** Weft (the amber frame, behind) and warp (the ink frame, in front) on the 96-unit grid. */
export const WEFT_PATH =
  'M3.84 3.84h57.6v11.52h-57.6zM3.84 3.84h11.52v57.6h-11.52zM49.92 3.84h11.52v57.6h-11.52zM3.84 49.92h26.88v11.52h-26.88z';
export const WARP_PATH =
  'M34.56 34.56h11.52v57.6h-11.52zM34.56 80.64h57.6v11.52h-57.6zM80.64 34.56h11.52v57.6h-11.52zM65.28 34.56h26.88v11.52h-26.88z';

/** "Trama" in Newsreader, 2000 units per em, baseline at y = 0, glyphs growing up (negative y). */
const WORDMARK_PATH =
  'M585 -1319H761V-84L926 -36V0H420V-36L585 -84ZM1206 -1287H140L239 -1306L83 -982L43 -990L90 -1440H108L251 -1354L163 -1370H1183L1095 -1354L1238 -1440H1256L1303 -990L1263 -982L1107 -1306ZM1980 -924Q2029 -924 2053 -900Q2077 -875 2077 -835Q2077 -787 2046 -758Q2016 -729 1966 -729Q1944 -729 1921 -736Q1899 -744 1875 -751Q1850 -758 1820 -758Q1795 -758 1768 -750Q1741 -742 1714 -728Q1688 -714 1666 -695L1651 -733Q1715 -789 1765 -826Q1816 -862 1855 -884Q1894 -906 1924 -915Q1955 -924 1980 -924ZM1682 -746V-76L1840 -34V0H1375V-34L1524 -76V-735Q1511 -747 1491 -758Q1471 -769 1443 -783Q1414 -796 1377 -812V-835L1660 -933H1676ZM2712 -584 2727 -523Q2601 -491 2522 -459Q2443 -427 2399 -395Q2356 -362 2339 -326Q2323 -289 2323 -246Q2323 -172 2366 -133Q2410 -95 2473 -95Q2523 -95 2564 -118Q2604 -142 2628 -182Q2652 -223 2652 -274V-667Q2652 -749 2610 -795Q2569 -842 2478 -842Q2441 -842 2399 -833Q2356 -824 2322 -807L2374 -851Q2371 -820 2365 -788Q2359 -756 2351 -731Q2343 -705 2331 -692Q2316 -675 2291 -667Q2267 -659 2241 -659Q2209 -659 2190 -673Q2170 -688 2170 -713Q2170 -747 2204 -784Q2238 -821 2292 -853Q2347 -884 2413 -904Q2479 -923 2544 -923Q2640 -923 2698 -895Q2757 -866 2784 -812Q2810 -758 2810 -681V-179Q2810 -147 2820 -127Q2829 -106 2847 -96Q2865 -86 2891 -86Q2917 -86 2946 -96Q2975 -106 3004 -124V-84Q2952 -25 2902 -3Q2853 19 2807 19Q2755 19 2721 -4Q2687 -28 2670 -71Q2653 -115 2652 -175L2657 -182Q2643 -123 2606 -77Q2570 -32 2519 -6Q2468 20 2409 20Q2301 20 2230 -39Q2159 -99 2159 -211Q2159 -270 2182 -317Q2204 -365 2263 -407Q2323 -450 2432 -492Q2541 -535 2712 -584ZM3327 -746V-76L3472 -34V0H3020V-34L3169 -76V-735Q3153 -749 3122 -766Q3090 -783 3022 -812V-835L3292 -933H3307ZM3887 -668V-76L4031 -34V0H3584V-34L3729 -76V-620Q3729 -677 3706 -714Q3683 -752 3640 -771Q3598 -790 3539 -790Q3470 -790 3405 -766Q3341 -742 3310 -708L3282 -742Q3340 -796 3387 -832Q3434 -868 3477 -889Q3520 -911 3562 -920Q3604 -929 3652 -929Q3736 -929 3788 -895Q3840 -861 3864 -802Q3887 -743 3887 -668ZM4447 -629V-76L4598 -34V0H4144V-34L4289 -76V-620Q4289 -677 4266 -715Q4243 -752 4200 -771Q4158 -790 4099 -790Q4030 -790 3965 -766Q3901 -742 3870 -708L3842 -742Q3900 -796 3947 -832Q3994 -868 4037 -889Q4080 -911 4122 -920Q4164 -929 4212 -929Q4337 -929 4392 -853Q4447 -777 4447 -629ZM5235 -584 5250 -523Q5124 -491 5045 -459Q4966 -427 4922 -395Q4879 -362 4862 -326Q4846 -289 4846 -246Q4846 -172 4889 -133Q4933 -95 4996 -95Q5046 -95 5087 -118Q5127 -142 5151 -182Q5175 -223 5175 -274V-667Q5175 -749 5133 -795Q5092 -842 5001 -842Q4964 -842 4922 -833Q4879 -824 4845 -807L4897 -851Q4894 -820 4888 -788Q4882 -756 4874 -731Q4866 -705 4854 -692Q4839 -675 4814 -667Q4790 -659 4764 -659Q4732 -659 4713 -673Q4693 -688 4693 -713Q4693 -747 4727 -784Q4761 -821 4815 -853Q4870 -884 4936 -904Q5002 -923 5067 -923Q5163 -923 5221 -895Q5280 -866 5307 -812Q5333 -758 5333 -681V-179Q5333 -147 5343 -127Q5352 -106 5370 -96Q5388 -86 5414 -86Q5440 -86 5469 -96Q5498 -106 5527 -124V-84Q5475 -25 5425 -3Q5376 19 5330 19Q5278 19 5244 -4Q5210 -28 5193 -71Q5176 -115 5175 -175L5180 -182Q5166 -123 5129 -77Q5093 -32 5042 -6Q4991 20 4932 20Q4824 20 4753 -39Q4682 -99 4682 -211Q4682 -270 4704 -317Q4727 -365 4786 -407Q4846 -450 4955 -492Q5064 -535 5235 -584Z';

/** Height of a capital T, serifs included. */
const WORDMARK_CAP = 1440;

const mark = (size: number, x: number, y: number, p: Palette): string => {
  const k = size / 96;
  return (
    `<g transform="translate(${x} ${y}) scale(${k})">` +
    `<path d="${WEFT_PATH}" fill="${p.weft}"/><path d="${WARP_PATH}" fill="${p.warp}"/></g>`
  );
};

const word = (fontSize: number, x: number, baseline: number, p: Palette): string =>
  `<path transform="translate(${x} ${baseline}) scale(${fontSize / 2000})" d="${WORDMARK_PATH}" fill="${p.text}"/>`;

/** The SVG source of a logo, exactly as it is copied and downloaded. */
export function logoSvg(kind: LogoKind, variant: LogoVariant): string {
  const p = PALETTES[variant];
  const info = LOGOS.find((l) => l.kind === kind)!;
  const { width, height } = info;
  let body: string;
  switch (kind) {
    case 'symbol':
      body = mark(96, 0, 0, p);
      break;
    case 'horizontal':
      body = mark(44, 0, 0, p) + word(40, 58, 22 + (1340 / 2000) * 20, p);
      break;
    case 'stacked':
      body = mark(60, (width - 60) / 2, 0, p) + word(32, 0, 72 + (WORDMARK_CAP / 2000) * 32, p);
      break;
    case 'wordmark':
      body = word(52, 0, (WORDMARK_CAP / 2000) * 52, p);
      break;
  }
  const name = `Trama ${info.name.toLowerCase()}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-label="${name}">${body}</svg>`
  );
}

/** A `data:` URL for `<img src>`, so previews show the exact file that gets exported. */
export function logoDataUrl(kind: LogoKind, variant: LogoVariant): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(logoSvg(kind, variant))}`;
}
