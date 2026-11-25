import { Injectable, inject } from '@angular/core';
import { Notifier } from '../../core/notify/notifier';
import { LOGOS, LOGO_VARIANTS, logoSvg, type LogoKind, type LogoVariant } from './brand-logo';
import { createZip, type ZipEntry } from './zip';

export type { LogoKind, LogoVariant } from './brand-logo';

/** Copy / download the brand assets (used by the header logo menu and /brand). */
@Injectable({ providedIn: 'root' })
export class BrandAssets {
  private readonly notifier = inject(Notifier);

  async copySvg(kind: LogoKind, variant: LogoVariant): Promise<void> {
    try {
      await navigator.clipboard.writeText(logoSvg(kind, variant));
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

  downloadSvg(kind: LogoKind, variant: LogoVariant): void {
    save(new Blob([logoSvg(kind, variant)], { type: 'image/svg+xml' }), `trama-${kind}-${variant}.svg`);
  }

  async downloadPng(kind: LogoKind, variant: LogoVariant): Promise<void> {
    try {
      save(await this.renderPng(kind, variant), `trama-${kind}-${variant}.png`);
    } catch {
      this.notifier.error('Could not render the PNG');
    }
  }

  /** Every logo in every variant, as SVG and PNG, in one .zip. */
  async downloadAll(): Promise<void> {
    try {
      const entries: ZipEntry[] = [];
      const encoder = new TextEncoder();
      for (const logo of LOGOS) {
        for (const { variant } of LOGO_VARIANTS) {
          entries.push({
            name: `svg/trama-${logo.kind}-${variant}.svg`,
            data: encoder.encode(logoSvg(logo.kind, variant)),
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

  /** Rasterises the SVG so its longest side is 2048px, on a transparent background. */
  private async renderPng(kind: LogoKind, variant: LogoVariant): Promise<Blob> {
    const logo = LOGOS.find((l) => l.kind === kind)!;
    const scale = 2048 / Math.max(logo.width, logo.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(logo.width * scale);
    canvas.height = Math.round(logo.height * scale);
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([logoSvg(kind, variant)], { type: 'image/svg+xml' }));
    try {
      await img.decode();
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    } finally {
      URL.revokeObjectURL(img.src);
    }
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
