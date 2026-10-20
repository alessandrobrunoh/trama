import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TramaStore, UiStore, Viewport, type Issue } from '../../core';
import { Kanban, KanbanItemDirective, KanbanLabelDirective } from '../../shared/kanban';
import { IssueActions } from './issue-actions';
import { IssueCard, IssueRow } from './issue-items';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IssueCard, IssueRow, Kanban, KanbanItemDirective, KanbanLabelDirective],
  template: `
    <span>{{ checkBoard() }}</span>
    <app-kanban [columns]="columns" [layout]="layout">
      <ng-template kanbanLabel let-key>{{ key }}</ng-template>
      <ng-template kanbanItem let-issue>
        @if (layout === 'board') {
          <app-issue-card [issue]="issue" />
        } @else {
          <app-issue-row [issue]="issue" />
        }
      </ng-template>
    </app-kanban>
  `,
})
class TestBoard {
  checks = 0;
  layout: 'board' | 'list' = 'board';
  readonly columns = [
    {
      key: 'todo',
      items: Array.from({ length: 300 }, (_, index): Issue => ({
        id: String(index),
        workspaceId: 'workspace',
        key: `ISS-${index}`,
        number: index,
        kind: 'bug',
        title: `Issue ${index}`,
        source: 'manual',
        priority: 'none',
        status: 'todo',
        milestoneIds: [],
        labels: [],
        aliases: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      })),
    },
  ];

  checkBoard(): string {
    this.checks++;
    return '';
  }
}

describe('Issue item focus', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TestBoard],
      providers: [
        { provide: TramaStore, useValue: {} },
        { provide: Viewport, useValue: {} },
        { provide: IssueActions, useValue: {} },
      ],
    });
    // Isolate focus handling from property pickers, routing, and workspace data.
    for (const component of [IssueCard, IssueRow]) {
      TestBed.overrideComponent(component, {
        set: {
          imports: [],
          template: `<span [class.focused]="focused()">{{ issue().title }}</span>`,
        },
      });
    }
  });

  it.each(['board', 'list'] as const)(
    'updates hover and keyboard focus without reevaluating a large %s',
    async (layout) => {
      const fixture = TestBed.createComponent(TestBoard);
      fixture.componentInstance.layout = layout;
      await fixture.whenStable();
      const ui = TestBed.inject(UiStore);
      const cards = fixture.nativeElement.querySelectorAll(
        'app-issue-card, app-issue-row',
      ) as NodeListOf<HTMLElement>;
      const boardChecks = fixture.componentInstance.checks;

      cards[0].dispatchEvent(new MouseEvent('mouseenter'));
      await fixture.whenStable();
      expect(ui.focusedRowId()).toBe('0');
      expect(cards[0].querySelector('.focused')).not.toBeNull();
      expect(fixture.componentInstance.checks).toBe(boardChecks);

      ui.setFocusedRow('1');
      await fixture.whenStable();
      expect(cards[0].querySelector('.focused')).toBeNull();
      expect(cards[1].querySelector('.focused')).not.toBeNull();
      expect(fixture.componentInstance.checks).toBe(boardChecks);
    },
  );

  it.each(['board', 'list'] as const)(
    'does not change the action target while dragging across a %s',
    async (layout) => {
      const fixture = TestBed.createComponent(TestBoard);
      fixture.componentInstance.layout = layout;
      await fixture.whenStable();
      const ui = TestBed.inject(UiStore);
      ui.setFocusedRow('0');
      await fixture.whenStable();
      const cards = fixture.nativeElement.querySelectorAll(
        'app-issue-card, app-issue-row',
      ) as NodeListOf<HTMLElement>;
      const boardChecks = fixture.componentInstance.checks;

      cards[1].dispatchEvent(new MouseEvent('mouseenter', { buttons: 1 }));
      await fixture.whenStable();
      expect(ui.focusedRowId()).toBe('0');
      expect(fixture.componentInstance.checks).toBe(boardChecks);

      cards[1].dispatchEvent(new MouseEvent('mouseenter'));
      await fixture.whenStable();
      expect(ui.focusedRowId()).toBe('1');
    },
  );

  it('removes the native listener when the item is destroyed', async () => {
    const fixture = TestBed.createComponent(TestBoard);
    await fixture.whenStable();
    const ui = TestBed.inject(UiStore);
    const card = fixture.nativeElement.querySelector('app-issue-card') as HTMLElement;
    fixture.destroy();
    ui.setFocusedRow(null);

    card.dispatchEvent(new MouseEvent('mouseenter'));
    expect(ui.focusedRowId()).toBeNull();
  });
});
