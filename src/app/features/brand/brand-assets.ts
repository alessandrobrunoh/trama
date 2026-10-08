import { Injectable, inject } from '@angular/core';
import { Notifier } from '../../core/notify/notifier';
import { createZip, type ZipEntry } from './zip';

export type LogoKind = 'symbol' | 'horizontal' | 'stacked' | 'wordmark';
export type LogoVariant = 'black' | 'white';

export interface LogoAsset {
  kind: LogoKind;
  name: string;
  description: string;
  width: number;
  height: number;
}

/** The logo files in `public/icons/trama-<kind>-<variant>.svg`. */
export const LOGOS: readonly LogoAsset[] = [
  {
    kind: 'symbol',
    name: 'Logomark',
    description: 'The woven T. Use it for avatars, app icons and anywhere space is tight.',
    width: 512,
    height: 512,
  },
  {
    kind: 'horizontal',
    name: 'Logo',
    description: 'Logomark and wordmark side by side. The default choice for most placements.',
    width: 920,
    height: 228,
  },
  {
    kind: 'stacked',
    name: 'Stacked logo',
    description: 'For square formats such as social cards and event badges.',
    width: 510,
    height: 520,
  },
  {
    kind: 'wordmark',
    name: 'Wordmark',
    description: 'The name on its own, when the logomark already appears nearby.',
    width: 645,
    height: 205,
  },
];

export function logoUrl(kind: LogoKind, variant: LogoVariant): string {
  return `/icons/trama-${kind}-${variant}.svg`;
}

/** Copy / download the brand assets (used by the header logo menu and /brand). */
@Injectable({ providedIn: 'root' })
export class BrandAssets {
  private readonly notifier = inject(Notifier);

  async copySvg(kind: LogoKind, variant: LogoVariant): Promise<void> {
    try {
      const svg = await this.fetchText(logoUrl(kind, variant));
      await navigator.clipboard.writeText(svg);
      this.notifier.success(`${this.label(kind)} SVG copied`, { duration: 2000 });
    } catch {
      this.notifier.error('Could not copy the SVG');
    }
  }

  async copyText(text: string, title: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.notifier.success(title, { description: text, duration: 2000 });
    } catch {
      this.notifier.error('Could not copy to clipboard');
    }
  }

  async downloadSvg(kind: LogoKind, variant: LogoVariant): Promise<void> {
    try {
      const svg = await this.fetchText(logoUrl(kind, variant));
      save(new Blob([svg], { type: 'image/svg+xml' }), `trama-${kind}-${variant}.svg`);
    } catch {
      this.notifier.error('Could not download the SVG');
    }
  }

  async downloadPng(kind: LogoKind, variant: LogoVariant): Promise<void> {
    try {
      save(await this.renderPng(kind, variant), `trama-${kind}-${variant}.png`);
    } catch {
      this.notifier.error('Could not render the PNG');
    }
  }

  /** Every logo in both variants, as SVG and PNG, in one .zip. */
  async downloadAll(): Promise<void> {
    try {
      const entries: ZipEntry[] = [];
      const encoder = new TextEncoder();
      for (const logo of LOGOS) {
        for (const variant of ['black', 'white'] as const) {
          const svg = await this.fetchText(logoUrl(logo.kind, variant));
          entries.push({
            name: `svg/trama-${logo.kind}-${variant}.svg`,
            data: encoder.encode(svg),
          });
          const png = await this.renderPng(logo.kind, variant);
          entries.push({
            name: `png/trama-${logo.kind}-${variant}.png`,
            data: new Uint8Array(await png.arrayBuffer()),
          });
        }
      }
      save(createZip(entries), 'trama-brand-assets.zip');
    } catch {
      this.notifier.error('Could not prepare the brand assets');
    }
  }

  private label(kind: LogoKind): string {
    return LOGOS.find((l) => l.kind === kind)?.name ?? 'Logo';
  }

  private async fetchText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.text();
  }

  /** Rasterises the SVG so its longest side is 2048px, on a transparent background. */
  private async renderPng(kind: LogoKind, variant: LogoVariant): Promise<Blob> {
    const logo = LOGOS.find((l) => l.kind === kind)!;
    const scale = 2048 / Math.max(logo.width, logo.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(logo.width * scale);
    canvas.height = Math.round(logo.height * scale);
    const img = new Image();
    img.src = logoUrl(kind, variant);
    await img.decode();
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
    );
  }
}

function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
