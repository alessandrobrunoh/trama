import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AppMultiSelect, AppSelect } from './app-select';

const options = [
  { value: '', label: 'No issue' },
  { value: 'one', label: 'Fix layout', hint: 'APP-12' },
  { value: 'two', label: 'Update docs', hint: 'APP-34' },
];

function searchFor(value: string): HTMLInputElement {
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search options"]')!;
  search.value = value;
  search.dispatchEvent(new Event('input', { bubbles: true }));
  return search;
}

function visibleOptions(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]:not([data-hidden])'));
}

describe('Searchable select', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

  it('matches hints and supports clearing via the keyboard', async () => {
    const fixture = TestBed.createComponent(AppSelect);
    fixture.componentRef.setInput('options', options);
    fixture.componentRef.setInput('value', 'two');
    await fixture.whenStable();
    fixture.nativeElement.querySelector('button').click();
    await fixture.whenStable();

    searchFor('app-12');
    await fixture.whenStable();
    expect(visibleOptions().map((option) => option.textContent?.trim())).toEqual([
      expect.stringContaining('Fix layout'),
    ]);
    const search = searchFor('no issue');
    await fixture.whenStable();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('');
  });

  it('toggles multiple choices without closing the picker', async () => {
    const fixture = TestBed.createComponent(AppMultiSelect);
    fixture.componentRef.setInput('options', options.slice(1));
    await fixture.whenStable();
    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    trigger.click();
    await fixture.whenStable();
    visibleOptions()[0].click();
    await fixture.whenStable();
    visibleOptions()[1].click();
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toEqual(['one', 'two']);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    visibleOptions()[0].click();
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toEqual(['two']);
  });
});
